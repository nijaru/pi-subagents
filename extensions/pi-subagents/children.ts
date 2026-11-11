import { randomInt, randomUUID } from "node:crypto";
import { truncateOutput } from "./bounds.ts";
import { MAX_CONCURRENCY, MAX_DIAGNOSTIC_BYTES, MAX_RETAINED_RUNS } from "./limits.ts";
import type { ChildExecution, ChildSupervisor, ChildTask, ExecutionReport, ExecutionSnapshot } from "./execution.ts";
import { addUsage, emptyUsage, type ChildResult, type UsageRecord } from "./types.ts";

export type StartChild = Omit<ChildTask, "id"> & { emit?: (result: ChildResult, progress: string) => void };
interface RetainedChild {
  readonly task: ChildTask;
  readonly handle: string;
  execution: { status: "active"; owner: ChildExecution } | { status: "finished"; report: ExecutionReport };
  collected: boolean;
  joins: number;
}

/** Admission/retention owner. Executions own runtime state; callers get snapshots only. */
export class SessionChildren {
  private readonly children = new Map<string, RetainedChild>();
  private readonly changes = new Set<() => void>();
  private closed = false;
  private pendingUsage?: UsageRecord;
  private nextHandle = randomInt(1, 1_000_000);

  constructor(private readonly supervisor: ChildSupervisor, private readonly available: () => void) {}
  get isClosed(): boolean { return this.closed; }

  private reserved(child: RetainedChild): boolean {
    return child.execution.status === "active" || child.execution.report.cleanup.status === "unconfirmed";
  }

  start(options: StartChild): ChildResult {
    if (this.closed) throw new Error("The parent session is closing; no new children can start.");
    if ([...this.children.values()].filter((child) => this.reserved(child)).length >= MAX_CONCURRENCY) throw new Error(`Too many active or cleanup-unconfirmed children (maximum ${MAX_CONCURRENCY}). Wait for or stop active work; unconfirmed cleanup retains admission.`);
    while (this.children.size >= MAX_RETAINED_RUNS) {
      const oldest = [...this.children.values()].find((child) => !this.reserved(child) && child.collected);
      if (!oldest) throw new Error("Retained child results are unread, running, or cleanup-unconfirmed. Read completed results with wait before starting more children.");
      this.children.delete(oldest.task.id);
    }
    const { emit, ...input } = options;
    const task: ChildTask = Object.freeze({ ...input, id: randomUUID(), tools: Object.freeze([...input.tools]),
      excludeTools: input.excludeTools ? Object.freeze([...input.excludeTools]) : undefined });
    // create is effect-free; reserve before start can spawn, publish, or call extensions.
    const owner = this.supervisor.create(task);
    const child: RetainedChild = { task, handle: `sa-${this.nextHandle++}`, execution: { status: "active", owner }, collected: false, joins: 0 };
    this.children.set(task.id, child);
    void owner.done.then((report) => {
      child.execution = { status: "finished", report: structuredClone(report) };
      if (!this.closed) {
        this.pendingUsage ??= emptyUsage();
        addUsage(this.pendingUsage, report.usage);
      }
      this.changed();
      this.announce();
    });
    let present = emit;
    owner.start((progress) => {
      if (this.closed || !present || progress === undefined) return;
      try { present(this.project(child), progress); } catch { present = undefined; }
    });
    return this.project(child);
  }

  private changed(): void { for (const change of this.changes) change(); }
  private announce(): void { if (!this.closed) { try { this.available(); } catch { /* Reports remain retrievable. */ } } }

  private lookup(id: string): RetainedChild {
    const child = this.children.get(id) ?? [...this.children.values()].find((child) => child.handle === id);
    if (!child) throw new Error(`Unknown child: ${id}. Handles are session-scoped; oldest completed, collected handles may be evicted after ${MAX_RETAINED_RUNS}.`);
    return child;
  }

  private project(child: RetainedChild): ChildResult {
    const execution: ExecutionSnapshot = child.execution.status === "active" ? child.execution.owner.snapshot() : { status: "finished", report: child.execution.report };
    const { task, handle } = child;
    const identity = { id: task.id, handle, prompt: task.prompt, cwd: task.cwd, tools: [...task.tools], model: task.model };
    if (execution.status === "active") return structuredClone({ ...identity, ...execution.facts, phase: execution.phase, state: { status: "running" } });
    const { outcome, stopReason, finishedAt, cleanup, ...facts } = execution.report;
    return structuredClone({ ...identity, ...facts, prompt: truncateOutput(task.prompt, MAX_DIAGNOSTIC_BYTES), cleanup: { ...cleanup },
      cleanupMs: Math.max(0, finishedAt - (facts.taskFinishedAt ?? finishedAt)),
      state: { status: "terminal", outcome, stopReason, finishedAt } });
  }

  has(id: string): boolean { return this.children.has(id); }
  get(id: string): ChildResult { return this.project(this.lookup(id)); }
  list(): ChildResult[] { return [...this.children.values()].map((child) => this.project(child)); }

  unread(): ChildResult[] {
    if (this.closed) return [];
    return [...this.children.values()].filter((child) => child.execution.status === "finished" && !child.collected && child.joins === 0).map((child) => this.project(child));
  }

  takePendingUsage(): UsageRecord | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  pruneCollected(): number {
    let count = 0;
    for (const [id, child] of this.children) {
      if (child.collected && !this.reserved(child)) { this.children.delete(id); count++; }
    }
    return count;
  }

  resumeTarget(handle: string): { sessionFile: string; cwd: string } {
    const child = this.lookup(handle);
    if (child.execution.status === "active") throw new Error(`Child ${child.handle} is still running; use steer or wait before resuming.`);
    if (child.execution.report.cleanup.status === "unconfirmed") throw new Error(`Child ${child.handle} cleanup is unconfirmed; reconcile its process and session ownership before continuing.`);
    if (!child.execution.report.sessionFile) throw new Error(`Child ${child.handle} has no persisted session to resume.`);
    return { sessionFile: child.execution.report.sessionFile, cwd: child.task.cwd };
  }

  async steer(id: string, message: string, signal?: AbortSignal): Promise<ChildResult> {
    const child = this.lookup(id);
    if (child.execution.status !== "active") throw new Error(`Child ${child.handle} is no longer running.`);
    await child.execution.owner.steer(message, signal);
    return this.project(child);
  }

  /** A foreground join owns cancellation; ordinary wait never cancels executions. */
  async join(id: string, timeoutMs: number, signal?: AbortSignal): Promise<ChildResult> {
    const child = this.lookup(id);
    child.joins++;
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      if (child.execution.status === "active") child.execution.owner.cancel();
      this.changed();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await this.until(() => cancelled || child.execution.status === "finished", timeoutMs);
      // Cancellation owns cleanup, even when the foreground budget expires.
      if (cancelled) await this.until(() => child.execution.status === "finished");
      if (child.execution.status === "finished") child.collected = true;
      return this.project(child);
    } finally {
      signal?.removeEventListener("abort", abort);
      child.joins--;
      this.announce();
    }
  }

  async stop(id: string): Promise<ChildResult> {
    const child = this.lookup(id);
    child.joins++;
    try {
      if (child.execution.status === "active") child.execution.owner.cancel();
      await this.until(() => child.execution.status === "finished");
      child.collected = true;
      return this.project(child);
    } finally { child.joins--; this.announce(); }
  }

  async wait(ids: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<ChildResult[]> {
    if (!ids.length) throw new Error("wait requires at least one child id.");
    const selected = [...new Set(ids.map((id) => this.lookup(id)))];
    for (const child of selected) child.joins++;
    try {
      await this.until(() => selected.some((child) => child.execution.status === "finished"), timeoutMs, signal);
      if (signal?.aborted) throw new Error("Wait cancelled; use stop to cancel children.");
      const results = selected.map((child) => this.project(child));
      for (const child of selected) if (child.execution.status === "finished") child.collected = true;
      return results;
    } finally { for (const child of selected) child.joins--; this.announce(); }
  }

  /** One removable subscription per join, not one promise reaction per child. */
  private until(ready: () => boolean, timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (timer) clearTimeout(timer);
        this.changes.delete(check);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const check = () => { if (ready()) finish(); };
      const abort = () => finish(new Error("Wait cancelled; use stop to cancel children."));
      if (signal?.aborted) { abort(); return; }
      if (ready()) { finish(); return; }
      this.changes.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(), timeoutMs);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pendingUsage = undefined;
    const active = [...this.children.values()].flatMap((child) => child.execution.status === "active" ? [child.execution.owner] : []);
    for (const owner of active) owner.cancel();
    await Promise.all(active.map((owner) => owner.done));
    this.children.clear();
  }
}
