import { expect, test } from "bun:test";
import { ChildTranscript } from "../extensions/pi-subagents/transcript.ts";
import { MAX_OUTPUT_BYTES } from "../extensions/pi-subagents/limits.ts";

test("successful output is the final report, not earlier narration or streamed duplicates", () => {
  const transcript = new ChildTranscript();
  transcript.finish("Earlier finding");
  transcript.start();
  transcript.append(0, "Final report");
  transcript.finish("Final report");
  expect(transcript.snapshot().output).toBe("Final report");
  expect(transcript.snapshot(true).output).toBe("Earlier finding\n\nFinal report");
});

test("authoritative block text replaces deltas by index without losing other text blocks", () => {
  const transcript = new ChildTranscript();
  transcript.start();
  transcript.startBlock(3);
  transcript.append(3, "stale tail");
  transcript.append(0, "stale head");
  transcript.completeBlock(0, "corrected🙂");
  transcript.completeBlock(3, "tail");
  transcript.completeBlock(5, "");
  expect(transcript.snapshot()).toEqual({ output: "corrected🙂\ntail\n", outputTruncation: undefined });
  transcript.completeBlock(0, "");
  expect(transcript.snapshot().output).toBe("\ntail\n");
  transcript.finish("whole authoritative message");
  expect(transcript.snapshot(true).output).toBe("whole authoritative message");
});

test("Unicode pairs split across deltas do not imply discarded text or inflate byte counts", () => {
  for (const prefix of ["", "界".repeat(MAX_OUTPUT_BYTES)]) {
    const transcript = new ChildTranscript();
    transcript.start();
    for (const delta of [prefix, "\ud83d", "\ude42", "X"]) transcript.append(0, delta);
    const snapshot = transcript.snapshot(true);
    if (!prefix) expect(snapshot).toEqual({ output: "🙂X", outputTruncation: undefined });
    else expect(snapshot.outputTruncation!.originalBytes).toBe(Buffer.byteLength(prefix + "🙂X"));
  }
});

test("block replacement preserves a bounded prefix and truthful counts after earlier truncation", () => {
  const transcript = new ChildTranscript();
  transcript.finish("Earlier finding");
  transcript.start();
  transcript.append(0, "界".repeat(MAX_OUTPUT_BYTES));
  transcript.append(2, "later text");
  transcript.completeBlock(0, "head");
  // Shrinking an earlier block cannot recover a later prefix already discarded.
  const lost = transcript.snapshot();
  expect(lost.output).toBe("head\n");
  expect(lost.outputTruncation).toEqual({ truncated: true, originalBytes: 15, retainedBytes: 5 });
  // Authoritative later content can restore the missing text without duplicates.
  transcript.completeBlock(2, "tail🙂");
  expect(transcript.snapshot(true)).toEqual({ output: "Earlier finding\n\nhead\ntail🙂", outputTruncation: undefined });
  transcript.completeBlock(2, "🙂".repeat(MAX_OUTPUT_BYTES));
  const large = transcript.snapshot(true);
  expect(Buffer.byteLength(large.output!)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  expect(large.outputTruncation!.originalBytes).toBe(Buffer.byteLength("Earlier finding\n\nhead\n") + MAX_OUTPUT_BYTES * 4);
  expect(large.output).not.toContain("�");
});

test.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid text block index %s fails at the protocol boundary", (index) => {
  expect(() => new ChildTranscript().startBlock(index)).toThrow("malformed text block index");
});

test.each([false, true])("interrupted multi-message history stays byte-bounded and truthful (oversized first=%s)", (oversizedFirst) => {
  const completed = ["界🙂".repeat(oversizedFirst ? 10_000 : 10), "later finding".repeat(5_000)];
  const partial = "unfinished🙂".repeat(10_000);
  const transcript = new ChildTranscript();
  for (const text of completed) transcript.finish(text);
  transcript.start();
  transcript.append(0, partial);
  const full = [...completed, partial].join("\n\n");
  const snapshot = transcript.snapshot(true);
  const output = snapshot.output!;
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  expect(snapshot.outputTruncation).toEqual({
    truncated: true, originalBytes: Buffer.byteLength(full), retainedBytes: Buffer.byteLength(output),
  });
  const prefix = output.split("\n\n[Output truncated:")[0]!;
  expect(prefix.length).toBeGreaterThan(0);
  expect(Buffer.from(full).subarray(0, Buffer.byteLength(prefix)).toString("utf8")).toBe(prefix);
  expect(output).not.toContain("�");
});
