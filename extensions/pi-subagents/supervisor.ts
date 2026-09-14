import type { ChildResult } from "./types.ts";
import type { AgentOutcome } from "./types.ts";
import type { Message, StopReason } from "@earendil-works/pi-ai";
import { MAX_DIAGNOSTIC_BYTES, MAX_STDERR_BYTES, RUNNING_PROGRESS_TEXT, RUNTIME_UPDATE_INTERVAL_MS } from "./limits.ts";
import { boundedDiagnostic, truncateOutput } from "./bounds.ts";
import { applyMessage, runPiProcess } from "./subprocess.ts";

export interface ChildRunRequest {
  result: ChildResult;
  thinking?: string;
  signal: AbortSignal;
  emit?: (result: ChildResult, progress: string) => void;
}

/** What execution concluded. Liveness and notification stay owned by the session registry. */
export interface ChildExecutionOutcome {
  outcome: AgentOutcome;
  exitCode: number;
  stopReason?: StopReason;
  errorMessage?: string;
}

/** One execution boundary for both run and spawn. No session registry or scheduler here. */
export interface ChildSupervisor {
  /**
   * Fills request.result with derived output, usage, and diagnostics, then
   * returns the outcome. Resolves only after execution and cleanup finish.
   */
  run(request: ChildRunRequest): Promise<ChildExecutionOutcome>;
}

export class SubprocessChildSupervisor implements ChildSupervisor {
  async run({ result, thinking, signal, emit }: ChildRunRequest): Promise<ChildExecutionOutcome> {
    let protocolFailure: string | undefined;
    // Usage and output are counted from authoritative message events. The
    // agent_end snapshot is only a protocol fallback when none arrived.
    let sawMessageEvent = false;
    let messageOutcome: AgentOutcome | undefined;
    let messageStopReason: StopReason | undefined;
    let presentationFailed = false;
    let runtimeTimer: ReturnType<typeof setInterval> | undefined;
    // Progress publishing is best effort. A renderer or TUI callback failure
    // must never change the child's outcome or terminate its work.
    const report = (progress: string) => {
      if (presentationFailed || !emit) return;
      try {
        emit(result, progress);
      } catch {
        presentationFailed = true;
      }
    };
    const note = (message: Message) => {
      const effect = applyMessage(result, message);
      if (effect.outcome) messageOutcome = effect.outcome;
      if (effect.stopReason) messageStopReason = effect.stopReason;
    };
    try {
      if (signal.aborted) throw new Error("Child aborted before launch.");
      result.startedAt = Date.now();
      report(RUNNING_PROGRESS_TEXT);
      runtimeTimer = setInterval(() => report(RUNNING_PROGRESS_TEXT), RUNTIME_UPDATE_INTERVAL_MS);
      const args = ["--mode", "json", "-p", "--no-session"];
      if (result.model) args.push("--model", result.model);
      if (thinking) args.push("--thinking", thinking);
      if (result.tools.length) args.push("--tools", result.tools.join(","));
      else args.push("--no-tools");

      const processResult = await runPiProcess({
        args,
        prompt: result.prompt,
        cwd: result.cwd,
        childRunId: result.id,
        signal,
        onEvent: (event) => {
          if (event.kind === "message" && event.message) {
            sawMessageEvent = true;
            note(event.message);
            report(result.output || "Child is working...");
          } else if (event.kind === "messages" && event.messages && !sawMessageEvent) {
            for (const message of event.messages) note(message);
            report(result.output || "Child finished...");
          } else if (event.kind === "progress") {
            report(event.text || "Child is working...");
          } else if (event.kind === "error") {
            protocolFailure = truncateOutput(event.errorMessage || "Child process reported an error.", MAX_DIAGNOSTIC_BYTES);
            result.errorMessage = protocolFailure;
            report(protocolFailure);
          }
        },
      });

      result.stderr = truncateOutput(processResult.stderr, MAX_STDERR_BYTES);
      const outcome = classify(result, processResult, messageOutcome, messageStopReason, protocolFailure);
      report(result.output || outcome.errorMessage || "(no output)");
      return outcome;
    } catch (error) {
      const cancelled = signal.aborted;
      result.stderr = boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child failed.";
      return {
        outcome: cancelled ? "cancelled" : "failed",
        exitCode: 1,
        stopReason: cancelled ? "aborted" : "error",
        errorMessage: boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child failed.",
      };
    } finally {
      if (runtimeTimer) clearInterval(runtimeTimer);
    }
  }
}

function classify(
  result: ChildResult,
  processResult: { exitCode: number; stopReason?: StopReason; termination: AgentOutcome; errorMessage?: string },
  messageOutcome: AgentOutcome | undefined,
  messageStopReason: StopReason | undefined,
  protocolFailure: string | undefined,
): ChildExecutionOutcome {
  let exitCode = processResult.exitCode;
  let outcome = processResult.termination;
  // A protocol-level failure or abort must not be hidden by a zero exit code.
  if (messageOutcome === "failed" || messageOutcome === "cancelled") outcome = messageOutcome;
  let stopReason = processResult.stopReason ?? messageStopReason ?? (exitCode === 0 ? "stop" : "error");
  let errorMessage = boundedDiagnostic(processResult.errorMessage ?? result.errorMessage);
  if (protocolFailure) {
    exitCode = 1;
    outcome = "failed";
    stopReason = "error";
    errorMessage = protocolFailure;
  } else if (outcome === "completed" && (messageOutcome !== "completed" || !result.output)) {
    exitCode = 1;
    outcome = "failed";
    stopReason = "error";
    errorMessage ??= "Child produced no terminal assistant output; a final response is required.";
  }
  if (stopReason === "error" && !errorMessage) errorMessage = "Child failed.";
  return { outcome, exitCode, stopReason, errorMessage };
}

export function failed(result: ChildResult): boolean {
  return result.state.status === "terminal" && result.state.outcome !== "completed";
}

export function resultText(result: ChildResult): string {
  return failed(result)
    ? result.errorMessage || result.stderr || result.output || "(no output)"
    : result.output || "(no output)";
}

export function copyResult(result: ChildResult): ChildResult {
  return {
    ...result,
    tools: [...result.tools],
    state: { ...result.state },
    usage: { ...result.usage, cost: { ...result.usage.cost } },
  };
}
