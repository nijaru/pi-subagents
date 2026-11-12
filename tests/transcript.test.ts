import { expect, test } from "bun:test";
import { ChildTranscript } from "../extensions/pi-subagents/transcript.ts";
import { MAX_OUTPUT_BYTES } from "../extensions/pi-subagents/limits.ts";

test("successful output retains completed reports across steering, not narration or streamed duplicates", () => {
  const transcript = new ChildTranscript();
  transcript.finish("Tool narration", "toolUse");
  transcript.finish("Original review", "stop");
  transcript.start();
  transcript.append(0, "Follow-up");
  transcript.finish("Follow-up", "stop");
  expect(transcript.snapshot().output).toBe("Follow-up");
  expect(transcript.snapshot("reports").output).toBe("Follow-up\n\n[Earlier completed answer]\n\nOriginal review");
  expect(transcript.snapshot("history").output).toBe("Tool narration\n\nOriginal review\n\nFollow-up");
});

test("newest completed answer survives an oversized earlier report with truthful UTF-8 sizes", () => {
  const transcript = new ChildTranscript();
  const first = "界🙂".repeat(MAX_OUTPUT_BYTES);
  const second = "Follow-up";
  transcript.finish(first, "stop");
  transcript.finish("not a report", "toolUse");
  transcript.finish(second, "stop");
  const result = transcript.snapshot("reports");
  expect(result.outputTruncation).toEqual({ truncated: true, originalBytes: Buffer.byteLength(second + "\n\n[Earlier completed answer]\n\n" + first), retainedBytes: Buffer.byteLength(result.output!) });
  expect(Buffer.byteLength(result.output!)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  expect(result.output).toStartWith(second + "\n\n[Earlier completed answer]\n\n");
  expect(result.output).not.toContain("�");
});

test("completed answers remain newest-first after repeated truncation and oversized corrections", () => {
  const transcript = new ChildTranscript();
  transcript.finish("FIRST".repeat(MAX_OUTPUT_BYTES), "stop");
  const latest = "CORRECTED🙂".repeat(MAX_OUTPUT_BYTES);
  transcript.finish(latest, "stop");
  expect(transcript.snapshot("reports").output).toStartWith("CORRECTED🙂");
  transcript.finish("final correction", "stop");
  const snapshot = transcript.snapshot("reports");
  expect(snapshot.output).toStartWith("final correction\n\n[Earlier completed answer]\n\nCORRECTED🙂");
  expect(snapshot.outputTruncation!.originalBytes).toBe(Buffer.byteLength(
    "final correction\n\n[Earlier completed answer]\n\n" + latest + "\n\n[Earlier completed answer]\n\n" + "FIRST".repeat(MAX_OUTPUT_BYTES),
  ));
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
  transcript.finish("whole authoritative message", "stop");
  expect(transcript.snapshot("history").output).toBe("whole authoritative message");
});

test("Unicode pairs split across deltas do not imply discarded text or inflate byte counts", () => {
  for (const prefix of ["", "界".repeat(MAX_OUTPUT_BYTES)]) {
    const transcript = new ChildTranscript();
    transcript.start();
    for (const delta of [prefix, "\ud83d", "\ude42", "X"]) transcript.append(0, delta);
    const snapshot = transcript.snapshot("history");
    if (!prefix) expect(snapshot).toEqual({ output: "🙂X", outputTruncation: undefined });
    else expect(snapshot.outputTruncation!.originalBytes).toBe(Buffer.byteLength(prefix + "🙂X"));
  }
});

test("block replacement preserves a bounded prefix and truthful counts after earlier truncation", () => {
  const transcript = new ChildTranscript();
  transcript.finish("Earlier finding", "stop");
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
  expect(transcript.snapshot("history")).toEqual({ output: "Earlier finding\n\nhead\ntail🙂", outputTruncation: undefined });
  transcript.completeBlock(2, "🙂".repeat(MAX_OUTPUT_BYTES));
  const large = transcript.snapshot("history");
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
  for (const text of completed) transcript.finish(text, "stop");
  transcript.start();
  transcript.append(0, partial);
  const full = [...completed, partial].join("\n\n");
  const snapshot = transcript.snapshot("history");
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
