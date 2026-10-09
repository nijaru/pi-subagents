import { describe, expect, test } from "bun:test";
import { boundChildResult, boundDetails, jsonBytes, minimalChildResult, truncateOutput } from "../extensions/pi-subagents/bounds.ts";
import { emptyUsage, type ChildResult } from "../extensions/pi-subagents/types.ts";
import { childReports } from "../extensions/pi-subagents/reports.ts";
import { Check } from "typebox/value";
import { SubagentDetailsSchema } from "../extensions/pi-subagents/result-schema.ts";

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
    const original = JSON.stringify(results);
    const bounded = boundDetails({ command: "wait", results });
    expect(JSON.stringify(results)).toBe(original);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(51200);
    expect(Check(SubagentDetailsSchema, bounded)).toBe(true);
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
    // Restoring short context can cost less than describing its omission.
    const bounded = boundChildResult(result, bytes);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(bytes);
    expect(bounded.id).toBe(result.id);
    expect(bounded.state).toEqual(result.state);
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

  test.each([1, 32])("small failures keep their causes when omission metadata is more expensive (%s children)", (count) => {
    const results = Array.from({ length: count }, (_, index) => ({
      ...child(`child-${index}`), prompt: "x", cwd: "/tmp", tools: [], model: undefined,
      output: undefined, outputTruncation: undefined, errorMessage: "bad",
    }));
    expect(jsonBytes(results[0]!)).toBeLessThan(jsonBytes(minimalChildResult(results[0]!)));
    const bounded = boundDetails({ command: "wait", results });
    expect(bounded.results).toEqual(results);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(51200);
  });

  test("large reports cannot starve task identity and diagnostic tails", () => {
    const result = { ...child(), prompt: "Investigate the failure", errorMessage: undefined, model: undefined,
      output: "x".repeat(51200), stderr: "early\n" + "s".repeat(10000) + "\nFINAL_STACK_TRACE",
      outputTruncation: { truncated: false, originalBytes: 51200, retainedBytes: 51200 } };
    const bounded = boundDetails({ command: "wait", results: [result] });
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(51200);
    expect(bounded.results[0]!.prompt).toBe(result.prompt);
    expect(bounded.results[0]!.stderr).toContain("FINAL_STACK_TRACE");
    expect(bounded.results[0]!.output!.length).toBeGreaterThan(40000);
  });

  test("omitted context is explicit rather than a false empty execution value", () => {
    const result = { ...child(), errorMessage: undefined, model: undefined,
      tools: Array.from({ length: 64 }, (_, index) => `${index}-${"t".repeat(200)}`), cwd: "/" + "d".repeat(2000) };
    const bounded = boundChildResult(result, 1100);
    expect(bounded.tools).toEqual([]);
    expect(bounded.cwd).toBe("");
    expect(bounded.omittedFields).toEqual(["cwd", "tools"]);
    expect(Check(SubagentDetailsSchema, { command: "wait", results: [bounded] })).toBe(true);
    const rebound = boundDetails({ command: "status", results: [bounded] }).results[0]!;
    expect(rebound.omittedFields).toEqual(["cwd", "tools"]);
  });

  test("small batch reports return unused space to the large report in both envelopes", () => {
    const results = Array.from({ length: 32 }, (_, index) => {
      const output = index === 0 ? "x".repeat(50000) : "ok";
      return { ...child(`child-${index}`), errorMessage: undefined, model: undefined, stderr: "", output,
        outputTruncation: { truncated: false, originalBytes: output.length, retainedBytes: output.length } };
    });
    const bounded = boundDetails({ command: "wait", results });
    expect(bounded.results.map((result) => result.id)).toEqual(results.map((result) => result.id));
    expect(bounded.results[0]!.output!.length).toBeGreaterThan(30000);
    expect(bounded.results.slice(1).every((result) => result.output === "ok")).toBe(true);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(51200);
    const text = childReports(results);
    expect(text).toContain("x".repeat(30000));
    for (const result of results) expect(text).toContain(result.id);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(51200);
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
