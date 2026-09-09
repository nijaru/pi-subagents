import type { Message } from "@earendil-works/pi-ai";

import { MAX_DIAGNOSTIC_BYTES, MAX_MESSAGES_PER_AGENT, MAX_MESSAGE_BYTES, MAX_OUTPUT_BYTES, MAX_STDERR_BYTES } from "./limits.ts";
import { textFromMessage } from "./types.ts";
import type { ChildResult, SubagentDetails } from "./types.ts";

/** Return a UTF-8 prefix without splitting a code point. */
export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // A UTF-16 binary-search boundary can land between a surrogate pair even
  // though Buffer.byteLength reports a valid replacement sequence.
  if (low > 0 && low < value.length) {
    const last = value.charCodeAt(low - 1);
    if (last >= 0xd800 && last <= 0xdbff) low--;
  }
  return value.slice(0, low);
}

/**
 * Truncate output by bytes with a stable, bounded marker. This is deliberately
 * head truncation: the beginning of a subagent report contains its useful context.
 */
export function truncateOutput(value: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= maxBytes) return value;
  if (maxBytes <= 0) return "";

  const markerFor = (keptBytes: number) =>
    `\n\n[Output truncated: kept ${keptBytes} of ${totalBytes} bytes.]`;
  const minimalMarker = "[Output truncated]";
  if (Buffer.byteLength(minimalMarker, "utf8") > maxBytes) return utf8Prefix(value, maxBytes);

  let keptBytes = Math.min(totalBytes, maxBytes);
  for (let attempt = 0; attempt < 8; attempt++) {
    const marker = markerFor(keptBytes);
    const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
    const prefix = utf8Prefix(value, budget);
    const nextKept = Buffer.byteLength(prefix, "utf8");
    const finalMarker = markerFor(nextKept);
    if (nextKept === keptBytes && Buffer.byteLength(finalMarker, "utf8") <= maxBytes) return prefix + finalMarker;
    keptBytes = nextKept;
  }
  const marker = markerFor(0);
  if (Buffer.byteLength(marker, "utf8") <= maxBytes) {
    return utf8Prefix(value, maxBytes - Buffer.byteLength(marker, "utf8")) + marker;
  }
  if (Buffer.byteLength(minimalMarker, "utf8") <= maxBytes) return minimalMarker;
  return utf8Prefix(value, maxBytes);
}

export function capStderr(current: string, next: string): string {
  const remaining = MAX_STDERR_BYTES - Buffer.byteLength(current, "utf8");
  return remaining > 0 ? current + utf8Prefix(next, remaining) : current;
}

export function boundedDiagnostic(value: string | undefined, maxBytes = MAX_DIAGNOSTIC_BYTES): string | undefined {
  return value === undefined ? undefined : truncateOutput(value, maxBytes);
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Keep typed pi messages while bounding the data copied into tool details. */
export function boundMessage(message: Message, maxBytes = MAX_MESSAGE_BYTES): Message {
  if (jsonBytes(message) <= maxBytes) return message;
  const copy = JSON.parse(JSON.stringify(message)) as Record<string, any>;
  if (typeof copy.content === "string") {
    copy.content = truncateOutput(copy.content, Math.max(0, maxBytes - 512));
  } else if (Array.isArray(copy.content)) {
    copy.content = copy.content.map((part: Record<string, any>) => {
      if (part.type === "text") return { ...part, text: truncateOutput(typeof part.text === "string" ? part.text : "", Math.max(0, maxBytes - 512)) };
      if (part.type === "thinking") return { ...part, thinking: truncateOutput(typeof part.thinking === "string" ? part.thinking : "", Math.max(0, maxBytes - 512)) };
      if (part.type === "image") return { ...part, data: truncateOutput(typeof part.data === "string" ? part.data : "", Math.max(0, maxBytes - 512)) };
      if (part.type === "toolCall") return { ...part, arguments: {} };
      return part;
    });
  }
  if (typeof copy.errorMessage === "string") copy.errorMessage = boundedDiagnostic(copy.errorMessage, 1024);
  if (jsonBytes(copy) <= maxBytes) return copy as Message;
  // Preserve a valid, small message shape when metadata (for example a large
  // provider field) is itself unexpectedly large.
  if (copy.role === "toolResult") {
    return { ...copy, content: [{ type: "text", text: "[tool result truncated]" }], toolCallId: String(copy.toolCallId ?? ""), toolName: String(copy.toolName ?? "tool"), isError: Boolean(copy.isError) } as Message;
  }
  return { ...copy, content: truncateOutput(textFromMessage(copy as Message), Math.max(0, maxBytes - 512)) } as Message;
}

export function boundMessages(messages: Message[], maxBytes = MAX_OUTPUT_BYTES): Message[] {
  const bounded = messages.slice(-MAX_MESSAGES_PER_AGENT).map((message) => boundMessage(message));
  if (bounded.length === 0 || maxBytes <= 0) return [];

  // JSON.stringify(array) is exactly the sum of its item encodings plus the
  // brackets and commas. Compute the suffix size once instead of repeatedly
  // serializing the whole shrinking array in a shift() loop.
  const itemBytes = bounded.map(jsonBytes);
  let totalBytes = 2 + itemBytes.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, bounded.length - 1);
  let first = 0;
  while (first < bounded.length && totalBytes > maxBytes && bounded.length - first > 1) {
    totalBytes -= itemBytes[first]! + 1;
    first++;
  }
  const result = bounded.slice(first);
  if (result.length === 1 && totalBytes > maxBytes) {
    return [boundMessage(result[0]!, Math.max(512, maxBytes - 32))];
  }
  return result;
}

export function minimalChildResult(result: ChildResult): ChildResult {
  return {
    id: result.id,
    prompt: "",
    cwd: "",
    tools: [],
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    termination: result.termination,
    errorMessage: boundedDiagnostic(result.errorMessage, 512),
    stderr: "",
    messages: [],
    usage: result.usage,
    model: boundedDiagnostic(result.model, 256),
  };
}

export function boundChildResult(result: ChildResult, maxBytes: number): ChildResult {
  let bounded = minimalChildResult(result);
  if (jsonBytes(bounded) >= maxBytes) return bounded;
  const addCandidate = (key: keyof ChildResult, value: unknown): boolean => {
    const next = { ...bounded, [key]: value } as ChildResult;
    if (jsonBytes(next) > maxBytes) return false;
    bounded = next;
    return true;
  };
  // Account for object overhead and JSON escaping rather than dropping a
  // successful report merely because its full text fills the output budget.
  const addText = (key: "output" | "prompt" | "stderr", value: string | undefined, cap: number): void => {
    if (value === undefined) return;
    let low = 0;
    let high = Math.min(cap, Buffer.byteLength(value, "utf8"));
    if (addCandidate(key, truncateOutput(value, high))) return;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (addCandidate(key, truncateOutput(value, middle))) low = middle + 1;
      else high = middle - 1;
    }
  };
  addCandidate("tools", result.tools);
  addCandidate("cwd", result.cwd);
  addText("output", result.output, MAX_OUTPUT_BYTES);
  addText("prompt", result.prompt, MAX_DIAGNOSTIC_BYTES);
  addText("stderr", result.stderr, MAX_DIAGNOSTIC_BYTES);
  // Message histories are the largest and most expensive candidate. Do not
  // build or serialize one when the higher-value fields already fill the
  // result budget, which is common for a completed report.
  if (jsonBytes(bounded) < maxBytes) {
    addCandidate("messages", boundMessages(result.messages, Math.min(MAX_MESSAGE_BYTES * 2, maxBytes)));
  }
  return bounded;
}

export function boundDetails(details: SubagentDetails, maxBytes = MAX_OUTPUT_BYTES): SubagentDetails {
  const minimalResults = details.results.map(minimalChildResult);
  const bounded: SubagentDetails = { ...details, results: minimalResults };
  const baseBytes = jsonBytes(bounded);
  if (baseBytes >= maxBytes || minimalResults.length === 0) return bounded;
  const perResult = Math.max(1, Math.floor((maxBytes - baseBytes) / minimalResults.length));
  bounded.results = details.results.map((result) => boundChildResult(result, jsonBytes(minimalChildResult(result)) + perResult));
  // The allocation above is deterministic. A final minimal fallback keeps
  // the aggregate bounded even if JSON overhead differs across runtimes.
  while (jsonBytes(bounded) > maxBytes && bounded.results.some((result, index) => jsonBytes(result) > jsonBytes(minimalResults[index]!))) {
    const index = bounded.results.findIndex((result, itemIndex) => jsonBytes(result) > jsonBytes(minimalResults[itemIndex]!));
    if (index < 0) break;
    bounded.results[index] = minimalResults[index]!;
  }
  return bounded;
}
