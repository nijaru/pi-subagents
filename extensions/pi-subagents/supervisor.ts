import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { boundedDiagnostic } from "./bounds.ts";
import { childEnvironment } from "./env.ts";
import { RUNNING_PROGRESS_TEXT, processTimeoutMs, startupTimeoutMs } from "./limits.ts";
import { cleanupChild, spawnDeathWatchdog } from "./process-tree.ts";
import { emptyUsage } from "./types.ts";
import { PROBE_CUSTOM_TYPE, PROBE_DEADLINE_ENV, PROBE_TOKEN_ENV, PROBE_TOOLS_ENV, type ProbeReport } from "./probe-protocol.ts";
import { acquireSession, getRpcInvocation } from "./launch.ts";
import { ChildRpc, type ChildEvent } from "./rpc.ts";
import { ChildObservations } from "./observations.ts";
import { prepareChild } from "./startup.ts";
import { copyFacts, copyReport, type ChildExecution, type ChildSupervisor, type ChildTask, type ExecutionEnd, type ExecutionFacts, type ExecutionReport, type ExecutionSnapshot } from "./execution.ts";

/** The OS boundary is explicit so failure/cleanup guarantees can be exercised. */
export interface ProcessRuntime {
  spawn: typeof spawn;
  watchdog: typeof spawnDeathWatchdog;
  cleanup: typeof cleanupChild;
}
const processes: ProcessRuntime = { spawn, watchdog: spawnDeathWatchdog, cleanup: cleanupChild };
type Lifecycle = { phase: "starting" | "submitting" | "running" }
  | { phase: "stopping"; end: ExecutionEnd }
  | { phase: "finished"; report: ExecutionReport };

export class RpcChildSupervisor implements ChildSupervisor {
  constructor(private readonly runtime: ProcessRuntime = processes) {}
  create(task: ChildTask): ChildExecution { return new RpcExecution(task, this.runtime); }
}

/** Sole owner of a child's resources and lifecycle, from startup through cleanup. */
class RpcExecution implements ChildExecution {
  private lifecycle: Lifecycle = { phase: "starting" };
  private readonly completion = Promise.withResolvers<ExecutionReport>();
  readonly done = this.completion.promise;
  private readonly ended = Promise.withResolvers<ExecutionEnd>();
  private readonly readiness = Promise.withResolvers<ProbeReport | undefined>();
  private readonly readyWaiters = new Set<() => void>();
  private readonly observations: ChildObservations;
  private readonly facts: ExecutionFacts;
  private readonly token = randomUUID();
  private readonly startupBudget: number;
  private child?: ChildProcess;
  private rpc?: ChildRpc;
  private watchdog?: ChildProcess;
  private releaseSession?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private onUpdate?: (progress?: string) => void;
  private started = false;
  private lastPublish = 0;

  constructor(private readonly task: ChildTask, private readonly runtime: ProcessRuntime) {
    this.observations = new ChildObservations(task.tools);
    this.startupBudget = task.startupTimeoutMs ?? startupTimeoutMs();
    this.facts = { startedAt: Date.now(), stderr: "", usage: emptyUsage() };
  }

  snapshot(): ExecutionSnapshot {
    if (this.lifecycle.phase === "finished") return { status: "finished", report: copyReport(this.lifecycle.report) };
    return { status: "active", phase: this.lifecycle.phase === "submitting" ? "running" : this.lifecycle.phase,
      facts: copyFacts({ ...this.facts, ...this.observations.snapshot() }) };
  }

  start(onUpdate?: (progress?: string) => void): void {
    if (this.started) throw new Error("Child execution has already started.");
    this.started = true;
    this.onUpdate = onUpdate;
    void this.execute();
  }

  private publish(progress?: string): void {
    if (progress !== undefined) this.lastPublish = Date.now();
    try { this.onUpdate?.(progress); } catch { this.onUpdate = undefined; }
  }

  private wakeReady(): void { for (const ready of this.readyWaiters) ready(); }

  cancel(): void { this.stop({ kind: "cancelled" }); }

  private stop(end: ExecutionEnd): void {
    if (this.lifecycle.phase === "stopping" || this.lifecycle.phase === "finished") return;
    const interrupted = this.lifecycle.phase !== "starting" && end.kind !== "settled";
    this.facts.interruption = this.observations.stop(interrupted);
    this.facts.taskFinishedAt = Date.now();
    this.lifecycle = { phase: "stopping", end };
    if (this.timer) clearTimeout(this.timer);
    this.rpc?.close();
    this.readiness.resolve(undefined);
    this.wakeReady();
    this.publish();
    this.ended.resolve(end);
  }

  private fail(error: unknown): void {
    if (this.lifecycle.phase === "starting" && Date.now() >= this.facts.startedAt + this.startupBudget) {
      this.stop({ kind: "deadline", phase: "startup", budget: this.startupBudget, elapsed: Date.now() - this.facts.startedAt });
    } else this.stop({ kind: "failure", startup: this.lifecycle.phase === "starting", message: boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child RPC failed." });
  }

  private arm(phase: "startup" | "execution", startedAt: number, budget: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.facts.deadline = { phase, startedAt, expiresAt: startedAt + budget };
    this.timer = setTimeout(() => this.stop({ kind: "deadline", phase, budget, elapsed: Date.now() - startedAt }), Math.max(1, startedAt + budget - Date.now()));
    this.timer.unref?.();
  }

  private event(event: ChildEvent): void {
    if (this.lifecycle.phase === "stopping" || this.lifecycle.phase === "finished") return;
    switch (event.type) {
      case "extension_ui_request":
        if (["select", "confirm", "input", "editor"].includes(event.method)) this.rpc!.respond({ type: "extension_ui_response", id: event.id, cancelled: true });
        return;
      case "extension_error":
        this.rpc!.diagnostic(`\nChild extension error (${event.event ?? "unknown"}): ${event.error ?? "unknown"}`);
        return;
      case "entry_appended":
        if (event.entry?.type === "custom" && event.entry.customType === PROBE_CUSTOM_TYPE) {
          const report = event.entry.data as Partial<ProbeReport> | undefined;
          if (report?.token !== this.token || !Array.isArray(report.tools) || !report.tools.every((name) => typeof name === "string")) throw new Error("Child probe returned malformed readiness.");
          this.readiness.resolve(report as ProbeReport);
          return;
        }
        break;
      case "agent_settled": this.stop(event.aborted ? { kind: "cancelled" } : { kind: "settled" }); return;
    }
    const previous = this.observations.activityKey;
    if (!this.observations.accept(event)) return;
    if (Date.now() - this.lastPublish >= 500) this.publish(RUNNING_PROGRESS_TEXT);
    else if (previous !== this.observations.activityKey || event.type === "entry_appended") this.publish();
  }

  async steer(message: string, signal?: AbortSignal): Promise<void> {
    // Removable readiness listeners, not Promise.race reactions on a long-lived promise.
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        this.readyWaiters.delete(check);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => { finish(); reject(new Error("Steering cancelled; child continues.")); };
      const check = () => {
        if (this.lifecycle.phase === "starting" || this.lifecycle.phase === "submitting") return;
        finish(); resolve();
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.readyWaiters.add(check);
      check();
    });
    if (this.lifecycle.phase !== "running" || !this.rpc) throw new Error("Child is no longer running.");
    const response = await this.rpc.request({ type: "steer", message: `Steering instruction:\n\n${message}` }, 30_000, signal);
    if (response.data?.disposition !== "queued") throw new Error("Child handled steering without queuing it.");
  }

  private async initialize(watchdogSetup: Promise<void>): Promise<void> {
    await watchdogSetup;
    if (this.lifecycle.phase !== "starting") return;
    const config = await prepareChild(this.rpc!, this.task, this.readiness.promise, this.facts.startedAt + this.startupBudget);
    if (this.lifecycle.phase !== "starting") return;
    const budget = this.task.executionTimeoutMs ?? processTimeoutMs();
    Object.assign(this.facts, config);
    // Startup protection ends at task submission. Without an opted-in execution
    // limit, neither its timer nor its now-inapplicable deadline may survive.
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.facts.deadline = undefined;
    this.lifecycle = { phase: "submitting" };
    if (budget !== undefined) this.arm("execution", Date.now(), budget);
    // Pi acknowledges after preflight, which can include model-backed compaction
    // and extension hooks. Only the execution policy may cut that work short.
    const response = await this.rpc!.request({ type: "prompt", message: `Task:\n\n${this.task.prompt}` }, null);
    if (response.data?.disposition !== "started") throw new Error("Child did not start the submitted task.");
    if (this.lifecycle.phase !== "submitting") return;
    this.lifecycle = { phase: "running" };
    this.wakeReady();
    this.publish();
  }

  private async execute(): Promise<void> {
    let watchdogSetup = Promise.resolve();
    try {
      if (this.lifecycle.phase !== "stopping") {
        const invocation = getRpcInvocation(this.task);
        this.facts.sessionFile = invocation.sessionFile;
        if (invocation.sessionFile) this.releaseSession = acquireSession(invocation.sessionFile, this.task.id);
        const env = childEnvironment(this.task.id, this.task.cwd);
        env[PROBE_TOKEN_ENV] = this.token;
        env[PROBE_TOOLS_ENV] = JSON.stringify(this.task.tools);
        env[PROBE_DEADLINE_ENV] = String(this.facts.startedAt + this.startupBudget);
        const child = this.child = this.runtime.spawn(invocation.command, invocation.args, { cwd: this.task.cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        this.rpc = new ChildRpc(child, (event) => this.event(event), (error) => this.fail(error));
        child.once("error", (error) => this.fail(new Error(`Child RPC process error: ${error.message}`)));
        child.once("exit", (code, signal) => {
          // Buffered terminal stdout outranks an unexpected-exit diagnosis.
          void this.drain().then(() => this.fail(new Error(`Child RPC exited before completion (code=${code ?? "null"} signal=${signal ?? "null"}).`)));
        });
        this.arm("startup", this.facts.startedAt, this.startupBudget);
        this.publish(RUNNING_PROGRESS_TEXT);
        watchdogSetup = this.runtime.watchdog(child, invocation.command).then((watchdog) => {
          this.watchdog = watchdog;
          if (this.lifecycle.phase === "stopping" || this.lifecycle.phase === "finished") watchdog?.stdin?.end();
          watchdog?.once("exit", () => this.fail(new Error("Child RPC watchdog exited unexpectedly.")));
        }).catch((error) => this.fail(new Error(`Child RPC watchdog failed: ${error instanceof Error ? error.message : error}`)));
        void this.initialize(watchdogSetup).catch((error) => this.fail(error));
      }
      await this.ended.promise;
    } catch (error) { this.fail(error); }
    finally {
      // Every path, including setup exceptions, converges here. Never reject done
      // before the resource disposition and admission ownership are known.
      if (this.timer) clearTimeout(this.timer);
      this.rpc?.close();
      const end = await this.ended.promise;
      let cleanupError: string | undefined;
      if (this.child) {
        try {
          const cleanup = await this.runtime.cleanup(this.child, this.watchdog, end.kind === "settled");
          cleanupError = cleanup.error ?? (cleanup.leaderExited ? undefined : "Child process exit could not be confirmed after cleanup.");
        } catch (error) { cleanupError = `Child process cleanup failed: ${error instanceof Error ? error.message : error}`; }
      }
      await watchdogSetup;
      if (!cleanupError) {
        try { this.releaseSession?.(); } catch (error) { cleanupError = `Session ownership release failed: ${error instanceof Error ? error.message : error}`; }
      }
      const outcome = this.observations.outcome(end);
      const taskOutcome = outcome.outcome;
      if (cleanupError) {
        // Keep an interrupted task's primary cause; a successful task is not a
        // successful execution if its resource lifetime could not be closed.
        if (outcome.outcome === "completed") { outcome.outcome = "failed"; outcome.errorKind = "cleanup"; }
        outcome.errorMessage = [outcome.errorMessage, cleanupError, this.facts.sessionFile ? "Session ownership lock retained; admission remains reserved." : "Admission remains reserved."].filter(Boolean).join("\n");
      }
      const report: ExecutionReport = {
        ...this.facts, ...this.observations.snapshot(outcome.outcome === "completed" ? "reports" : "history"),
        stderr: this.rpc?.diagnostics ?? "", ...outcome, finishedAt: Date.now(),
        cleanup: cleanupError ? { status: "unconfirmed", error: cleanupError, taskOutcome } : { status: "confirmed" },
      };
      this.lifecycle = { phase: "finished", report };
      this.wakeReady();
      this.readyWaiters.clear();
      this.completion.resolve(copyReport(report));
      this.publish();
      this.onUpdate = undefined;
      this.rpc = undefined; this.child = undefined; this.watchdog = undefined; this.releaseSession = undefined;
    }
  }

  private async drain(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.rpc?.drained, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
