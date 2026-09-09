import type { Message, StopReason, Usage } from "@earendil-works/pi-ai";

export type AgentTermination = "completed" | "failed" | "cancelled" | "timed_out";

export interface UsageSummary extends Usage {
  turns: number;
}

export interface ChildResult {
  id: string;
  prompt: string;
  cwd: string;
  tools: string[];
  /** Final assistant text, kept separately from bounded diagnostic messages. */
  output?: string;
  /** Wall-clock timestamps for user-visible runtime reporting. */
  startedAt?: number;
  finishedAt?: number;
  exitCode: number;
  stopReason?: StopReason;
  /** Distinguishes ordinary failure, cancellation, and timeout across the API boundary. */
  termination?: AgentTermination;
  errorMessage?: string;
  stderr: string;
  messages: Message[];
  usage: UsageSummary;
  model?: string;
}

export interface SubagentDetails {
  command: "run" | "spawn" | "status" | "wait" | "stop";
  results: ChildResult[];
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

export function addUsage(target: UsageSummary, usage: Usage): void {
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

export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.role === "toolResult") {
    const content = candidate.content;
    const validContent = Array.isArray(content) && content.every((part) => {
      if (!part || typeof part !== "object") return false;
      const item = part as Record<string, unknown>;
      return (item.type === "text" && typeof item.text === "string")
        || (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string");
    });
    return validContent
      && typeof candidate.toolCallId === "string"
      && typeof candidate.toolName === "string"
      && typeof candidate.isError === "boolean";
  }
  const validContent = typeof candidate.content === "string"
    || (Array.isArray(candidate.content) && candidate.content.every(isContentPart));
  if (!validContent || (candidate.role !== "user" && candidate.role !== "assistant")) return false;
  return candidate.role !== "assistant" || candidate.usage === undefined || isUsage(candidate.usage);
}

export function isStopReason(value: unknown): value is StopReason {
  return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

export function isFinalMessage(value: unknown): value is Message {
  if (!isMessage(value)) return false;
  if (value.role !== "assistant") return true;
  return typeof value.model === "string" && isStopReason(value.stopReason) && isUsage(value.usage);
}

export function textFromMessage(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => isContentPart(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}
