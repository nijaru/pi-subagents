import type { Message, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import type { OutcomeSchema, ChildStateSchema, UsageSchema, OutputTruncationSchema, ChildResultSchema, SubagentDetailsSchema } from "./result-schema.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
export type AgentOutcome = Static<typeof OutcomeSchema>;
export type ChildState = Static<typeof ChildStateSchema>;
export type UsageSummary = Static<typeof UsageSchema>;
export type OutputTruncation = Static<typeof OutputTruncationSchema>;
export type ChildResult = Static<typeof ChildResultSchema>;

export function isRunning(result: ChildResult): boolean {
  return result.state.status === "running";
}

export function failed(result: ChildResult): boolean {
  return result.state.status === "terminal" && result.state.outcome !== "completed";
}

export function outcomeOf(result: ChildResult): AgentOutcome | undefined {
  return result.state.status === "terminal" ? result.state.outcome : undefined;
}

export type SubagentDetails = Static<typeof SubagentDetailsSchema>;

export function copyUsage(usage: UsageSummary): UsageSummary {
  return { ...usage, cost: { ...usage.cost } };
}

/** Snapshots never lend mutable session-owned fields to callers. */
export function copyResult(result: ChildResult): ChildResult {
  return { ...result, tools: [...result.tools], omittedFields: result.omittedFields ? [...result.omittedFields] : undefined, state: { ...result.state },
    outputTruncation: result.outputTruncation ? { ...result.outputTruncation } : undefined,
    usage: copyUsage(result.usage) };
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
  if (usage.reasoning !== undefined) target.reasoning = (target.reasoning || 0) + usage.reasoning;
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
  const nonnegative = (value: unknown) => isFiniteNumber(value) && value >= 0;
  const numericKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  if (!numericKeys.every((key) => nonnegative(usage[key]))) return false;
  const cost = usage.cost;
  if (!cost || typeof cost !== "object") return false;
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => nonnegative((cost as Record<string, unknown>)[key]))
    && ["cacheWrite1h", "reasoning"].every((key) => usage[key] === undefined || nonnegative(usage[key]));
}

export function textFromMessage(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}
