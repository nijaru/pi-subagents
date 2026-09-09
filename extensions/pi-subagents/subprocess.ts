import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message, StopReason } from "@earendil-works/pi-ai";

import { MAX_MESSAGES_PER_AGENT, MAX_MESSAGE_BYTES, MAX_OUTPUT_BYTES, MAX_PROTOCOL_LINE_BYTES } from "./limits.ts";
import { addUsage, isFinalMessage, textFromMessage } from "./types.ts";
import type { ChildResult, AgentTermination, UsageSummary } from "./types.ts";
import { boundMessage, boundedDiagnostic, capStderr, jsonBytes, truncateOutput } from "./bounds.ts";
import { processTimeoutMs } from "./limits.ts";
import { setTimeout as delay } from "node:timers/promises";
import { childEnvironment } from "./env.ts";

export const activeChildren = new Set<ChildProcess>();

export interface PiInvocation {
  command: string;
  args: string[];
}

export function executable(pathname: string): boolean {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    // Directories carry the execute bit but cannot be spawned; a configured
    // PI_SUBAGENT_BIN pointing at one must fall through to the next resolver.
    return fs.statSync(pathname).isFile();
  } catch {
    return false;
  }
}

export function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    if (executable(candidate)) return fs.realpathSync.native(candidate);
  }
  return undefined;
}

/**
 * Invoke the same pi CLI as the parent process. All returned commands are
 * absolute, avoiding cwd/PATH changes inside a delegated task.
 */
export function getPiInvocation(args: string[]): PiInvocation {
  const configured = process.env.PI_SUBAGENT_BIN ?? process.env.PI_BIN;
  if (configured) {
    const absolute = path.resolve(configured);
    if (executable(absolute)) return { command: fs.realpathSync.native(absolute), args };
  }

  const runtime = path.basename(process.execPath).toLowerCase();
  const genericRuntime = /^(node|bun|deno)(\.exe)?$/.test(runtime);
  const currentScript = process.argv[1] ? path.resolve(process.argv[1]) : undefined;

  if (!genericRuntime && executable(process.execPath)) {
    return { command: fs.realpathSync.native(process.execPath), args };
  }
  if (currentScript && fs.existsSync(currentScript) && /\.(?:mjs|cjs|js|ts)$/.test(currentScript)) {
    return { command: fs.realpathSync.native(process.execPath), args: [currentScript, ...args] };
  }

  const piPath = findOnPath("pi");
  if (piPath) return { command: piPath, args };
  throw new Error("Unable to resolve an absolute pi executable for subagent delegation.");
}

export interface ParsedJsonEvent {
  kind: "message" | "messages" | "progress" | "error";
  message?: Message;
  messages?: Message[];
  text?: string;
  errorMessage?: string;
}

/** Parse one JSON-mode line; malformed/non-event lines are safely ignored. */
export function parseJsonEventLine(line: string): ParsedJsonEvent | undefined {
  if (!line.trim()) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object") return undefined;
  const candidate = event as Record<string, unknown>;
  if (candidate.type === "message_end" && isFinalMessage(candidate.message)) {
    return { kind: "message", message: candidate.message };
  }
  if (candidate.type === "tool_execution_end") {
    const toolName = typeof candidate.toolName === "string" ? candidate.toolName : "tool";
    return { kind: "progress", text: `Finished ${truncateOutput(toolName, 256)}.` };
  }
  if (candidate.type === "agent_end" && Array.isArray(candidate.messages)) {
    const messages = candidate.messages.filter(isFinalMessage);
    return messages.length > 0 ? { kind: "messages", messages } : undefined;
  }
  if (candidate.type === "message_update") {
    // Pi 0.84 emits token-level deltas here. They are useful to a dedicated
    // streaming transcript, but forwarding each one as a parent tool update
    // makes the subagent preview flicker word by word and can recreate the
    // parent-side render/serialization storm this parser is meant to avoid.
    // message_end remains authoritative; tool lifecycle events below provide
    // coarse progress without replaying model tokens into the parent preview.
    return undefined;
  }
  if (candidate.type === "tool_execution_start" || candidate.type === "tool_execution_update") {
    const toolName = typeof candidate.toolName === "string" ? candidate.toolName : "tool";
    return { kind: "progress", text: `Running ${truncateOutput(toolName, 256)}...` };
  }
  if (candidate.type === "error") {
    const errorMessage = typeof candidate.errorMessage === "string"
      ? candidate.errorMessage
      : typeof candidate.message === "string" ? candidate.message : "Subagent process reported an error.";
    return { kind: "error", errorMessage };
  }
  return undefined;
}

export interface ProcessResult {
  exitCode: number;
  stopReason?: StopReason;
  termination: AgentTermination;
  errorMessage?: string;
  stderr: string;
}

export function descendantPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  const snapshot = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 1000 });
  if (snapshot.status !== 0 || typeof snapshot.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of snapshot.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(childPid) || !Number.isSafeInteger(parentPid)) continue;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(childPid);
    children.set(parentPid, siblings);
  }
  const result: number[] = [];
  const visit = (parentPid: number) => {
    for (const childPid of children.get(parentPid) ?? []) {
      visit(childPid);
      result.push(childPid);
    }
  };
  visit(pid);
  return result;
}

/**
 * Terminate a child and its descendants without killing an ancestor group.
 *
 * Keep the first descendant snapshot until the SIGKILL escalation. A process
 * can exit after SIGTERM while its descendants become reparented, so a
 * later `ps` snapshot rooted at the leader would otherwise miss them.
 */
export const terminatedProcessDescendants = new WeakMap<ChildProcess, Set<number>>();

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    const tracked = terminatedProcessDescendants.get(child) ?? new Set<number>();
    for (const pid of descendantPids(child.pid)) tracked.add(pid);
    if (signal === "SIGTERM") terminatedProcessDescendants.set(child, tracked);
    for (const pid of tracked) {
      try {
        process.kill(pid, signal);
      } catch {
        // The process may have exited between the snapshot and the signal.
      }
    }
    if (signal === "SIGKILL") terminatedProcessDescendants.delete(child);
  }
  terminateProcessGroup(child, signal);
}

export function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    if (child.pid) {
      // `ChildProcess.kill()` does not include descendants on Windows.
      const tree = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      tree.on("error", () => {});
      tree.unref();
    }
    return;
  }
  try {
    if (child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to the direct child. The process may have exited already.
  }
  try {
    child.kill(signal);
  } catch {
    // The close event will produce the final result.
  }
}

/** Sweep only the detached root group after its leader exits. */
export async function sweepRootProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const tree = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      tree.once("error", () => resolve());
      tree.once("close", () => resolve());
    });
    await delay(100);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // No surviving group; importantly, do not signal a potentially reused
    // direct-child PID after the leader has already exited.
    return;
  }
  const groupExists = () => {
    try {
      process.kill(-child.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForGroupExit = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (groupExists() && Date.now() < deadline) await delay(25);
  };
  // Preserve the previous graceful-cleanup window before forcing the group.
  await waitForGroupExit(5000);
  if (!groupExists()) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForGroupExit(1000);
}

export function addAssistantUsage(usage: UsageSummary, message: Message): void {
  if (message.role !== "assistant") return;
  usage.turns++;
  if (message.usage) addUsage(usage, message.usage);
}

export function recordMessage(result: ChildResult, message: Message): void {
  const bounded = boundMessage(message);
  // A provider may attach arbitrary metadata outside the typed message fields.
  // Never retain a record that still exceeds the per-message budget; final
  // assistant text and usage are tracked separately below.
  if (jsonBytes(bounded) <= MAX_MESSAGE_BYTES) {
    result.messages.push(bounded);
    if (result.messages.length > MAX_MESSAGES_PER_AGENT) result.messages.shift();
  }
  addAssistantUsage(result.usage, message);
  if (message.role !== "assistant") return;
  const output = textFromMessage(message);
  if (typeof message.model === "string" && message.model) result.model = truncateOutput(message.model, 256);
  if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse" || message.stopReason === "error" || message.stopReason === "aborted") {
    result.stopReason = message.stopReason;
  }
  // Only terminal assistant messages are authoritative output. Text attached
  // to a toolUse turn is progress, not a completed report.
  if (message.stopReason === "stop" || message.stopReason === "length") {
    result.termination = "completed";
    if (output) result.output = truncateOutput(output, MAX_OUTPUT_BYTES);
  } else if (message.stopReason === "aborted") {
    result.termination = "cancelled";
  } else if (message.stopReason === "error") {
    result.termination = "failed";
  }
  if (typeof message.errorMessage === "string" && message.errorMessage) result.errorMessage = boundedDiagnostic(message.errorMessage);
}

export async function runPiProcess(
  args: string[],
  cwd: string,
  childRunId: string,
  signal: AbortSignal | undefined,
  onEvent: (event: ParsedJsonEvent) => void,
): Promise<ProcessResult> {
  if (signal?.aborted) return { exitCode: 1, stopReason: "aborted", termination: "cancelled", errorMessage: "Subagent aborted.", stderr: "" };
  const timeoutMs = processTimeoutMs();

  const invocation = getPiInvocation(args);
  return new Promise((resolve) => {
    let settled = false;
    let finishing = false;
    let rootSweepPromise: Promise<void> | undefined;
    let aborted = false;
    let stderr = "";
    let trailing = "";
    let discardingLine = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let processTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let eventError: string | undefined;
    const decoder = new StringDecoder("utf8");
    let abortHandler: (() => void) | undefined;

    const finish = (result: ProcessResult) => {
      if (settled || finishing) return;
      finishing = true;
      void (async () => {
        // A background run must not release mutation ownership while a
        // descendant from its detached root group can still be alive.
        if (rootSweepPromise) await rootSweepPromise;
        // A leader can close before the escalation timer fires while a
        // descendant ignores SIGTERM and does not hold an inherited pipe open.
        // Force the retained tree snapshot before dropping the timer.
        if (aborted || timedOut || eventError) terminateProcessTree(child, "SIGKILL");
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (processTimer) clearTimeout(processTimer);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        resolve({ ...result, stderr: truncateOutput(stderr) });
      })();
    };

    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: childEnvironment(childRunId, cwd),
        shell: false,
        // A child gets its own process group; cleanup includes the commands it starts.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChildren.add(child);
      let rootGroupSwept = false;
      const sweepRoot = () => {
        if (rootGroupSwept) return;
        rootGroupSwept = true;
        rootSweepPromise = sweepRootProcessGroup(child);
      };
      // `close` waits for stdio streams; a descendant can keep an inherited
      // pipe open after the leader exits. Sweep on `exit` first so that child
      // cannot defer cleanup until the hard timeout.
      child.once("exit", sweepRoot);
      child.once("close", sweepRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({ exitCode: 1, stopReason: "error", termination: "failed", errorMessage: message, stderr });
      return;
    }

    const stopForAbort = () => {
      if (settled) return;
      aborted = true;
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) terminateProcessTree(child, "SIGKILL");
      }, 5000);
    };
    const stopForTimeout = () => {
      if (settled) return;
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) terminateProcessTree(child, "SIGKILL");
      }, 5000);
    };
    processTimer = setTimeout(stopForTimeout, timeoutMs);
    const deliverEvent = (event: ParsedJsonEvent) => {
      if (settled || eventError) return;
      try {
        onEvent(event);
      } catch (error) {
        eventError = error instanceof Error ? error.message : String(error);
        terminateProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) terminateProcessTree(child, "SIGKILL");
        }, 5000);
      }
    };
    abortHandler = stopForAbort;
    if (signal) signal.addEventListener("abort", abortHandler, { once: true });

    const consumeStdoutText = (text: string) => {
      let cursor = 0;
      while (cursor < text.length) {
        if (discardingLine) {
          const newline = text.indexOf("\n", cursor);
          if (newline < 0) return;
          discardingLine = false;
          cursor = newline + 1;
          continue;
        }

        const newline = text.indexOf("\n", cursor);
        if (newline < 0) {
          const segment = text.slice(cursor);
          if (Buffer.byteLength(trailing, "utf8") + Buffer.byteLength(segment, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
            // Drop the rest of an oversized unterminated line, but keep reading
            // until its newline so a later valid event can still complete.
            trailing = "";
            discardingLine = true;
          } else {
            trailing += segment;
          }
          return;
        }

        const segment = text.slice(cursor, newline);
        const lineBytes = Buffer.byteLength(trailing, "utf8") + Buffer.byteLength(segment, "utf8");
        if (lineBytes <= MAX_PROTOCOL_LINE_BYTES) {
          const event = parseJsonEventLine(trailing + segment);
          if (event) deliverEvent(event);
        }
        trailing = "";
        cursor = newline + 1;
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      consumeStdoutText(decoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = capStderr(stderr, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      activeChildren.delete(child);
      const message = error instanceof Error ? error.message : String(error);
      if (eventError) {
        finish({ exitCode: 1, stopReason: "error", termination: "failed", errorMessage: `Subagent event handling failed: ${eventError}`, stderr });
      } else if (timedOut) {
        finish({ exitCode: 1, stopReason: "error", termination: "timed_out", errorMessage: `Subagent timed out after ${timeoutMs} ms.`, stderr });
      } else if (aborted) {
        finish({ exitCode: 1, stopReason: "aborted", termination: "cancelled", errorMessage: "Subagent aborted.", stderr });
      } else {
        finish({ exitCode: 1, stopReason: "error", termination: "failed", errorMessage: message, stderr });
      }
    });
    child.on("close", (code) => {
      activeChildren.delete(child);
      const finalText = decoder.end();
      if (finalText && !discardingLine) consumeStdoutText(finalText);
      if (trailing.trim() && !discardingLine && Buffer.byteLength(trailing, "utf8") <= MAX_PROTOCOL_LINE_BYTES) {
        const event = parseJsonEventLine(trailing);
        if (event) deliverEvent(event);
      }
      if (eventError) {
        finish({ exitCode: 1, stopReason: "error", termination: "failed", errorMessage: `Subagent event handling failed: ${eventError}`, stderr });
        return;
      }
      if (timedOut) {
        finish({ exitCode: 1, stopReason: "error", termination: "timed_out", errorMessage: `Subagent timed out after ${timeoutMs} ms.`, stderr });
        return;
      }
      if (aborted || signal?.aborted) {
        finish({ exitCode: code ?? 1, stopReason: "aborted", termination: "cancelled", errorMessage: "Subagent aborted.", stderr });
        return;
      }
      const exitCode = code ?? 1;
      let errorMessage: string | undefined;
      if (exitCode !== 0) {
        const cleanStderr = stderr.trim();
        if (cleanStderr) {
          errorMessage = `Subagent exited with code ${exitCode}.\n${truncateOutput(cleanStderr, 2048)}`;
          if (/No API key|No models match pattern|API key.*not found/i.test(cleanStderr)) {
            errorMessage += `\n\nHint: Child env passes model refs and *_API_KEY/*_TOKEN credentials automatically. For non-credential variables, set PI_SUBAGENT_PASSTHROUGH_ENV with an exact name or glob and restart Pi. Auth in ~/.pi/agent/auth.json via /login needs no passthrough.`;
          }
        } else {
          errorMessage = `Subagent exited with code ${exitCode}.`;
        }
      }
      finish({ exitCode, stderr, stopReason: exitCode === 0 ? undefined : "error", termination: exitCode === 0 ? "completed" : "failed", errorMessage });
    });

    if (signal?.aborted) stopForAbort();
  });
}
