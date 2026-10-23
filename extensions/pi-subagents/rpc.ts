import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { MAX_PROTOCOL_LINE_BYTES, MAX_STDERR_BYTES } from "./limits.ts";
import { truncateHeadTail } from "./bounds.ts";

export type ChildEvent = JsonAgentSessionEvent | RpcExtensionUIRequest
  | { type: "extension_error"; event?: string; error?: string };
type Success<T extends RpcCommand["type"]> = Extract<RpcResponse, { command: T; success: true }>;
interface Pending {
  command: string;
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

/**
 * Bounded transport over an already-owned process. Pi's RpcClient owns its own
 * non-detached process and unbounded stderr, so it cannot supply this boundary.
 */
export class ChildRpc {
  private readonly decoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private closed = false;
  private trailing = "";
  private discarding = false;
  private previewing = true;
  private stderr = "";
  readonly drained: Promise<void>;

  constructor(private readonly child: ChildProcess, private readonly onEvent: (event: ChildEvent) => void, private readonly onFailure: (error: Error) => void) {
    const drained = Promise.withResolvers<void>();
    this.drained = drained.promise;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (!this.closed) this.consume(this.decoder.write(chunk));
    });
    child.stdout!.once("end", () => {
      if (!this.closed) {
        this.consume(this.decoder.end());
        if (this.trailing.trim() && !this.discarding) this.fail(new Error("Child RPC ended with an unterminated record."));
      }
      drained.resolve();
    });
    child.stdout!.once("close", () => drained.resolve());
    child.stdout!.on("error", (error) => { this.fail(error); drained.resolve(); });
    child.stderr!.on("data", (chunk: Buffer) => this.diagnostic(this.stderrDecoder.write(chunk)));
    child.stderr!.once("end", () => this.diagnostic(this.stderrDecoder.end()));
    child.stdin!.on("error", (error) => this.fail(error));
  }

  diagnostic(text: string): void {
    this.stderr = truncateHeadTail(this.stderr + text, MAX_STDERR_BYTES);
  }

  get diagnostics(): string { return this.stderr; }

  request<T extends RpcCommand["type"]>(command: Extract<RpcCommand, { type: T }>, timeoutMs = 30_000, signal?: AbortSignal): Promise<Success<T>> {
    if (signal?.aborted) return Promise.reject(new Error("RPC command cancelled; child continues."));
    const id = `subagent-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.get(id)?.reject(new Error(`Timed out waiting for child RPC ${command.type}.`));
      }, timeoutMs);
      timer.unref?.();
      const abort = () => this.pending.get(id)?.reject(new Error("RPC command cancelled; child continues."));
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); };
      // Register before writing: a fast response must never miss its waiter.
      this.pending.set(id, {
        command: command.type,
        resolve: (response) => { finish(); resolve(response as Success<T>); },
        reject: (error) => { finish(); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.write({ ...command, id }, (error) => {
        if (error) this.pending.get(id)?.reject(error);
      });
    });
  }

  respond(response: RpcExtensionUIResponse): void { this.write(response, (error) => { if (error) this.fail(error); }); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(new Error("Child execution ended."));
    this.pending.clear();
  }

  private write(record: RpcCommand | RpcExtensionUIResponse, done: (error?: Error | null) => void): void {
    if (this.closed || !this.child.stdin?.writable || this.child.stdin.destroyed) {
      done(new Error("Child RPC stdin is not writable."));
      return;
    }
    try {
      // Node queues writes under backpressure. Do not treat write(false) as a
      // failure; the callback covers flushing/errors and the response gates the
      // next sequential command.
      this.child.stdin.write(`${JSON.stringify(record)}\n`, done);
    } catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.onFailure(error);
  }

  private line(line: string): void {
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.type !== "string") {
        throw new Error("Child RPC emitted a non-object or untyped record.");
      }
      if (record.type !== "response") {
        this.onEvent(record as ChildEvent);
        return;
      }
      const request = this.pending.get(record.id);
      if (!request) return;
      if (record.command !== request.command || typeof record.success !== "boolean") {
        throw new Error("Child RPC emitted a malformed command response.");
      }
      if (record.success) request.resolve(record as RpcResponse);
      else request.reject(new Error(typeof record.error === "string" ? record.error : "Child RPC command failed."));
    } catch (error) {
      this.fail(error instanceof SyntaxError ? new Error("Child RPC emitted malformed JSON.") : error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consume(text: string): void {
    let cursor = 0;
    while (cursor < text.length && !this.closed) {
      const newline = text.indexOf("\n", cursor);
      const end = newline < 0 ? text.length : newline;
      const segment = text.slice(cursor, end);
      cursor = newline < 0 ? text.length : newline + 1;
      if (this.discarding) {
        if (newline >= 0) { this.discarding = false; this.previewing = true; }
        continue;
      }
      this.trailing += segment;
      if (this.previewing) {
        const prefix = '{"type":"agent_end"';
        if (this.trailing.length < prefix.length && newline < 0) return;
        if (this.trailing.startsWith(prefix)) {
          // Pi serializes type first. agent_end repeats unused run history;
          // discard it before parsing, including across stream chunks.
          this.trailing = "";
          if (newline < 0) { this.discarding = true; return; }
          this.previewing = true;
          continue;
        }
        this.previewing = false;
      }
      if (Buffer.byteLength(this.trailing) > MAX_PROTOCOL_LINE_BYTES) {
        this.fail(new Error("Child RPC emitted an oversized protocol record."));
        this.trailing = "";
        return;
      }
      if (newline < 0) return;
      this.line(this.trailing);
      this.trailing = "";
      this.previewing = true;
    }
  }
}
