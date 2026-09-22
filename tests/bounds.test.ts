import { describe, expect, test } from "bun:test";
import { boundChildResult, boundDetails, jsonBytes, minimalChildResult, truncateOutput } from "../extensions/pi-subagents/bounds.ts";
import { emptyUsage, type ChildResult } from "../extensions/pi-subagents/types.ts";

function child(id = "child-1"): ChildResult {
  return {
    id, prompt: "task", cwd: "/tmp", tools: ["read"], startedAt: 1,
    state: { status: "terminal", outcome: "failed", exitCode: 1, finishedAt: 2 },
    errorMessage: "\u0001".repeat(512), model: "\u0001".repeat(256),
    output: "😀\\\"\n".repeat(2000),
    outputTruncation: { truncated: false, originalBytes: 14000, retainedBytes: 14000 },
    stderr: "", usage: emptyUsage(),
  };
}

describe("serialized result bounds", () => {
  test("32 escaped diagnostics retain every identity within the default budget", () => {
    const results = Array.from({ length: 32 }, (_, i) => child(`child-${i}`));
    const bounded = boundDetails({ command: "wait", results });
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(51200);
    expect(bounded.results.map(result => result.id)).toEqual(results.map(result => result.id));
    for (const [i, result] of bounded.results.entries()) {
      expect(result.state).toEqual(results[i]!.state);
      expect(result.errorMessage).toBeTruthy();
      expect(result.outputTruncation).toEqual({
        truncated: true, originalBytes: 14000,
        retainedBytes: Buffer.byteLength(result.output ?? ""),
      });
    }
  });

  test("exact minimal budgets fit; impossible budgets explicitly fail", () => {
    const result = child();
    const minimal = minimalChildResult(result);
    const bytes = jsonBytes(minimal);
    expect(boundChildResult(result, bytes)).toEqual(minimal);
    expect(() => boundChildResult(result, bytes - 1)).toThrow(RangeError);
    const details = { command: "wait" as const, results: [result, child("child-2")] };
    const minimalDetails = { ...details, results: details.results.map(minimalChildResult) };
    const budget = jsonBytes(minimalDetails);
    expect(boundDetails(details, budget)).toEqual(minimalDetails);
    expect(jsonBytes(boundDetails(details, budget + 1))).toBeLessThanOrEqual(budget + 1);
    expect(() => boundDetails(details, budget - 1)).toThrow(RangeError);
    expect(() => boundDetails({ command: "status", results: [] }, 0)).toThrow(RangeError);
    expect(() => boundDetails(details, NaN)).toThrow(RangeError);
  });

  test("escaping is budgeted and existing truncation remains truthful", () => {
    const result = child();
    result.outputTruncation!.truncated = true;
    result.outputTruncation!.originalBytes = 20000;
    for (const budget of [600, 1000, 1800, 5000, 51200]) {
      const bounded = boundChildResult(result, budget);
      expect(jsonBytes(bounded)).toBeLessThanOrEqual(budget);
      expect(bounded.outputTruncation).toEqual({
        truncated: true, originalBytes: 20000,
        retainedBytes: Buffer.byteLength(bounded.output ?? ""),
      });
    }
  });
});

describe("output truncation", () => {
  test("digit-boundary oscillation reports the prefix actually retained", () => {
    expect(truncateOutput("x".repeat(52), 51)).toBe("x".repeat(9) + "\n\n[Output truncated: kept 9 of 52 bytes.]");
  });

  test("ASCII and UTF-8 prefixes are bounded and truthful across digit boundaries", () => {
    for (const value of ["x".repeat(1200), "😀é中".repeat(200), "x".repeat(52)]) {
      const total = Buffer.byteLength(value);
      for (let budget = 0; budget <= Math.min(total + 1, 1201); budget++) {
        const output = truncateOutput(value, budget);
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(budget);
        expect(output).not.toContain("\ufffd");
        if (budget >= total) {
          expect(output).toBe(value);
          continue;
        }
        const match = output.match(/\n\n\[Output truncated: kept (\d+) of (\d+) bytes\.\]$/);
        if (!match) continue;
        const prefix = output.slice(0, match.index);
        expect(value.startsWith(prefix)).toBe(true);
        expect(Number(match[1])).toBe(Buffer.byteLength(prefix));
        expect(Number(match[2])).toBe(total);
        // The next whole code point must not fit with its truthful marker.
        const next = prefix + Array.from(value.slice(prefix.length))[0];
        const nextOutput = next + `\n\n[Output truncated: kept ${Buffer.byteLength(next)} of ${total} bytes.]`;
        expect(Buffer.byteLength(nextOutput)).toBeGreaterThan(budget);
      }
    }
  });
});
