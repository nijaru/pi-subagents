import { randomInt, randomUUID } from "node:crypto";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ChildResult } from "./types.ts";
import { addUsage, copyResult, emptyUsage } from "./types.ts";
import type { ChildSupervisor, ChildTask } from "./supervisor.ts";
import { MAX_CONCURRENCY, MAX_DIAGNOSTIC_BYTES, MAX_RETAINED_RUNS } from "./limits.ts";
import { truncateOutput } from "./bounds.ts";

export interface ChildRun {
  result: ChildResult;
  /** Short session-scoped handle, assigned once and never reused. */
  handle: string;
  /** How a completed result is surfaced to the parent. */
  notify: "inbox" | "turn";
  /** Inbox notifications are emitted at most once per child. */
  inboxNotified: boolean;
  /** Result delivery is independent of process completion and waiter lifetime. */
  delivery: "unread" | "offered" | "published" | "delivered";
  controller: AbortController;
  /** Terminal output is not publishable until process-tree cleanup finishes. */
  settled: boolean;
  promise: Promise<void>;
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
  /** Per-task execution deadline; omitted uses the global child deadline. */
  executionTimeoutMs?: number;
  /** Startup deadline for watchdog/SDK/MCP readiness. */
  startupTimeoutMs?: number;
  /** Inbox (default) or a forced parent turn. */
  notify?: "inbox" | "turn";
  emit?: (result: ChildResult, progress: string) => void;
}

/** Owns one parent's children, admission, retained handles, and shutdown fencing. */
export class SessionChildren {
  private readonly runs = new Map<string, ChildRun>();
  private closed = false;
  private pendingUsage: Usage | undefined;
  // Start at a random point so a resumed session cannot immediately reuse a
  // handle still visible in the restored transcript.
  private nextHandle = randomInt(1, 1_000_000);

  constructor(private readonly supervisor: ChildSupervisor, private readonly available: (result: ChildResult) => void) {}

  get isClosed(): boolean { return this.closed; }

  start(options: StartChild): ChildRun {
    if (this.closed) throw new Error("The parent session is closing; no new children can start.");
    const active = [...this.runs.values()].filter((run) => !run.settled);
    if (active.length >= MAX_CONCURRENCY) throw new Error(`Too many active children (maximum ${MAX_CONCURRENCY}). Wait for or stop a child first.`);
    while (this.runs.size >= MAX_RETAINED_RUNS) {
      const oldest = [...this.runs.values()].find((run) => run.settled && run.delivery === "delivered");
      if (!oldest) throw new Error("Retained child results are unread or still running. Read completed results with wait before starting more children.");
      this.runs.delete(oldest.result.id);
    }
    const handle = `sa-${this.nextHandle++}`;
    const notify = options.notify ?? "inbox";
    const result: ChildResult = {
      id: randomUUID(), handle, prompt: options.prompt, cwd: options.cwd, tools: [...options.tools],
      phase: "starting", notify, model: options.model, state: { status: "running" }, stderr: "", usage: emptyUsage(),
    };
    const completion = Promise.withResolvers<void>();
    const run: ChildRun = {
      result, handle, notify, inboxNotified: false, delivery: "unread", controller: new AbortController(), settled: false,
      promise: completion.promise, waiters: new Set(), activeWaits: 0,
    };
    const task: ChildTask = Object.freeze({
      id: result.id, prompt: options.prompt, cwd: options.cwd, tools: Object.freeze([...options.tools]),
      model: options.model, thinking: options.thinking, strictThinking: options.strictThinking,
      executionTimeoutMs: options.executionTimeoutMs,
      startupTimeoutMs: options.startupTimeoutMs,
    });
    // Register before execution can emit, await, or invoke extension callbacks.
    this.runs.set(result.id, run);
    void this.execute(run, task, options.emit).then(completion.resolve, completion.reject);
    return run;
  }

  private async execute(run: ChildRun, task: ChildTask, emit: StartChild["emit"]): Promise<void> {
    const present = (progress: string) => {
      if (this.closed || !emit) return;
      try { emit(this.snapshot(run), progress); } catch { emit = undefined; }
    };
    try {
      const { outcome, exitCode, stopReason, errorKind, timeoutPhase, ...data } = await this.supervisor.run({
        task, signal: run.controller.signal,
        onUpdate: (data, progress) => {
          run.result = copyResult({ ...run.result, ...data });
          if (progress !== undefined) present(progress);
        },
      });
      run.result = copyResult({
        ...run.result, ...data,
        state: { status: "terminal", outcome, exitCode, stopReason, finishedAt: Date.now() },
        ...(errorKind === undefined ? {} : { errorKind }),
        ...(timeoutPhase === undefined ? {} : { timeoutPhase }),
      });
      delete run.result.phase;
    } catch (error) {
      const cancelled = run.controller.signal.aborted;
      run.result.errorMessage = truncateOutput(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_BYTES);
      run.result.errorKind = cancelled ? "cancelled" : "unknown";
      delete run.result.phase;
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
      .filter((run) => run.notify === "turn" && run.settled && run.delivery === "unread" && run.activeWaits === 0)
      .map((run) => this.snapshot(run));
  }

  /** Terminal inbox results not yet advertised in a tool result. */
  pendingInbox(): ChildResult[] {
    if (this.closed) return [];
    const pending = [...this.runs.values()]
      .filter((run) => run.notify === "inbox" && run.settled && run.delivery === "unread" && run.activeWaits === 0 && !run.inboxNotified);
    for (const run of pending) run.inboxNotified = true;
    return pending.map((run) => this.snapshot(run));
  }

  /** Published notices suppress duplicates but are not yet acknowledged. */
  unreadCompletionCount(): number {
    if (this.closed) return 0;
    return [...this.runs.values()].filter((run) => run.settled && run.delivery !== "delivered" && run.activeWaits === 0).length;
  }

  hasPublishedCompletions(): boolean {
    return [...this.runs.values()].some((run) => run.delivery === "published");
  }

  acknowledgeCompletions(ids: ReadonlySet<string>, protectedKeys: ReadonlySet<string> = new Set()): void {
    for (const id of ids) {
      const run = this.runs.get(id) ?? [...this.runs.values()].find((candidate) => candidate.handle === id);
      if (!run || run.delivery !== "published") continue;
      // A tool call may reference the same child by handle or UUID.
      if (protectedKeys.has(id) || protectedKeys.has(run.handle)) continue;
      run.delivery = "delivered";
    }
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
      run.delivery = committed ? "published" : "unread";
      dropped ||= !committed;
    }
    return dropped;
  }

  /** Pi custom completion messages cannot carry usage; the next tool result does. */
  takePendingUsage(): Usage | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  get(idOrHandle: string): ChildRun {
    const run = this.runs.get(idOrHandle) ?? [...this.runs.values()].find((candidate) => candidate.handle === idOrHandle);
    if (!run) throw new Error(`Unknown child: ${idOrHandle}. Handles are session-scoped; oldest completed handles are evicted after ${MAX_RETAINED_RUNS}.`);
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
    await run.promise;
    return this.snapshot(run);
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
    if (signal?.aborted) throw new Error("Wait cancelled; use stop to cancel children.");
    if (runs.some((run) => run.settled)) return collect();
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
