import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { emptyUsage } from "../extensions/pi-subagents/types.ts";
import { truncateHeadTail } from "../extensions/pi-subagents/bounds.ts";
import { stripTerminalControls } from "../extensions/pi-subagents/render.ts";
import { executable, getChildInvocation } from "../extensions/pi-subagents/subprocess.ts";
import { spawnDeathWatchdog } from "../extensions/pi-subagents/process-tree.ts";
import { assistantReport, parseChildEvent } from "../extensions/pi-subagents/child-protocol.ts";
import { classifyExecution } from "../extensions/pi-subagents/supervisor.ts";
import { formatElapsed, isTimeoutSummary, runtimeLabel, timeoutSummary } from "../extensions/pi-subagents/reports.ts";

const assistant: AssistantMessage = {
  role: "assistant", content: [{ type: "text", text: "hello" }], usage: emptyUsage(),
  api: "openai-completions", provider: "fake", model: "model", stopReason: "stop", timestamp: 0,
};

describe("compact child protocol", () => {
  test("huge thinking and signatures cannot displace a small final answer", () => {
    const report = assistantReport({ ...assistant, content: [
      { type: "thinking", thinking: "x".repeat(2_000_000), thinkingSignature: "y".repeat(2_000_000) },
      { type: "text", text: "hello" },
    ] });
    const frame = JSON.stringify({ version: 2, kind: "result", report, usage: emptyUsage() });
    expect(frame.length).toBeLessThan(1000);
    expect(parseChildEvent(frame)).toMatchObject({ report: { output: "hello", outputTruncation: { truncated: false } } });
  });
  test("rejects legacy, malformed, wrong-version and oversized frames", () => {
    for (const line of ["warning", "{}", '{"version":1}', '{"version":2,"kind":"result"}', '{"version":2,"kind":"ready","model":"a/b","tools":[]}', "x".repeat(2_000_000)]) {
      expect(() => parseChildEvent(line)).toThrow();
    }
  });
  test("usage frames reject negative tokens and costs", () => {
    for (const usage of [{ ...emptyUsage(), input: -17 }, { ...emptyUsage(), cost: { ...emptyUsage().cost, total: -5 } }, { ...emptyUsage(), cacheWrite1h: -1 }, { ...emptyUsage(), reasoning: -1 }]) {
      expect(() => parseChildEvent(JSON.stringify({ version: 2, kind: "usage", usage }))).toThrow("Malformed");
      expect(() => parseChildEvent(JSON.stringify({ version: 2, kind: "result", report: assistantReport(assistant), usage }))).toThrow("Malformed");
    }
  });
  test("bounded UTF-8 output has explicit truncation metadata", () => {
    const text = "😀".repeat(100_000);
    const report = assistantReport({ ...assistant, content: [{ type: "text", text }] });
    expect(report.outputTruncation.originalBytes).toBe(400_000);
    expect(report.outputTruncation.truncated).toBe(true);
    expect(report.outputTruncation.retainedBytes).toBeLessThanOrEqual(50 * 1024);
    expect(report.output).not.toContain("�");
  });
  test("output frames carry partial reports", () => {
    const report = { output: "partial", outputTruncation: { truncated: false, originalBytes: 7, retainedBytes: 7 } };
    expect(parseChildEvent(JSON.stringify({ version: 2, kind: "output", report }))).toMatchObject({ kind: "output", report });
  });
  test("errorKind distinguishes startup, protocol, provider, and deadline failures", () => {
    const failed = { outcome: "failed" as const, exitCode: 1, stderr: "" };
    expect(classifyExecution(failed, undefined, "Requested child tools are unavailable", false).errorKind).toBe("startup");
    expect(classifyExecution(failed, undefined, "malformed frame", true).errorKind).toBe("protocol");
    const providerError = assistantReport({ ...assistant, stopReason: "error", errorMessage: "overloaded" });
    expect(classifyExecution({ ...failed, outcome: "completed" }, providerError).errorKind).toBe("provider");
    expect(classifyExecution({ ...failed, outcome: "timed_out", errorMessage: "late", timeoutPhase: "startup" })).toMatchObject({
      errorKind: "deadline", timeoutPhase: "startup",
    });
  });

  test("timeouts and cancellation outrank assistant and protocol errors", () => {
    for (const outcome of ["timed_out", "cancelled"] as const) {
      for (const report of [assistantReport({ ...assistant, stopReason: "error", errorMessage: "earlier" }), assistantReport(assistant)]) {
        const classified = classifyExecution({ outcome, exitCode: 1, stderr: "diagnostic", stdout: "stdout diagnostic" }, report, "protocol");
        expect(classified.outcome).toBe(outcome);
        expect(classified).not.toHaveProperty("stderr");
        expect(classified).not.toHaveProperty("stdout");
      }
    }
  });
  test("elapsed formatting keeps sub-second and sub-10s precision", () => {
    expect(formatElapsed(250)).toBe("250ms");
    expect(formatElapsed(1_500)).toBe("1.5s");
    expect(timeoutSummary(1_500, 1_500)).toBe("Subagent timed out during execution. Elapsed 1.5s; execution deadline 1.5s.");
  });
  test("runtime labels exclude process cleanup", () => {
    const result = {
      ...assistantReport(assistant),
      id: "child", prompt: "task", cwd: "/tmp", tools: [], startedAt: 1_000,
      state: { status: "terminal" as const, outcome: "completed" as const, exitCode: 0, stopReason: "stop" as const, finishedAt: 11_000 },
      cleanupMs: 3_000, stderr: "", usage: emptyUsage(),
      outputTruncation: { truncated: false, originalBytes: 0, retainedBytes: 0 },
    };
    expect(runtimeLabel(result)).toBe("7s");
  });

  test("timeout summaries name elapsed runtime and the deadline, nothing else", () => {
    expect(timeoutSummary(250, 200)).toBe("Subagent timed out during execution. Elapsed 250ms; execution deadline 200ms.");
    expect(timeoutSummary(1_800_000, 3_600_000)).toBe("Subagent timed out during execution. Elapsed 30m 0s; execution deadline 1h 0m 0s.");
    expect(isTimeoutSummary(timeoutSummary(0, 0))).toBe(true);
    expect(isTimeoutSummary("assistant failed")).toBe(false);
    expect(isTimeoutSummary(undefined)).toBe(false);
  });
  test("rejects inconsistent output truncation metadata", () => {
    for (const outputTruncation of [
      { truncated: false, originalBytes: 10, retainedBytes: 5 },
      { truncated: true, originalBytes: 1, retainedBytes: 5 },
      { truncated: true, originalBytes: -1, retainedBytes: 5 },
    ]) {
      const report = { ...assistantReport(assistant), outputTruncation };
      expect(() => parseChildEvent(JSON.stringify({ version: 2, kind: "result", report, usage: emptyUsage() }))).toThrow();
    }
  });
  test("length is incomplete, not successful; completed retry has no stale error", () => {
    const process = { outcome: "completed" as const, exitCode: 0, stderr: "" };
    expect(classifyExecution(process, assistantReport({ ...assistant, stopReason: "length" })).outcome).toBe("incomplete");
    expect(classifyExecution(process, assistantReport(assistant))).toEqual({ outcome: "completed", exitCode: 0, stopReason: "stop" });
    expect(classifyExecution(process).outcome).toBe("failed");
  });
});

describe("terminal rendering safety", () => {
  test("strips ANSI and OSC controls from untrusted text", () => {
    expect(stripTerminalControls("before\u001b]0;evil title\u0007\u001b[31mafter\u001b[0m")).toBe("beforeafter");
  });
});

describe("deterministic truncation", () => {
  test("head+tail truncation keeps both ends", () => {
    const value = "EARLY_DIAGNOSTIC\n" + "x".repeat(60000) + "\nFINAL_STACK_TRACE";
    const bounded = truncateHeadTail(value, 8192);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(8192);
    expect(bounded).toContain("EARLY_DIAGNOSTIC");
    expect(bounded).toContain("FINAL_STACK_TRACE");
    expect(bounded).toContain("truncated");
    expect(truncateHeadTail("short", 8192)).toBe("short");
  });
  test("head+tail truncation does not split Unicode at either end", () => {
    const value = "😀漢字".repeat(100);
    for (const limit of [5, 8, 18, 19, 20, 30, 40, 42, 43, 80]) {
      const output = truncateHeadTail(value, limit);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(limit);
      expect(output).not.toContain("�");
    }
  });
});

describe("SDK invocation", () => {
  test("uses absolute runtime, packaged bootstrap and SDK paths", () => {
    const invocation = getChildInvocation();
    expect(path.isAbsolute(invocation.command)).toBe(true);
    expect(invocation.args[0]).toEndWith("child-bootstrap.mjs");
    expect(invocation.args.every(path.isAbsolute)).toBe(true);
  });
  test("does not treat directories as executables", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-bin-"));
    try {
      expect(executable(directory)).toBe(false);
      expect(executable(process.execPath)).toBe(true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

describe("parent-death supervision", () => {
  test.skipIf(process.platform === "win32")("watchdog leaves a live parent's child group alone until pipe closes", async () => {
    const victim = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    const pid = victim.pid!;
    const watchdog = await spawnDeathWatchdog(victim, getChildInvocation().command);
    expect(watchdog).toBeDefined();
    try {
      await Bun.sleep(300);
      expect(groupAlive(pid)).toBe(true);
      watchdog!.stdin!.end();
      const deadline = Date.now() + 8000;
      while (groupAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
      expect(groupAlive(pid)).toBe(false);
    } finally { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
  });
});
