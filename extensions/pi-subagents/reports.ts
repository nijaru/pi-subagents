import { truncateOutput } from "./bounds.ts";
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

/** Absolute deadlines remain meaningful when a retained snapshot is read later. */
export function deadlineSummary(result: ChildResult): string {
  const deadline = result.deadline;
  if (!deadline || (!isRunning(result) && !failed(result))) return "";
  return `${deadline.phase} deadline: ${new Date(deadline.expiresAt).toISOString()} · budget ${formatElapsed(deadline.expiresAt - deadline.startedAt)}`;
}

/** Last observed activity stays truthful in old snapshots; successful reports omit it. */
export function lastActivitySummary(result: ChildResult): string {
  if (result.lastActivityAt === undefined || (!isRunning(result) && !failed(result))) return "";
  return `last activity: ${new Date(result.lastActivityAt).toISOString()}`;
}

/** Content-free activity only; absolute time stays truthful in old snapshots. */
export function activitySummary(result: ChildResult): string {
  if (!isRunning(result) && !failed(result)) return "";
  const current = isRunning(result) && result.activity
    ? `activity: ${result.activity}${result.currentTool ? ` (${truncateOutput(result.currentTool, 256)})` : ""}` : "";
  const interruption = result.interruption;
  const observed = interruption ? `at interruption: ${interruption.activity ?? "between activities"}${interruption.activeToolCount
    ? ` · ${interruption.activeToolCount} tool call${interruption.activeToolCount === 1 ? "" : "s"} without observed completion${interruption.currentTool ? ` (including ${truncateOutput(interruption.currentTool, 256)})` : ""}` : ""}` : "";
  const warning = interruption?.activeToolCount ? "Tool effects may already have occurred; reconcile workspace/external state before retrying." : "";
  return [[current, lastActivitySummary(result)].filter(Boolean).join(" · "), observed, warning].filter(Boolean).join("\n");
}

/** Failure causes precede partial output so bounds cannot hide why the child stopped. */
export function resultText(result: ChildResult): string {
  if (!failed(result)) return result.output || "(no output)";
  const cause = result.errorMessage || result.stderr || "Child did not complete.";
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
  const cause = result.errorMessage || result.stderr;
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
  const session = result.sessionFile ? `\nsession: ${result.sessionFile}` : "";
  const handle = result.handle ?? result.id;
  const cleanup = result.cleanup?.status === "unconfirmed"
    ? "Cleanup unconfirmed; admission and any session lease remain reserved. Do not resume or relaunch until process/workspace state is reconciled." : "";
  const observations = [deadlineSummary(result), activitySummary(result), cleanup].filter(Boolean).join("\n");
  const head = `${handle} [${status}]${duration ? ` · ${duration}` : ""}${observations ? `\n${observations}` : ""}${model}${session}`;
  return includePrompt && result.prompt !== undefined ? `${head}\n${truncateOutput(result.prompt, 256)}` : head;
}

/** Formatting consumes one already-budgeted view; it never selects a different excerpt. */
export function childStatuses(results: ChildResult[]): string {
  return results.length ? results.map(childStatus).join("\n\n") : "No retained children.";
}

export function childReports(results: ChildResult[], { includePrompt = true } = {}): string {
  if (!results.length) return "No retained children.";
  return results.map((result) => {
    const head = childSummary(result, includePrompt);
    if (isRunning(result)) return head;
    const truncation = result.outputTruncation?.truncated
      ? `\nChild report truncated: ${result.outputTruncation.retainedBytes}/${result.outputTruncation.originalBytes} UTF-8 bytes retained. Use subagent wait with ids: ["${result.handle ?? result.id}"] for a longer retained report; saved sessions may retain completed messages.`
      : "";
    return `${head}${truncation}\n\n${resultText(result)}`;
  }).join("\n\n---\n\n");
}
