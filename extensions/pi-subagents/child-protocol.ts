import type { Message, StopReason } from "@earendil-works/pi-ai";
import { boundedDiagnostic, truncateOutput } from "./bounds.ts";
import { MAX_OUTPUT_BYTES, MAX_PROTOCOL_LINE_BYTES } from "./limits.ts";
import { isStopReason, isUsage, textFromMessage, type OutputTruncation, type UsageSummary } from "./types.ts";

export const CHILD_PROTOCOL_VERSION = 1;
export interface ChildBootstrap {
  version: 1;
  prompt: string;
  tools: string[];
  model?: string;
  thinking?: string;
}
export interface ChildReport {
  output: string;
  outputTruncation: OutputTruncation;
  stopReason?: StopReason;
  errorMessage?: string;
}
export type ChildEvent =
  | { version: 1; kind: "ready"; model: string; tools: string[] }
  | { version: 1; kind: "usage"; usage: UsageSummary }
  | { version: 1; kind: "progress"; text: string }
  | { version: 1; kind: "result"; report: ChildReport; usage: UsageSummary }
  | { version: 1; kind: "error"; errorMessage: string };

/** Strip thinking, signatures, tool arguments and provider metadata before serialization. */
export function assistantReport(message: Message): ChildReport {
  const text = message.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "length")
    ? textFromMessage(message) : "";
  const output = truncateOutput(text, MAX_OUTPUT_BYTES);
  return {
    output,
    outputTruncation: { truncated: output !== text, originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(output) },
    stopReason: message.role === "assistant" ? message.stopReason : undefined,
    errorMessage: message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")
      ? boundedDiagnostic(message.errorMessage) : undefined,
  };
}

export function parseChildEvent(line: string): ChildEvent {
  if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) throw new Error("Oversized child protocol frame.");
  const event = JSON.parse(line);
  if (!event || event.version !== CHILD_PROTOCOL_VERSION) throw new Error("Unsupported child protocol version.");
  const usageValid = (usage: unknown): usage is UsageSummary => isUsage(usage)
    && Number.isSafeInteger((usage as UsageSummary).turns) && (usage as UsageSummary).turns >= 0;
  if (event.kind === "ready" && typeof event.model === "string" && event.model.length <= 1024
    && Array.isArray(event.tools) && event.tools.length <= 256
    && event.tools.every((t: unknown) => typeof t === "string" && t.length <= 256)) return event;
  if (event.kind === "progress" && typeof event.text === "string") return event;
  if (event.kind === "error" && typeof event.errorMessage === "string") return event;
  if (event.kind === "usage" && usageValid(event.usage)) return event;
  if (event.kind === "result" && usageValid(event.usage)) {
    const report = event.report;
    const truncation = report?.outputTruncation;
    if (typeof report?.output === "string" && Buffer.byteLength(report.output) <= MAX_OUTPUT_BYTES
      && (report.stopReason === undefined || isStopReason(report.stopReason))
      && (report.errorMessage === undefined || typeof report.errorMessage === "string")
      && typeof truncation?.truncated === "boolean"
      && Number.isSafeInteger(truncation.originalBytes) && truncation.originalBytes >= 0
      && truncation.retainedBytes === Buffer.byteLength(report.output)) return event;
  }
  throw new Error("Malformed child protocol frame.");
}

export function emptyReport(): ChildReport {
  return { output: "", outputTruncation: { truncated: false, originalBytes: 0, retainedBytes: 0 } };
}
