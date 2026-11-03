import type { StopReason } from "@earendil-works/pi-ai";
import { truncateOutput, utf8Prefix } from "./bounds.ts";
import { MAX_OUTPUT_BYTES, MAX_PROTOCOL_LINE_BYTES } from "./limits.ts";
import type { ChildResult } from "./types.ts";

// More text blocks could not fit even an otherwise-empty final RPC message.
const MAX_TEXT_BLOCKS = Math.floor(MAX_PROTOCOL_LINE_BYTES / Buffer.byteLength('{"type":"text","text":""},'));
interface TextBlock { text: string; bytes: number; discarded: boolean; endsInHighSurrogate: boolean; }

function endsInHighSurrogate(text: string): boolean {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
}

/** Bounded visible text only; no thinking, tool arguments, or tool results. */
export class ChildTranscript {
  private history = "";
  private historyBytes = 0;
  private reports = "";
  private reportBytes = 0;
  private latest = "";
  private latestBytes = 0;
  private blocks = new Map<number, TextBlock>();
  private currentBytes = 0;
  private retainedBytes = 0;
  private open = false;

  start(): void {
    this.blocks.clear();
    this.currentBytes = 0;
    this.retainedBytes = 0;
    this.open = true;
  }

  startBlock(index: number): void { this.block(index); }

  append(index: number, delta: string): void {
    const block = this.block(index);
    // Once a prefix was discarded, later deltas cannot fill its missing gap.
    const text = block.discarded ? block.text : block.text + delta;
    const first = delta.charCodeAt(0);
    // A surrogate pair split between deltas uses four bytes, not two lots of three.
    const bytes = Buffer.byteLength(delta) - (block.endsInHighSurrogate && first >= 0xdc00 && first <= 0xdfff ? 2 : 0);
    this.currentBytes += bytes;
    block.bytes += bytes;
    if (delta) block.endsInHighSurrogate = endsInHighSurrogate(delta);
    this.retain(block, text);
  }

  completeBlock(index: number, text: string): void {
    const block = this.block(index);
    this.currentBytes += Buffer.byteLength(text) - block.bytes;
    block.bytes = Buffer.byteLength(text);
    block.discarded = false;
    block.endsInHighSurrogate = endsInHighSurrogate(text);
    this.retain(block, text);
  }

  private block(index: number): TextBlock {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Child RPC emitted a malformed text block index.");
    this.open = true;
    const existing = this.blocks.get(index);
    if (existing) return existing;
    if (this.blocks.size >= MAX_TEXT_BLOCKS) throw new Error("Child RPC emitted too many text blocks.");
    if (this.blocks.size) this.currentBytes++; // Match textFromMessage's block separator.
    const block: TextBlock = { text: "", bytes: 0, discarded: false, endsInHighSurrogate: false };
    this.blocks.set(index, block);
    return block;
  }

  private orderedBlocks(): TextBlock[] {
    return [...this.blocks].sort(([a], [b]) => a - b).map(([, block]) => block);
  }

  private retain(block: TextBlock, text: string): void {
    this.retainedBytes -= Buffer.byteLength(block.text);
    block.text = utf8Prefix(text, MAX_OUTPUT_BYTES);
    block.discarded ||= block.text.length < text.length;
    this.retainedBytes += Buffer.byteLength(block.text);
    if (this.retainedBytes + this.blocks.size - 1 <= MAX_OUTPUT_BYTES) return;
    let remaining = MAX_OUTPUT_BYTES;
    this.retainedBytes = 0;
    for (const [index, part] of this.orderedBlocks().entries()) {
      if (index) remaining = Math.max(0, remaining - 1);
      const prefix = utf8Prefix(part.text, remaining);
      part.discarded ||= prefix.length < part.text.length;
      part.text = prefix;
      const bytes = Buffer.byteLength(part.text);
      this.retainedBytes += bytes;
      remaining = part.discarded ? 0 : remaining - bytes;
    }
  }

  private currentText(): string {
    let text = "";
    for (const [index, block] of this.orderedBlocks().entries()) {
      if (index) text += "\n";
      text += block.text;
      if (Buffer.byteLength(text) >= MAX_OUTPUT_BYTES || block.discarded) break;
    }
    return utf8Prefix(text, MAX_OUTPUT_BYTES);
  }

  finish(text: string, stopReason: StopReason): void {
    this.open = false;
    this.blocks.clear();
    this.currentBytes = 0;
    this.retainedBytes = 0;
    this.latestBytes = Buffer.byteLength(text);
    this.latest = utf8Prefix(text, MAX_OUTPUT_BYTES);
    if (!text) return;
    const separator = this.historyBytes ? "\n\n" : "";
    if (this.historyBytes === Buffer.byteLength(this.history)) {
      this.history = utf8Prefix(this.history + separator + text, MAX_OUTPUT_BYTES);
    }
    this.historyBytes += Buffer.byteLength(separator) + this.latestBytes;
    if (stopReason === "stop") {
      const separator = this.reportBytes ? "\n\n" : "";
      if (this.reportBytes === Buffer.byteLength(this.reports)) {
        this.reports = utf8Prefix(this.reports + separator + text, MAX_OUTPUT_BYTES);
      }
      this.reportBytes += Buffer.byteLength(separator) + this.latestBytes;
    }
  }

  snapshot(mode: "live" | "history" | "reports" = "live"): Pick<ChildResult, "output" | "outputTruncation"> {
    const hasCurrent = this.open && this.currentBytes > 0;
    const current = hasCurrent ? this.currentText() : "";
    const separator = this.historyBytes && hasCurrent ? "\n\n" : "";
    const text = mode === "reports" ? this.reports : mode === "history"
      ? this.history + (this.historyBytes === Buffer.byteLength(this.history) ? separator + current : "")
      : hasCurrent ? current : this.latest;
    const bytes = mode === "reports" ? this.reportBytes : mode === "history"
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
