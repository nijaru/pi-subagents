import type { Message, ModelThinkingLevel, StopReason, Usage } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export type AgentOutcome = "completed" | "incomplete" | "failed" | "cancelled" | "timed_out";

/**
 * One discriminated lifecycle state. Everything that differs between a live
 * child and a finished one lives here, so no call site has to infer liveness
 * from a sentinel exit code or repair mismatched fields.
 */
export type ChildState =
  | { status: "running" }
  | {
      status: "terminal";
      outcome: AgentOutcome;
      exitCode: number;
      stopReason?: StopReason;
      finishedAt: number;
    };

export interface UsageSummary extends Usage {
  turns: number;
}

export interface OutputTruncation {
  truncated: boolean;
  originalBytes: number;
  /** UTF-8 bytes retained, including the truncation marker when present. */
  retainedBytes: number;
}

export interface ChildResult {
  id: string;
  prompt: string;
  cwd: string;
  tools: string[];
  /** Final assistant text, kept separately from bounded diagnostics. */
  output?: string;
  outputTruncation?: OutputTruncation;
  /** Child stdout is diagnostic only; protocol travels on a private pipe. */
  stdout?: string;
  /** Wall-clock launch time for user-visible runtime reporting. */
  startedAt?: number;
  state: ChildState;
  errorMessage?: string;
  stderr: string;
  usage: UsageSummary;
  model?: string;
  /** Effective Pi thinking level, reported only after child startup verification. */
  thinking?: ModelThinkingLevel;
}

export function isRunning(result: ChildResult): boolean {
  return result.state.status === "running";
}

export function failed(result: ChildResult): boolean {
  return result.state.status === "terminal" && result.state.outcome !== "completed";
}

export function outcomeOf(result: ChildResult): AgentOutcome | undefined {
  return result.state.status === "terminal" ? result.state.outcome : undefined;
}

export interface SubagentDetails {
  command: "run" | "spawn" | "status" | "wait" | "stop";
  results: ChildResult[];
  /** A wait budget expired with no selected child complete; not a child timeout. */
  waitExpired?: boolean;
}

export function emptyUsage(): UsageSummary {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 0,
  };
}

export function addUsage(target: Usage, usage: Usage): void {
  target.input += usage.input || 0;
  target.output += usage.output || 0;
  target.cacheRead += usage.cacheRead || 0;
  target.cacheWrite += usage.cacheWrite || 0;
  target.totalTokens += usage.totalTokens || 0;
  target.cost.input += usage.cost?.input || 0;
  target.cost.output += usage.cost?.output || 0;
  target.cost.cacheRead += usage.cost?.cacheRead || 0;
  target.cost.cacheWrite += usage.cost?.cacheWrite || 0;
  target.cost.total += usage.cost?.total || 0;
  if (usage.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h || 0) + usage.cacheWrite1h;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isOutputTruncation(value: unknown): value is OutputTruncation {
  if (!value || typeof value !== "object") return false;
  const data = value as OutputTruncation;
  return typeof data.truncated === "boolean"
    && Number.isSafeInteger(data.originalBytes) && data.originalBytes >= 0
    && Number.isSafeInteger(data.retainedBytes) && data.retainedBytes >= 0
    && data.retainedBytes <= data.originalBytes
    && (data.truncated || data.retainedBytes === data.originalBytes);
}

export function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  const numericKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  if (!numericKeys.every((key) => isFiniteNumber(usage[key]))) return false;
  const cost = usage.cost;
  if (!cost || typeof cost !== "object") return false;
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => isFiniteNumber((cost as Record<string, unknown>)[key]))
    && (usage.cacheWrite1h === undefined || isFiniteNumber(usage.cacheWrite1h));
}

export function isContentPart(value: unknown): value is { type: string; text?: unknown } {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  if (part.type === "text") return typeof part.text === "string";
  if (part.type === "thinking") return typeof part.thinking === "string";
  if (part.type === "image") return typeof part.data === "string" && typeof part.mimeType === "string";
  if (part.type === "toolCall") return typeof part.id === "string" && typeof part.name === "string" && !!part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments);
  return false;
}

export function isStopReason(value: unknown): value is StopReason {
  return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

export function textFromMessage(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => isContentPart(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}
