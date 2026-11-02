import { expect, test } from "bun:test";
import { ChildTranscript } from "../extensions/pi-subagents/transcript.ts";
import { MAX_OUTPUT_BYTES } from "../extensions/pi-subagents/limits.ts";

test("successful output is the final report, not earlier narration or streamed duplicates", () => {
  const transcript = new ChildTranscript();
  transcript.finish("Earlier finding");
  transcript.start();
  transcript.append("Final report");
  transcript.finish("Final report");
  expect(transcript.snapshot().output).toBe("Final report");
  expect(transcript.snapshot(true).output).toBe("Earlier finding\n\nFinal report");
});

test.each([false, true])("interrupted multi-message history stays byte-bounded and truthful (oversized first=%s)", (oversizedFirst) => {
  const completed = ["界🙂".repeat(oversizedFirst ? 10_000 : 10), "later finding".repeat(5_000)];
  const partial = "unfinished🙂".repeat(10_000);
  const transcript = new ChildTranscript();
  for (const text of completed) transcript.finish(text);
  transcript.start();
  transcript.append(partial);
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
