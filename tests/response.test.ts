import { expect, test } from "bun:test";
import { jsonBytes } from "../extensions/pi-subagents/bounds.ts";
import { childReports } from "../extensions/pi-subagents/reports.ts";
import { childResponse } from "../extensions/pi-subagents/response.ts";
import { emptyUsage, type ChildResult } from "../extensions/pi-subagents/types.ts";
import { Check } from "typebox/value";
import { SubagentDetailsSchema } from "../extensions/pi-subagents/result-schema.ts";

test("optional recovery paths cannot crowd primary causes out of a full failure batch", () => {
  const results = Array.from({ length: 32 }, (_, index): ChildResult => ({
    id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`, handle: `sa-${999999 + index}`,
    prompt: "inspect failure", cwd: "/workspace", tools: ["bash"],
    state: { status: "terminal", outcome: "failed", stopReason: "error", finishedAt: 1_700_000_003_100 },
    cleanupMs: 100, output: "partial report ".repeat(1000),
    startedAt: 1_700_000_000_000, taskFinishedAt: 1_700_000_003_000,
    lastActivityAt: 1_700_000_002_000,
    deadline: { phase: "execution", startedAt: 1_700_000_000_000, expiresAt: 1_700_000_003_000 },
    interruption: { activity: "tool", activeToolCount: 1, currentTool: "bash" },
    cleanup: { status: "confirmed" }, errorKind: "protocol",
    sessionFile: "/" + "s".repeat(763) + ".jsonl",
    errorMessage: `protocol failure ${index}: invalid response framing`, stderr: "", usage: emptyUsage(),
  }));
  const response = childResponse("wait", results, childReports);
  const text = response.content[0]!;
  if (text.type !== "text") throw new Error("Expected text report");
  for (const [index, result] of response.details!.results.entries()) {
    expect(result.errorMessage).toContain(`protocol failure ${index}`);
    expect(text.text).toContain(`protocol failure ${index}`);
  }
});

test.each(["completed", "failed"] as const)("one projected view supplies every %s report in text and structured results", (outcome) => {
  const original = Array.from({ length: 32 }, (_, index): ChildResult => ({
    id: `child-${index}`, handle: `sa-${index + 1}`, prompt: "task ".repeat(200), cwd: "/workspace", tools: ["read"],
    state: { status: "terminal", outcome, finishedAt: 1_700_000_003_100 },
    startedAt: 1_700_000_000_000, taskFinishedAt: 1_700_000_003_000,
    deadline: { phase: "execution", startedAt: 1_700_000_000_000, expiresAt: 1_700_000_003_000 },
    lastActivityAt: 1_700_000_002_000, model: "m".repeat(200),
    interruption: outcome === "failed" ? { activity: "tool", activeToolCount: 3, currentTool: "a".repeat(256) } : undefined,
    cleanup: outcome === "failed" ? { status: "unconfirmed", taskOutcome: "failed", error: "cleanup cause ".repeat(1000) } : { status: "confirmed" },
    errorMessage: outcome === "failed" ? `primary failure ${index}: ${"e".repeat(512)}` : undefined,
    output: `REPORT ${index}: ${"界😀x".repeat(4000)}`, stderr: "", usage: emptyUsage(),
  }));
  const before = JSON.stringify(original);
  const response = childResponse("wait", original, childReports);
  expect(response.details === response.structuredContent).toBe(true);
  expect(Check(SubagentDetailsSchema, response.details)).toBe(true);
  expect(jsonBytes(response.details)).toBeLessThanOrEqual(51200);
  const text = response.content[0]!;
  if (text.type !== "text") throw new Error("Expected text report");
  expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(51200);
  expect(text.text).toBe(childReports(response.details!.results));
  for (const result of response.details!.results) {
    expect(text.text).toContain(`${result.handle} [${outcome}]`);
    if (result.output) expect(text.text).toContain(result.output);
    expect(result.outputTruncation?.retainedBytes).toBe(Buffer.byteLength(result.output ?? ""));
    if (outcome === "failed") {
      expect(result.cleanup).toMatchObject({ status: "unconfirmed", taskOutcome: "failed" });
      expect(text.text).toContain("Cleanup unconfirmed; admission and any session lease remain reserved");
    }
  }
  expect(JSON.stringify(original)).toBe(before);
});
