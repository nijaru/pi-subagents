import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildResult } from "./types.ts";
import { MAX_DIAGNOSTIC_BYTES, MAX_STDERR_BYTES, RUNNING_PROGRESS_TEXT, RUNTIME_UPDATE_INTERVAL_MS } from "./limits.ts";
import { boundedDiagnostic, truncateOutput } from "./bounds.ts";
import { recordMessage, runPiProcess } from "./subprocess.ts";

export interface ChildRunRequest {
  result: ChildResult;
  thinking?: string;
  signal: AbortSignal;
  emit?: (result: ChildResult, progress: string) => void;
}

/** One execution boundary for both run and spawn. No session registry or scheduler here. */
export interface ChildSupervisor {
  /** Updates request.result in place; resolves only after execution and cleanup finish. */
  run(request: ChildRunRequest): Promise<void>;
  dispose?(): Promise<void>;
}

export class SubprocessChildSupervisor implements ChildSupervisor {
  private readonly pendingPromptCleanup = new Set<string>();

  private async removePromptDirectory(directory: string): Promise<void> {
    await fs.promises.rm(directory, { recursive: true, force: true });
    this.pendingPromptCleanup.delete(directory);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.pendingPromptCleanup].map((directory) => this.removePromptDirectory(directory)));
  }

  async run({ result, thinking, signal, emit }: ChildRunRequest): Promise<void> {
    let updateError: string | undefined;
    let eventFailure: string | undefined;
    let runtimeTimer: ReturnType<typeof setInterval> | undefined;
    let tempDir: string | undefined;
    const report = (progress: string, propagate = true) => {
      if (result.exitCode !== -1 && result.startedAt !== undefined && result.finishedAt === undefined) result.finishedAt = Date.now();
      try {
        emit?.(result, progress);
      } catch (error) {
        updateError = error instanceof Error ? error.message : String(error);
        if (propagate) throw error;
      }
    };
    try {
      if (signal.aborted) throw new Error("Child aborted before launch.");
      if (this.pendingPromptCleanup.size) throw new Error("Private prompt cleanup is pending; reload the parent session to retry before launching more children.");
      result.startedAt = Date.now();
      report(RUNNING_PROGRESS_TEXT);
      runtimeTimer = setInterval(() => {
        try { emit?.(result, RUNNING_PROGRESS_TEXT); } catch { /* Display-only heartbeats are best effort. */ }
      }, RUNTIME_UPDATE_INTERVAL_MS);
      const args = ["--mode", "json", "-p", "--no-session"];
      if (result.model) args.push("--model", result.model);
      if (thinking) args.push("--thinking", thinking);
      if (result.tools.length) args.push("--tools", result.tools.join(","));
      else args.push("--no-tools");
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
      const taskPath = path.join(tempDir, "task.md");
      await fs.promises.writeFile(taskPath, result.prompt, { encoding: "utf8", mode: 0o600 });
      args.push(`@${taskPath}`);

      const processResult = await runPiProcess(args, result.cwd, result.id, signal, (event) => {
        if (event.kind === "message" && event.message) {
          recordMessage(result, event.message);
          if (eventFailure) {
            result.stopReason = "error";
            result.errorMessage = eventFailure;
          }
          report(result.output || "Child is working...");
        } else if (event.kind === "messages" && event.messages && result.messages.length === 0) {
          for (const message of event.messages) recordMessage(result, message);
          report(result.output || "Child finished...");
        } else if (event.kind === "progress") {
          report(event.text || "Child is working...");
        } else if (event.kind === "error") {
          eventFailure = truncateOutput(event.errorMessage || "Child process reported an error.", MAX_DIAGNOSTIC_BYTES);
          result.stopReason = "error";
          result.errorMessage = eventFailure;
          report(eventFailure);
        }
      });

      const messageTermination = result.termination;
      result.exitCode = processResult.exitCode;
      result.termination = processResult.termination;
      // A protocol-level error/abort must not be hidden by a zero exit code.
      if (messageTermination === "failed" || messageTermination === "cancelled") result.termination = messageTermination;
      result.stopReason = processResult.stopReason ?? result.stopReason ?? (processResult.exitCode === 0 ? "stop" : "error");
      result.errorMessage = boundedDiagnostic(processResult.errorMessage ?? result.errorMessage);
      result.stderr = truncateOutput(processResult.stderr, MAX_STDERR_BYTES);
      if (eventFailure || updateError) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.termination = "failed";
        result.errorMessage = truncateOutput(eventFailure ?? `Child update failed: ${updateError}`, MAX_DIAGNOSTIC_BYTES);
      } else if (processResult.termination === "completed" && (result.termination !== "completed" || !result.output)) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.termination = "failed";
        result.errorMessage ??= "Child produced no terminal assistant output; a final response is required.";
      }
      if (result.stopReason === "error" && !result.errorMessage) result.errorMessage = "Child failed.";
      report(result.output || result.errorMessage || "(no output)", false);
      if (updateError && result.exitCode === 0) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.termination = "failed";
        result.errorMessage = truncateOutput(`Child update failed: ${updateError}`, MAX_DIAGNOSTIC_BYTES);
      }
    } catch (error) {
      result.exitCode = 1;
      result.termination = signal.aborted ? "cancelled" : "failed";
      result.stopReason = result.termination === "cancelled" ? "aborted" : "error";
      result.errorMessage = boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child failed.";
      result.stderr = result.errorMessage;
    } finally {
      if (runtimeTimer) clearInterval(runtimeTimer);
      result.finishedAt = Date.now();
      if (tempDir) {
        try { await this.removePromptDirectory(tempDir); }
        catch (error) {
          this.pendingPromptCleanup.add(tempDir);
          result.exitCode = 1;
          result.termination = "failed";
          result.stopReason = "error";
          result.errorMessage = boundedDiagnostic(`Private prompt cleanup failed; session shutdown will retry: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}

export function failed(result: ChildResult): boolean {
  return result.exitCode !== -1 && (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.termination !== "completed");
}

export function resultText(result: ChildResult): string {
  return failed(result)
    ? result.errorMessage || result.stderr || result.output || "(no output)"
    : result.output || "(no output)";
}

export function copyResult(result: ChildResult): ChildResult {
  return { ...result, tools: [...result.tools], messages: [...result.messages], usage: { ...result.usage, cost: { ...result.usage.cost } } };
}
