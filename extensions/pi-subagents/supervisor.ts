import type { AgentOutcome, ChildResult } from "./types.ts";
import type { StopReason } from "@earendil-works/pi-ai";
import { RUNNING_PROGRESS_TEXT, RUNTIME_UPDATE_INTERVAL_MS } from "./limits.ts";
import { boundedDiagnostic } from "./bounds.ts";
import { runPiProcess, type ProcessResult } from "./subprocess.ts";
import type { ChildReport } from "./child-protocol.ts";

export interface ChildRunRequest {
  result: ChildResult;
  thinking?: string;
  signal: AbortSignal;
  emit?: (result: ChildResult, progress: string) => void;
}

/** Execution facts only. The session registry owns lifecycle and notification. */
export interface ChildExecutionOutcome {
  outcome: AgentOutcome;
  exitCode: number;
  stopReason?: StopReason;
  errorMessage?: string;
}
export interface ChildSupervisor {
  /** Fills derived output/usage/diagnostics; resolves only after process-tree cleanup. */
  run(request: ChildRunRequest): Promise<ChildExecutionOutcome>;
}

export class SubprocessChildSupervisor implements ChildSupervisor {
  async run({ result, thinking, signal, emit }: ChildRunRequest): Promise<ChildExecutionOutcome> {
    let ready = false;
    let terminal: ChildReport | undefined;
    let protocolFailure: string | undefined;
    let presentationFailed = false;
    let runtimeTimer: ReturnType<typeof setInterval> | undefined;
    const report = (progress: string) => {
      if (presentationFailed || !emit) return;
      try { emit(result, progress); } catch { presentationFailed = true; }
    };
    try {
      if (signal.aborted) throw new Error("Child aborted before launch.");
      result.startedAt = Date.now();
      report(RUNNING_PROGRESS_TEXT);
      runtimeTimer = setInterval(() => report(RUNNING_PROGRESS_TEXT), RUNTIME_UPDATE_INTERVAL_MS);
      const processResult = await runPiProcess({
        bootstrap: { version: 1, prompt: result.prompt, tools: result.tools, model: result.model, thinking },
        cwd: result.cwd, childRunId: result.id, signal,
        onEvent: (event) => {
          if (terminal || protocolFailure) throw new Error("Child sent a frame after its terminal result.");
          if (event.kind === "error") {
            protocolFailure = boundedDiagnostic(event.errorMessage);
          } else if (event.kind === "ready") {
            if (ready || (result.model && event.model !== result.model)
              || event.tools.length !== result.tools.length || result.tools.some((tool) => !event.tools.includes(tool))) {
              throw new Error("Child bootstrap did not match requested model/tools.");
            }
            ready = true;
            result.model = event.model;
          } else {
            if (!ready) throw new Error("Child sent task events before bootstrap verification.");
            if (event.kind === "usage") result.usage = event.usage;
            if (event.kind === "progress") report(event.text);
            if (event.kind === "result") {
              terminal = event.report;
              result.usage = event.usage;
              result.output = terminal.output;
              result.outputTruncation = terminal.outputTruncation;
              result.errorMessage = terminal.errorMessage;
            }
          }
        },
      });
      result.stderr = processResult.stderr;
      result.stdout = processResult.stdout;
      const outcome = classifyExecution(processResult, terminal, protocolFailure);
      report(result.output || outcome.errorMessage || "(no output)");
      return outcome;
    } catch (error) {
      const cancelled = signal.aborted;
      return { outcome: cancelled ? "cancelled" : "failed", exitCode: 1, stopReason: cancelled ? "aborted" : "error",
        errorMessage: boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child failed." };
    } finally {
      if (runtimeTimer) clearInterval(runtimeTimer);
    }
  }
}

export function classifyExecution(process: ProcessResult, report?: ChildReport, protocolFailure?: string): ChildExecutionOutcome {
  // External termination remains authoritative even if an earlier assistant failed.
  if (process.outcome === "timed_out" || process.outcome === "cancelled") return process;
  if (protocolFailure || process.outcome !== "completed") return {
    outcome: "failed", exitCode: process.exitCode || 1, stopReason: "error",
    errorMessage: boundedDiagnostic(protocolFailure ?? process.errorMessage) ?? "Child failed.",
  };
  if (report?.stopReason === "length") return {
    outcome: "incomplete", exitCode: 0, stopReason: "length", errorMessage: "Child reached the model output limit; response is incomplete.",
  };
  if (report?.stopReason === "stop" && report.output) return { outcome: "completed", exitCode: 0, stopReason: "stop" };
  if (report?.stopReason === "aborted") return { outcome: "cancelled", exitCode: 1, stopReason: "aborted", errorMessage: report.errorMessage ?? "Child aborted." };
  return { outcome: "failed", exitCode: 1, stopReason: "error", errorMessage: boundedDiagnostic(report?.errorMessage)
    ?? "Child produced no terminal assistant output; a final response is required." };
}

export function failed(result: ChildResult): boolean {
  return result.state.status === "terminal" && result.state.outcome !== "completed";
}
export function resultText(result: ChildResult): string {
  if (result.state.status === "terminal" && result.state.outcome === "incomplete") {
    return [result.output, result.errorMessage].filter(Boolean).join("\n\n") || "(incomplete output)";
  }
  return failed(result) ? result.errorMessage || result.stderr || result.stdout || result.output || "(no output)" : result.output || "(no output)";
}
export function copyResult(result: ChildResult): ChildResult {
  return { ...result, tools: [...result.tools], state: { ...result.state },
    outputTruncation: result.outputTruncation ? { ...result.outputTruncation } : undefined,
    usage: { ...result.usage, cost: { ...result.usage.cost } } };
}
