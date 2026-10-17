import type { AgentOutcome, ChildResult } from "./types.ts";
import type { ModelThinkingLevel, StopReason } from "@earendil-works/pi-ai";
import { RUNNING_PROGRESS_TEXT, processTimeoutMs, startupTimeoutMs } from "./limits.ts";
import { boundedDiagnostic } from "./bounds.ts";
import { withCredentialHint } from "./reports.ts";
import { copyUsage, emptyUsage } from "./types.ts";
import { runPiProcess, type ProcessResult } from "./subprocess.ts";
import { CHILD_PROTOCOL_VERSION, type ChildReport } from "./child-protocol.ts";

export interface ChildTask {
  readonly id: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly strictThinking?: boolean;
  /** Per-task execution deadline, starting at ready; omitted falls back to PI_SUBAGENT_TIMEOUT_MS. */
  readonly executionTimeoutMs?: number;
  /** Per-task startup deadline; omitted falls back to PI_SUBAGENT_STARTUP_TIMEOUT_MS. */
  readonly startupTimeoutMs?: number;
}

/** Execution data never includes session identity, lifecycle, or delivery state. */
export type ChildExecutionData = Pick<ChildResult,
  "startedAt" | "phase" | "model" | "thinking" | "usage" | "output" | "outputTruncation" | "stdout" | "stderr" | "errorMessage"
>;

export interface ChildRunRequest {
  readonly task: ChildTask;
  readonly signal: AbortSignal;
  /** Detached snapshots; progress text is optional for metadata-only updates. */
  readonly onUpdate?: (data: ChildExecutionData, progress?: string) => void;
}

/** Execution facts only. The session registry owns lifecycle and notification. */
export interface ChildExecutionOutcome {
  outcome: AgentOutcome;
  exitCode: number;
  stopReason?: StopReason;
  errorMessage?: string;
  errorKind?: "startup" | "provider" | "protocol" | "deadline" | "cancelled" | "unknown";
  timeoutPhase?: "startup" | "execution";
}
export interface ChildExecutionResult extends ChildExecutionData, ChildExecutionOutcome {}

export interface ChildSupervisor {
  /** Owns execution data and resolves only after process-tree cleanup. */
  run(request: ChildRunRequest): Promise<ChildExecutionResult>;
}

export class SubprocessChildSupervisor implements ChildSupervisor {
  async run({ task, signal, onUpdate }: ChildRunRequest): Promise<ChildExecutionResult> {
    const data: ChildExecutionData = { phase: "starting", model: task.model, stderr: "", usage: emptyUsage() };
    const snapshot = (): ChildExecutionData => ({
      ...data, usage: copyUsage(data.usage),
      outputTruncation: data.outputTruncation ? { ...data.outputTruncation } : undefined,
    });
    const publish = (progress?: string) => onUpdate?.(snapshot(), progress);
    let ready = false;
    let terminal: ChildReport | undefined;
    let protocolFailure: string | undefined;
    try {
      if (signal.aborted) throw new Error("Child aborted before launch.");
      data.startedAt = Date.now();
      publish(RUNNING_PROGRESS_TEXT);
      const processResult = await runPiProcess({
        bootstrap: { version: CHILD_PROTOCOL_VERSION, prompt: task.prompt, tools: [...task.tools], model: task.model,
          thinking: task.thinking, strictThinking: task.strictThinking },
        cwd: task.cwd, childRunId: task.id,
        startupTimeoutMs: task.startupTimeoutMs ?? startupTimeoutMs(),
        timeoutMs: task.executionTimeoutMs ?? processTimeoutMs(), signal,
        onEvent: (event) => {
          if (terminal || protocolFailure !== undefined) throw new Error("Child sent a frame after its terminal result.");
          if (event.kind === "error") {
            protocolFailure = boundedDiagnostic(event.errorMessage) || "Child reported an error.";
          } else if (event.kind === "ready") {
            if (ready || (task.model && event.model !== task.model) || (task.strictThinking && event.thinking !== task.thinking)
              || event.tools.length !== task.tools.length || task.tools.some((tool) => !event.tools.includes(tool))) {
              throw new Error("Child bootstrap did not match requested model/thinking/tools.");
            }
            ready = true;
            data.phase = "running";
            data.model = event.model;
            data.thinking = event.thinking;
            publish();
          } else {
            if (!ready) throw new Error("Child sent task events before bootstrap verification.");
            if (event.kind === "usage") {
              data.usage = event.usage;
              publish();
            }
            if (event.kind === "progress") publish(event.text);
            if (event.kind === "output") {
              // Terminal reports overwrite this; otherwise it is the partial
              // output retained by a deadline or cancellation.
              data.output = event.report.output;
              data.outputTruncation = event.report.outputTruncation;
            }
            if (event.kind === "result") {
              terminal = event.report;
              data.usage = event.usage;
              data.output = terminal.output;
              data.outputTruncation = terminal.outputTruncation;
              data.errorMessage = terminal.errorMessage;
              publish();
            }
          }
        },
      });
      data.stderr = processResult.stderr;
      data.stdout = processResult.stdout;
      const outcome = classifyExecution(processResult, terminal, protocolFailure, ready);
      data.errorMessage = outcome.errorMessage;
      publish(data.output || outcome.errorMessage || "(no output)");
      return { ...snapshot(), ...outcome };
    } catch (error) {
      const cancelled = signal.aborted;
      return { ...snapshot(), outcome: cancelled ? "cancelled" : "failed", exitCode: 1, stopReason: cancelled ? "aborted" : "error",
        errorMessage: boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child failed.",
        errorKind: cancelled ? "cancelled" : "unknown" };
    }
  }
}

export function classifyExecution(process: ProcessResult, report?: ChildReport, protocolFailure?: string, ready = true): ChildExecutionOutcome {
  // External termination remains authoritative even if an earlier assistant failed.
  if (process.outcome === "timed_out" || process.outcome === "cancelled") return {
    outcome: process.outcome, exitCode: process.exitCode, stopReason: process.stopReason,
    errorMessage: boundedDiagnostic(process.errorMessage), errorKind: process.outcome === "timed_out" ? "deadline" : "cancelled",
    ...(process.timeoutPhase === undefined ? {} : { timeoutPhase: process.timeoutPhase }),
  };
  if (protocolFailure !== undefined) return {
    outcome: "failed", exitCode: process.exitCode || 1, stopReason: "error",
    errorMessage: withCredentialHint(boundedDiagnostic(protocolFailure) || "Child failed."), errorKind: ready ? "protocol" : "startup",
  };
  if (process.outcome !== "completed") return {
    outcome: "failed", exitCode: process.exitCode || 1, stopReason: "error",
    errorMessage: withCredentialHint(boundedDiagnostic(process.errorMessage) || "Child failed."), errorKind: ready ? "protocol" : "startup",
  };
  if (report?.stopReason === "error") return {
    outcome: "failed", exitCode: 0, stopReason: "error", errorMessage: boundedDiagnostic(report.errorMessage) ?? "Provider error.", errorKind: "provider",
  };
  if (report?.stopReason === "length") return {
    outcome: "incomplete", exitCode: 0, stopReason: "length", errorMessage: "Child reached the model output limit; response is incomplete.", errorKind: "provider",
  };
  if (report?.stopReason === "stop" && report.output) return { outcome: "completed", exitCode: 0, stopReason: "stop" };
  if (report?.stopReason === "aborted") return { outcome: "cancelled", exitCode: 1, stopReason: "aborted", errorMessage: report.errorMessage ?? "Child aborted.", errorKind: "cancelled" };
  return { outcome: "failed", exitCode: 1, stopReason: "error", errorMessage: boundedDiagnostic(report?.errorMessage)
    ?? "Child produced no terminal assistant output; a final response is required.", errorKind: "protocol" };
}
