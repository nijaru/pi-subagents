import { MAX_DIAGNOSTIC_BYTES, MAX_OUTPUT_BYTES, MAX_STDERR_BYTES } from "./limits.ts";
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

/** Return a UTF-8 suffix without splitting a code point. */
export function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle), "utf8") <= maxBytes) high = middle;
    else low = middle + 1;
  }
  // A UTF-16 boundary can land between a surrogate pair.
  if (low > 0 && low < value.length) {
    const first = value.charCodeAt(low);
    if (first >= 0xdc00 && first <= 0xdfff) low++;
  }
  return value.slice(low);
}

const HEAD_TAIL_MARKER = "\n…[truncated]…\n";

/**
 * Keep both ends of over-budget text. Unlike report output, streams such as
 * stderr carry their actionable evidence at the end: the final exception and
 * stack trace, not the opening diagnostics.
 */
export function truncateHeadTail(value: string, maxBytes = MAX_STDERR_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(HEAD_TAIL_MARKER, "utf8");
  if (maxBytes <= markerBytes) return utf8Prefix(value, maxBytes);
  const budget = maxBytes - markerBytes;
  const head = utf8Prefix(value, Math.ceil(budget / 2));
  const tail = utf8Suffix(value, budget - Buffer.byteLength(head, "utf8"));
  return head + HEAD_TAIL_MARKER + tail;
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
  return truncateHeadTail(current + next, MAX_STDERR_BYTES);
}

export function boundedDiagnostic(value: string | undefined, maxBytes = MAX_DIAGNOSTIC_BYTES): string | undefined {
  return value === undefined ? undefined : truncateOutput(value, maxBytes);
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncationFor(result: ChildResult, output: string) {
  return result.outputTruncation ? {
    ...result.outputTruncation,
    truncated: result.outputTruncation.truncated || output !== (result.output ?? ""),
    retainedBytes: Buffer.byteLength(output),
  } : undefined;
}

export function minimalChildResult(result: ChildResult): ChildResult {
  return {
    id: result.id,
    prompt: "",
    cwd: "",
    tools: [],
    startedAt: result.startedAt,
    state: { ...result.state },
    errorMessage: boundedDiagnostic(result.errorMessage, 512),
    outputTruncation: truncationFor(result, ""),
    stderr: "",
    stdout: result.stdout === undefined ? undefined : "",
    usage: result.usage,
    model: boundedDiagnostic(result.model, 256),
  };
}

export function boundChildResult(result: ChildResult, maxBytes: number): ChildResult {
  let bounded = minimalChildResult(result);
  if (jsonBytes(bounded) >= maxBytes) return bounded;
  const addCandidate = (key: keyof ChildResult, value: unknown): boolean => {
    const next = { ...bounded, [key]: value } as ChildResult;
    if (key === "output") next.outputTruncation = truncationFor(result, value as string);
    if (jsonBytes(next) > maxBytes) return false;
    bounded = next;
    return true;
  };
  // Account for object overhead and JSON escaping rather than dropping a
  // successful report merely because its full text fills the output budget.
  const addText = (key: "output" | "prompt" | "stderr" | "stdout", value: string | undefined, cap: number, truncate: typeof truncateOutput = truncateOutput): void => {
    if (value === undefined) return;
    let low = 0;
    let high = Math.min(cap, Buffer.byteLength(value, "utf8"));
    if (addCandidate(key, truncate(value, high))) return;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (addCandidate(key, truncate(value, middle))) low = middle + 1;
      else high = middle - 1;
    }
  };
  addCandidate("tools", result.tools);
  addCandidate("cwd", result.cwd);
  addText("output", result.output, MAX_OUTPUT_BYTES);
  addText("prompt", result.prompt, MAX_DIAGNOSTIC_BYTES);
  // Stderr keeps both ends: its actionable evidence is the final exception.
  addText("stderr", result.stderr, MAX_DIAGNOSTIC_BYTES, truncateHeadTail);
  addText("stdout", result.stdout, MAX_DIAGNOSTIC_BYTES, truncateHeadTail);
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
