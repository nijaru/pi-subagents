import { allocateBudget, truncateOutput } from "./bounds.ts";
import { MAX_OUTPUT_BYTES } from "./limits.ts";
import { failed, isFiniteNumber, isRunning, type ChildResult } from "./types.ts";

/** Human units; sub-second values keep millisecond precision. */
export function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)}ms`;
  if (elapsedMs < 10_000) return `${(elapsedMs / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds}s`;
}

export function formatDuration(startedAt?: number, finishedAt?: number): string | undefined {
  if (!isFiniteNumber(startedAt)) return undefined;
  const end = isFiniteNumber(finishedAt) ? finishedAt : Date.now();
  return formatElapsed(Math.max(0, end - startedAt));
}

/**
 * Deadline expiry names elapsed runtime and the applied execution deadline in
 * human units. Environment values, paths, and child diagnostics stay out of it.
 */
export function timeoutSummary(elapsedMs: number, deadlineMs: number, phase: "startup" | "execution" = "execution"): string {
  return `Subagent timed out during ${phase}. Elapsed ${formatElapsed(elapsedMs)}; ${phase} deadline ${formatElapsed(deadlineMs)}.`;
}

const AUTH_HINT = "Hint: Children inherit the parent process environment and load their own Pi credentials/configuration. Parent runtime-only providers and permission state are not copied.";

/** Attach the child-credential hint to every auth-shaped failure. */
export function withCredentialHint(message: string): string {
  return /No API key|No models match pattern|API key.*not found/i.test(message) ? `${message}\n\n${AUTH_HINT}` : message;
}

/** The built-in timeout cause; anything else is a real diagnostic worth showing. */
export function isTimeoutSummary(message: string | undefined): boolean {
  return message !== undefined && message.startsWith("Subagent timed out");
}

export function runtimeLabel(result: ChildResult): string {
  // Terminal timestamps include process-tree cleanup; report task runtime, not
  // the time the parent spent sweeping descendants.
  const finishedAt = result.taskFinishedAt ?? (result.state.status === "terminal"
    ? result.state.finishedAt - (result.cleanupMs ?? 0)
    : undefined);
  const duration = formatDuration(result.startedAt, finishedAt);
  return duration ? `${duration}${isRunning(result) ? " elapsed" : ""}` : "";
}

/** Failure causes precede partial output so bounds cannot hide why the child stopped. */
export function resultText(result: ChildResult): string {
  if (!failed(result)) return result.output || "(no output)";
  const cause = result.errorMessage || result.stderr || result.stdout || "Child did not complete.";
  // A generic wrapper cause must not hide the child's own diagnostic.
  const detail = /no terminal assistant output|did not complete/i.test(cause) && result.stderr.trim()
    ? `${cause}\n\n${truncateOutput(result.stderr, 2_048)}`
    : cause;
  return result.output ? `${detail}\n\nPartial report:\n${result.output}` : detail;
}

/**
 * Status text for one inspected child. Unlike `wait`, status is read-only, so a
 * terminal failure must carry its cause (and a bounded partial report) here.
 */
export function childStatus(result: ChildResult): string {
  const head = childSummary(result, false);
  if (result.state.status !== "terminal" || !failed(result)) return head;
  const cause = result.errorMessage || result.stderr || result.stdout;
  const lines = [head];
  if (cause) lines.push(`cause: ${truncateOutput(cause, 500)}`);
  const preview = result.output?.trim() ?? "";
  if (preview) lines.push(`partial output: ${truncateOutput(preview, 400)}`);
  return lines.join("\n");
}

export function childSummary(result: ChildResult, includePrompt = true): string {
  const status = result.state.status === "running" ? (result.phase ?? "running") : result.state.outcome;
  const duration = runtimeLabel(result);
  const model = result.model ? `\nmodel: ${truncateOutput(result.model, 512)}${result.thinking ? ` · thinking: ${result.thinking}` : ""}` : "";
  const session = result.sessionFile ? `\nsession: ${truncateOutput(result.sessionFile, 1024)}` : "";
  const handle = result.handle ?? result.id;
  const head = `${handle} [${status}]${duration ? ` · ${duration}` : ""}${model}${session}`;
  return includePrompt ? `${head}\n${truncateOutput(result.prompt, 256)}` : head;
}

/** Every selected child keeps its identity/status, even when reports share a tight budget. */
export function childReports(results: ChildResult[], { includePrompt = true, maxReportBytes = MAX_OUTPUT_BYTES } = {}): string {
  if (!results.length) return "No retained children.";
  const separator = "\n\n---\n\n";
  const heads = results.map((result) => {
    const head = childSummary(result, includePrompt);
    return !isRunning(result) && result.outputTruncation?.truncated
      ? `${head}\nChild report truncated: ${result.outputTruncation.retainedBytes}/${result.outputTruncation.originalBytes} UTF-8 bytes retained; discarded text cannot be retrieved.`
      : head;
  });
  const outputs = results.map((result) => isRunning(result) ? "" : resultText(result));
  // Reserve identities, truncation guidance, and the caller's short preamble.
  const overhead = heads.reduce((bytes, head, index) => bytes + Buffer.byteLength(head) + (isRunning(results[index]!) ? 0 : 258), 0);
  const allocations = allocateBudget(outputs.map((output) => Math.min(maxReportBytes, Buffer.byteLength(output))),
    MAX_OUTPUT_BYTES - 512 - Buffer.byteLength(separator) * (results.length - 1) - overhead);
  return results.map((result, index) => {
    const head = heads[index]!;
    if (isRunning(result)) return head;
    const output = outputs[index]!;
    const excerpt = truncateOutput(output, allocations[index]!);
    const guidance = excerpt === output ? "" : results.length > 1 || maxReportBytes < MAX_OUTPUT_BYTES
      ? `\n\nExcerpt truncated; use subagent wait with ids: ["${result.id}"] for a longer retained report.`
      : "\n\nReport shortened to fit this response.";
    return `${head}\n\n${excerpt}${guidance}`;
  }).join(separator);
}
