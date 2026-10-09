import { allocateBudget, truncateOutput } from "./bounds.ts";
import { MAX_OUTPUT_BYTES } from "./limits.ts";
import { failed, isFiniteNumber, isRunning, type ChildResult } from "./types.ts";

export function formatDuration(startedAt?: number, finishedAt?: number): string | undefined {
  if (!isFiniteNumber(startedAt)) return undefined;
  const end = isFiniteNumber(finishedAt) ? finishedAt : Date.now();
  const totalSeconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds}s`;
}

export function runtimeLabel(result: ChildResult): string {
  const duration = formatDuration(result.startedAt, result.state.status === "terminal" ? result.state.finishedAt : undefined);
  return duration ? `${duration}${isRunning(result) ? " elapsed" : ""}` : "";
}

/** Failure causes precede partial output so bounds cannot hide why the child stopped. */
export function resultText(result: ChildResult): string {
  if (!failed(result)) return result.output || "(no output)";
  const cause = result.errorMessage || result.stderr || result.stdout || "Child did not complete.";
  return result.output ? `${cause}\n\nPartial report:\n${result.output}` : cause;
}

export function childSummary(result: ChildResult, includePrompt = true): string {
  const status = result.state.status === "running" ? "running" : result.state.outcome;
  const duration = runtimeLabel(result);
  const model = result.model ? `\nmodel: ${truncateOutput(result.model, 512)}${result.thinking ? ` · thinking: ${result.thinking}` : ""}` : "";
  const head = `${result.id} [${status}]${duration ? ` · ${duration}` : ""}${model}`;
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
