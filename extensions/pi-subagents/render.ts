import { isFiniteNumber } from "./types.ts";
import type { ChildResult, UsageSummary } from "./types.ts";

export function isRenderableUsage(value: unknown): value is UsageSummary {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  const cost = usage.cost;
  return ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "turns"].every((key) => isFiniteNumber(usage[key]))
    && !!cost && typeof cost === "object"
    && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => isFiniteNumber((cost as Record<string, unknown>)[key]));
}

export function isRenderableChildResult(value: unknown): value is ChildResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ChildResult>;
  return typeof result.id === "string"
    && typeof result.prompt === "string"
    && typeof result.cwd === "string"
    && Array.isArray(result.tools) && result.tools.every((tool) => typeof tool === "string")
    && (result.output === undefined || typeof result.output === "string")
    && (result.errorMessage === undefined || typeof result.errorMessage === "string")
    && (result.model === undefined || typeof result.model === "string")
    && (result.startedAt === undefined || isFiniteNumber(result.startedAt))
    && (result.finishedAt === undefined || isFiniteNumber(result.finishedAt))
    && isFiniteNumber(result.exitCode)
    && (result.termination === undefined || result.termination === "completed" || result.termination === "failed" || result.termination === "cancelled" || result.termination === "timed_out")
    && typeof result.stderr === "string"
    && Array.isArray(result.messages)
    && isRenderableUsage(result.usage);
}

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
  const duration = formatDuration(result.startedAt, result.finishedAt);
  if (!duration) return "";
  return `${duration}${result.exitCode === -1 ? " elapsed" : ""}`;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageSummary, model?: string): string {
  const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  if (model) parts.push(stripTerminalControls(model));
  return parts.join(" ");
}

/** Keep untrusted agent text from emitting terminal control sequences in the TUI. */
export function stripTerminalControls(value: string): string {
  return value
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001BP[\s\S]*?(?:\u0007|\u001B\\)/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max - 1);
  // Do not split a surrogate pair; a trailing high surrogate would render as �.
  if (end > 0 && end < value.length) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return `${value.slice(0, end)}…`;
}
