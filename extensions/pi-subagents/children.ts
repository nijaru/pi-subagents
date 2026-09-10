import { randomUUID } from "node:crypto";
import type { ChildResult } from "./types.ts";
import { emptyUsage } from "./types.ts";
import type { ChildSupervisor } from "./supervisor.ts";
import { copyResult } from "./supervisor.ts";
import { MAX_CONCURRENCY, MAX_DIAGNOSTIC_BYTES, MAX_RETAINED_RUNS } from "./limits.ts";
import { truncateOutput } from "./bounds.ts";

export interface ChildRun {
  result: ChildResult;
  notifyOnCompletion: boolean;
  controller: AbortController;
  /** Terminal output is not publishable until process-tree and prompt cleanup finish. */
  settled: boolean;
  promise: Promise<ChildResult>;
  /** Removable completion listeners; timed-out waits must not accumulate promise reactions. */
  waiters: Set<() => void>;
}

export interface StartChild {
  prompt: string;
  cwd: string;
  tools: string[];
  model?: string;
  thinking?: string;
  background: boolean;
  emit?: (result: ChildResult, progress: string) => void;
}

/** Owns one parent's children, admission, retained handles, and shutdown fencing. */
export class SessionChildren {
  private readonly runs = new Map<string, ChildRun>();
  private closed = false;

  constructor(private readonly supervisor: ChildSupervisor, private readonly completed: (result: ChildResult) => void) {}

  start(options: StartChild): ChildRun {
    if (this.closed) throw new Error("The parent session is closing; no new children can start.");
    const active = [...this.runs.values()].filter((run) => !run.settled);
    if (active.length >= MAX_CONCURRENCY) throw new Error(`Too many active children (maximum ${MAX_CONCURRENCY}). Wait for or stop a child first.`);
    while (this.runs.size >= MAX_RETAINED_RUNS) {
      const oldest = [...this.runs.values()].find((run) => run.settled);
      if (!oldest) throw new Error("All retained child handles are active.");
      this.runs.delete(oldest.result.id);
    }
    const result: ChildResult = {
      id: randomUUID(), prompt: options.prompt, cwd: options.cwd, tools: [...options.tools],
      model: options.model, exitCode: -1, stderr: "", messages: [], usage: emptyUsage(),
    };
    const completion = Promise.withResolvers<ChildResult>();
    const run: ChildRun = {
      result, notifyOnCompletion: options.background, controller: new AbortController(), settled: false,
      promise: completion.promise, waiters: new Set(),
    };
    // Register before execution can emit, await, or invoke extension callbacks.
    this.runs.set(result.id, run);
    void this.execute(run, options).then(completion.resolve, completion.reject);
    return run;
  }

  private async execute(run: ChildRun, options: StartChild): Promise<ChildResult> {
    try {
      await this.supervisor.run({
        result: run.result, thinking: options.thinking, signal: run.controller.signal,
        emit: options.emit ? (result, progress) => { if (!this.closed) options.emit?.(result, progress); } : undefined,
      });
    } catch (error) {
      run.result.exitCode = 1;
      run.result.termination = run.controller.signal.aborted ? "cancelled" : "failed";
      run.result.stopReason = run.controller.signal.aborted ? "aborted" : "error";
      run.result.errorMessage = truncateOutput(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_BYTES);
    } finally {
      run.result.finishedAt ??= Date.now();
      run.result.prompt = truncateOutput(run.result.prompt, MAX_DIAGNOSTIC_BYTES);
      run.settled = true;
      for (const complete of run.waiters) complete();
      run.waiters.clear();
    }
    if (run.notifyOnCompletion && !this.closed) {
      try { this.completed(copyResult(run.result)); } catch { /* The retained result remains available through wait/status. */ }
    }
    return copyResult(run.result);
  }

  get(id: string): ChildRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown child id: ${id}. Handles are session-scoped; oldest completed handles are evicted after ${MAX_RETAINED_RUNS}.`);
    return run;
  }

  snapshot(run: ChildRun): ChildResult {
    const result = copyResult(run.result);
    if (!run.settled) {
      result.exitCode = -1;
      result.termination = undefined;
      result.finishedAt = undefined;
    }
    return result;
  }

  list(): ChildResult[] {
    return [...this.runs.values()].map((run) => this.snapshot(run));
  }

  async stop(id: string): Promise<ChildResult> {
    const run = this.get(id);
    // stop itself returns the result; do not wake a second parent turn for it.
    run.notifyOnCompletion = false;
    run.controller.abort();
    return run.promise;
  }

  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<ChildResult> {
    const run = this.get(id);
    if (run.settled) return this.snapshot(run);
    if (signal?.aborted) throw new Error("Wait cancelled; the background child is still owned by the session. Use stop to cancel it.");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        run.waiters.delete(complete);
        if (error) reject(error); else resolve();
      };
      const complete = () => finish();
      const abort = () => finish(new Error("Wait cancelled; use stop to cancel the child."));
      const timer = setTimeout(complete, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      run.waiters.add(complete);
    });
    return this.snapshot(run);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.runs.values()) if (!run.settled) run.controller.abort();
    await Promise.allSettled([...this.runs.values()].map((run) => run.promise));
    await this.supervisor.dispose?.();
    this.runs.clear();
  }
}
