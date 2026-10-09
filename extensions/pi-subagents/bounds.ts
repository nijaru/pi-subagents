import { MAX_DIAGNOSTIC_BYTES, MAX_OUTPUT_BYTES, MAX_STDERR_BYTES } from "./limits.ts";
import { copyUsage, type ChildResult, type SubagentDetails } from "./types.ts";

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

  if (Buffer.byteLength(markerFor(0), "utf8") > maxBytes) return minimalMarker;

  // Prefix bytes plus marker bytes are monotonic, including digit boundaries.
  // Search for a fitting prefix rather than iterating a potentially oscillating
  // marker reservation. Always describe the actual UTF-8 prefix we retain.
  let low = 0;
  let high = Math.floor(maxBytes);
  let prefix = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8Prefix(value, middle);
    const keptBytes = Buffer.byteLength(candidate, "utf8");
    if (keptBytes + Buffer.byteLength(markerFor(keptBytes), "utf8") <= maxBytes) {
      prefix = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return prefix + markerFor(Buffer.byteLength(prefix, "utf8"));
}

export function appendDiagnostic(current: string, next: string): string {
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
  const omittedFields = (["prompt", "cwd", "tools"] as const).filter((key) =>
    result[key].length > 0 || result.omittedFields?.includes(key));
  return {
    id: result.id,
    prompt: "",
    cwd: "",
    tools: [],
    ...(omittedFields.length ? { omittedFields } : {}),
    startedAt: result.startedAt,
    state: { ...result.state },
    outputTruncation: truncationFor(result, ""),
    stderr: "",
    stdout: result.stdout === undefined ? undefined : "",
    usage: copyUsage(result.usage),
  };
}

/** Throw rather than silently exceed a budget too small for the required fields. */
export function boundChildResult(result: ChildResult, maxBytes: number): ChildResult {
  let bounded = minimalChildResult(result);
  if (!Number.isFinite(maxBytes) || jsonBytes(bounded) > maxBytes) {
    throw new RangeError("Child result budget cannot hold its minimal representation");
  }
  const addCandidate = (key: keyof ChildResult, value: unknown): boolean => {
    const next = { ...bounded, [key]: value } as ChildResult;
    if ((key === "prompt" || key === "cwd" || key === "tools") && (value as string | string[]).length > 0) {
      next.omittedFields = next.omittedFields?.filter((field) => field !== key);
      if (!next.omittedFields?.length) delete next.omittedFields;
    }
    if (key === "output") next.outputTruncation = truncationFor(result, value as string);
    if (jsonBytes(next) > maxBytes) return false;
    bounded = next;
    return true;
  };
  // Account for object overhead and JSON escaping rather than dropping a
  // successful report merely because its full text fills the output budget.
  const addText = (key: "output" | "prompt" | "stderr" | "stdout" | "errorMessage" | "model", value: string | undefined, cap: number, truncate: typeof truncateOutput = truncateOutput): void => {
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
  // Optional metadata must pay for JSON escaping just like report text.
  addText("errorMessage", result.errorMessage, 512);
  // Reserve task identity and actionable diagnostics before filling the report.
  addText("prompt", result.prompt, 256);
  addText("stderr", result.stderr, 1024, truncateHeadTail);
  addText("stdout", result.stdout, 512, truncateHeadTail);
  addText("model", result.model, 256);
  if (result.thinking !== undefined) addCandidate("thinking", result.thinking);
  addCandidate("tools", [...result.tools]);
  addCandidate("cwd", result.cwd);
  addText("output", result.output, MAX_OUTPUT_BYTES);
  // Expand context only when the report leaves room.
  addText("prompt", result.prompt, MAX_DIAGNOSTIC_BYTES);
  addText("stderr", result.stderr, MAX_DIAGNOSTIC_BYTES, truncateHeadTail);
  addText("stdout", result.stdout, MAX_DIAGNOSTIC_BYTES, truncateHeadTail);
  return bounded;
}

/** Share a byte budget fairly, redistributing the space small items don't need. */
export function allocateBudget(needs: number[], maxBytes: number): number[] {
  const allocations = needs.map(() => 0);
  const ordered = needs.map((need, index) => ({ need, index })).sort((a, b) => a.need - b.need);
  let remaining = Math.max(0, Math.floor(maxBytes));
  for (const [position, { need, index }] of ordered.entries()) {
    const share = Math.floor(remaining / (ordered.length - position));
    allocations[index] = Math.min(need, share);
    remaining -= allocations[index]!;
  }
  return allocations;
}

export function boundDetails(details: SubagentDetails, maxBytes = MAX_OUTPUT_BYTES): SubagentDetails {
  const minimalResults = details.results.map(minimalChildResult);
  const bounded: SubagentDetails = { ...details, results: minimalResults };
  const baseBytes = jsonBytes(bounded);
  // Never drop identities to satisfy an impossible caller-supplied budget.
  if (!Number.isFinite(maxBytes) || baseBytes > maxBytes) {
    throw new RangeError("Details budget cannot hold all minimal child representations");
  }
  if (baseBytes === maxBytes || minimalResults.length === 0) return bounded;
  const minima = minimalResults.map(jsonBytes);
  const needs = details.results.map((result, index) =>
    Math.max(0, jsonBytes(boundChildResult(result, maxBytes)) - minima[index]!));
  const allocations = allocateBudget(needs, maxBytes - baseBytes);
  bounded.results = details.results.map((result, index) => boundChildResult(result, minima[index]! + allocations[index]!));
  return bounded;
}
