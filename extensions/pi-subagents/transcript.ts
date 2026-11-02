import { truncateOutput, utf8Prefix } from "./bounds.ts";
import { MAX_OUTPUT_BYTES } from "./limits.ts";
import type { ChildResult } from "./types.ts";

/** Bounded visible text only; no thinking, tool arguments, or tool results. */
export class ChildTranscript {
  private history = "";
  private historyBytes = 0;
  private latest = "";
  private latestBytes = 0;
  private current = "";
  private currentBytes = 0;
  private open = false;

  start(): void {
    this.current = "";
    this.currentBytes = 0;
    this.open = true;
  }

  append(delta: string): void {
    this.open = true;
    this.currentBytes += Buffer.byteLength(delta);
    this.current = utf8Prefix(this.current + delta, MAX_OUTPUT_BYTES);
  }

  finish(text: string): void {
    this.open = false;
    this.latestBytes = Buffer.byteLength(text);
    this.latest = utf8Prefix(text, MAX_OUTPUT_BYTES);
    if (!text) return;
    const separator = this.historyBytes ? "\n\n" : "";
    if (this.historyBytes === Buffer.byteLength(this.history)) {
      this.history = utf8Prefix(this.history + separator + text, MAX_OUTPUT_BYTES);
    }
    this.historyBytes += Buffer.byteLength(separator) + this.latestBytes;
  }

  snapshot(includeHistory = false): Pick<ChildResult, "output" | "outputTruncation"> {
    const hasCurrent = this.open && this.currentBytes > 0;
    const separator = this.historyBytes && hasCurrent ? "\n\n" : "";
    const text = includeHistory
      ? this.history + (this.historyBytes === Buffer.byteLength(this.history) ? separator + (hasCurrent ? this.current : "") : "")
      : hasCurrent ? this.current : this.latest;
    const bytes = includeHistory
      ? this.historyBytes + Buffer.byteLength(separator) + (hasCurrent ? this.currentBytes : 0)
      : hasCurrent ? this.currentBytes : this.latestBytes;
    const output = truncateOutput(text, MAX_OUTPUT_BYTES, bytes);
    return {
      output,
      outputTruncation: bytes > Buffer.byteLength(output) ? {
        truncated: true, originalBytes: bytes, retainedBytes: Buffer.byteLength(output),
      } : undefined,
    };
  }
}
