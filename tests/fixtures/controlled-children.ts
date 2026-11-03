import type {
  ChildExecution,
  ChildSupervisor,
  ChildTask,
  ExecutionFacts,
  ExecutionReport,
  ExecutionSnapshot,
} from "../../extensions/pi-subagents/execution.ts";
import { emptyUsage } from "../../extensions/pi-subagents/types.ts";

interface Controls {
  finishOnCancel?: boolean;
  onStart?: (execution: ControlledExecution) => void;
}

/** Only the execution boundary is faked; cleanup completes when finish resolves done. */
export class ControlledExecution implements ChildExecution {
  private readonly completion = Promise.withResolvers<ExecutionReport>();
  readonly done = this.completion.promise;
  readonly facts: ExecutionFacts = { startedAt: 1, stderr: "", usage: emptyUsage() };
  phase: "starting" | "running" | "stopping" = "running";
  snapshotOverride?: ExecutionSnapshot;
  cancelCalls = 0;
  readonly steering: { message: string; signal?: AbortSignal }[] = [];
  steerHandler?: (message: string, signal?: AbortSignal) => Promise<void>;
  private report?: ExecutionReport;
  private update?: (progress?: string) => void;

  constructor(readonly task: ChildTask, private readonly controls: Controls) {}

  start(onUpdate?: (progress?: string) => void): void {
    this.update = onUpdate;
    this.controls.onStart?.(this);
  }

  // Deliberately lend mutable facts: registry callers must still get detached data.
  snapshot(): ExecutionSnapshot {
    return this.snapshotOverride ?? (this.report
      ? { status: "finished", report: this.report }
      : { status: "active", phase: this.phase, facts: this.facts });
  }

  publish(progress?: string): void { this.update?.(progress); }

  finish(patch: Partial<ExecutionReport> = {}): ExecutionReport {
    if (this.report) throw new Error("Fixture execution already finished");
    this.report = {
      ...this.facts,
      activity: undefined,
      currentTool: undefined,
      output: "done",
      outcome: "completed",
      stopReason: "stop",
      taskFinishedAt: 2,
      finishedAt: 3,
      cleanup: { status: "confirmed" },
      ...patch,
    };
    this.completion.resolve(this.report);
    return this.report;
  }

  cancel(): void {
    this.cancelCalls++;
    this.phase = "stopping";
    if (this.controls.finishOnCancel !== false && !this.report) {
      this.finish({ outcome: "cancelled", stopReason: "aborted" });
    }
  }

  async steer(message: string, signal?: AbortSignal): Promise<void> {
    this.steering.push({ message, signal });
    await this.steerHandler?.(message, signal);
  }
}

export function controlledSupervisor(controls: Controls = {}) {
  const executions: ControlledExecution[] = [];
  const supervisor: ChildSupervisor = {
    create(task) {
      const execution = new ControlledExecution(task, controls);
      executions.push(execution);
      return execution;
    },
  };
  return { supervisor, executions };
}
