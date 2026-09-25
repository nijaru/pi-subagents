import { randomUUID } from "node:crypto";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ChildResult } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";
import type { ChildSupervisor } from "./supervisor.ts";
import { copyResult } from "./supervisor.ts";
import { MAX_CONCURRENCY, MAX_DIAGNOSTIC_BYTES, MAX_RETAINED_RUNS } from "./limits.ts";
import { truncateOutput } from "./bounds.ts";

export interface ChildRun {
  result: ChildResult;
  /** Result delivery is independent of process completion and waiter lifetime. */
  delivery: "unread" | "offered" | "delivered";
  controller: AbortController;
  /** Terminal output is not publishable until process-tree cleanup finishes. */
  settled: boolean;
  promise: Promise<ChildResult>;
  /** Removable completion listeners; timed-out waits must not accumulate promise reactions. */
  waiters: Set<() => void>;
  /** In-flight joins. A blocking waiter claims delivery, so it suppresses the notice. */
  activeWaits: number;
}

export interface StartChild {
  prompt: string;
  cwd: string;
  tools: string[];
  model?: string;
  thinking?: ModelThinkingLevel;
  strictThinking?: boolean;
  /** Make the completed result available for automatic delivery unless a join reads it. */
  notify: boolean;
  emit?: (result: ChildResult, progress: string) => void;
}

/** Owns one parent's children, admission, retained handles, and shutdown fencing. */
export class SessionChildren {
  private readonly runs = new Map<string, ChildRun>();
  private closed = false;
  private pendingUsage: Usage | undefined;

  constructor(private readonly supervisor: ChildSupervisor, private readonly available: (result: ChildResult) => void) {}

  start(options: StartChild): ChildRun {
    if (this.closed) throw new Error("The parent session is closing; no new children can start.");
    const active = [...this.runs.values()].filter((run) => !run.settled);
    if (active.length >= MAX_CONCURRENCY) throw new Error(`Too many active children (maximum ${MAX_CONCURRENCY}). Wait for or stop a child first.`);
    while (this.runs.size >= MAX_RETAINED_RUNS) {
      const oldest = [...this.runs.values()].find((run) => run.settled && run.delivery === "delivered");
      if (!oldest) throw new Error("Retained child results are unread or still running. Read completed results with wait before starting more children.");
      this.runs.delete(oldest.result.id);
    }
    const result: ChildResult = {
      id: randomUUID(), prompt: options.prompt, cwd: options.cwd, tools: [...options.tools],
      model: options.model, state: { status: "running" }, stderr: "", usage: emptyUsage(),
    };
    const completion = Promise.withResolvers<ChildResult>();
    const run: ChildRun = {
      result, delivery: options.notify ? "unread" : "delivered", controller: new AbortController(), settled: false,
      promise: completion.promise, waiters: new Set(), activeWaits: 0,
    };
    // Register before execution can emit, await, or invoke extension callbacks.
    this.runs.set(result.id, run);
    void this.execute(run, options).then(completion.resolve, completion.reject);
    return run;
  }

  private async execute(run: ChildRun, options: StartChild): Promise<ChildResult> {
    try {
      const outcome = await this.supervisor.run({
        result: run.result, thinking: options.thinking, strictThinking: options.strictThinking, signal: run.controller.signal,
        emit: options.emit ? (result, progress) => { if (!this.closed) options.emit?.(result, progress); } : undefined,
      });
      if (outcome.errorMessage) run.result.errorMessage = outcome.errorMessage;
      run.result.state = {
        status: "terminal", outcome: outcome.outcome, exitCode: outcome.exitCode,
        stopReason: outcome.stopReason, finishedAt: Date.now(),
      };
    } catch (error) {
      const cancelled = run.controller.signal.aborted;
      run.result.errorMessage = truncateOutput(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_BYTES);
      run.result.state = {
        status: "terminal", outcome: cancelled ? "cancelled" : "failed", exitCode: 1,
        stopReason: cancelled ? "aborted" : "error", finishedAt: Date.now(),
      };
    } finally {
      run.result.prompt = truncateOutput(run.result.prompt, MAX_DIAGNOSTIC_BYTES);
      // Account each execution once, independently of notices, repeated reads,
      // and handle eviction. Closed sessions must never publish pending costs.
      if (!this.closed) {
        this.pendingUsage ??= emptyUsage();
        addUsage(this.pendingUsage, run.result.usage);
      }
      run.settled = true;
      for (const complete of run.waiters) complete();
      run.waiters.clear();
    }
    this.signalAvailable(run);
    return copyResult(run.result);
  }

  private signalAvailable(run: ChildRun): void {
    if (!this.closed && run.settled && run.delivery === "unread" && run.activeWaits === 0) {
      try { this.available(copyResult(run.result)); } catch { /* A later boundary or wait can still deliver it. */ }
    }
  }

  /** Peek without transferring ownership into a host queue. */
  pendingCompletions(): ChildResult[] {
    if (this.closed) return [];
    return [...this.runs.values()]
      .filter((run) => run.settled && run.delivery === "unread" && run.activeWaits === 0)
      .map((run) => this.snapshot(run));
  }

  /** Boundary drafts are provisional until Pi commits them to the transcript. */
  offerCompletions(ids: string[]): void {
    for (const id of ids) {
      const run = this.runs.get(id);
      if (run?.settled && run.delivery === "unread") run.delivery = "offered";
    }
  }

  hasOfferedCompletions(): boolean {
    return [...this.runs.values()].some((run) => run.delivery === "offered");
  }

  /** Return whether another boundary handler removed a proposed delivery. */
  reconcileCompletions(committedIds: Set<string>): boolean {
    let dropped = false;
    for (const run of this.runs.values()) {
      if (run.delivery !== "offered") continue;
      const committed = committedIds.has(run.result.id);
      run.delivery = committed ? "delivered" : "unread";
      dropped ||= !committed;
    }
    return dropped;
  }

  /** Called only when results are supplied to the parent, not merely queued locally. */
  acknowledgeCompletions(ids: string[]): void {
    for (const id of ids) {
      const run = this.runs.get(id);
      if (run?.settled) run.delivery = "delivered";
    }
  }

  /** Pi custom completion messages cannot carry usage; the next tool result does. */
  takePendingUsage(): Usage | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  get(id: string): ChildRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown child id: ${id}. Handles are session-scoped; oldest completed handles are evicted after ${MAX_RETAINED_RUNS}.`);
    return run;
  }

  snapshot(run: ChildRun): ChildResult {
    const result = copyResult(run.result);
    // Terminal output is not publishable until process-tree cleanup finishes.
    if (!run.settled) result.state = { status: "running" };
    return result;
  }

  list(): ChildResult[] {
    return [...this.runs.values()].map((run) => this.snapshot(run));
  }

  async stop(id: string): Promise<ChildResult> {
    const run = this.get(id);
    // stop itself returns the result; do not wake a second parent turn for it.
    run.delivery = "delivered";
    run.controller.abort();
    return run.promise;
  }

  /** Join any selected child under one deadline; acknowledge only returned terminal reports. */
  async wait(ids: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<ChildResult[]> {
    if (!ids.length) throw new Error("wait requires at least one child id.");
    // Resolve the entire selection before claiming reports or registering listeners.
    const runs = [...new Set(ids)].map((id) => this.get(id));
    const collect = () => runs.map((run) => {
      if (run.settled) run.delivery = "delivered";
      return this.snapshot(run);
    });
    if (runs.some((run) => run.settled)) return collect();
    if (signal?.aborted) throw new Error("Wait cancelled; use stop to cancel children.");
    for (const run of runs) run.activeWaits++;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          for (const run of runs) run.waiters.delete(complete);
          if (error) reject(error); else resolve();
        };
        const complete = () => finish();
        const abort = () => finish(new Error("Wait cancelled; use stop to cancel children."));
        const timer = setTimeout(complete, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        for (const run of runs) run.waiters.add(complete);
      });
      return collect();
    } finally {
      for (const run of runs) {
        run.activeWaits--;
        // A cancelled join can race completion without having delivered it.
        this.signalAvailable(run);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pendingUsage = undefined;
    for (const run of this.runs.values()) if (!run.settled) run.controller.abort();
    await Promise.allSettled([...this.runs.values()].map((run) => run.promise));
    this.runs.clear();
  }
}
