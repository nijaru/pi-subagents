import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { emptyUsage } from "../extensions/pi-subagents/types.ts";
import { truncateHeadTail, truncateOutput } from "../extensions/pi-subagents/bounds.ts";
import { stripTerminalControls } from "../extensions/pi-subagents/render.ts";
import { executable, getChildInvocation, spawnDeathWatchdog } from "../extensions/pi-subagents/subprocess.ts";
import { assistantReport, parseChildEvent } from "../extensions/pi-subagents/child-protocol.ts";
import { classifyExecution } from "../extensions/pi-subagents/supervisor.ts";

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
    const frame = JSON.stringify({ version: 1, kind: "result", report, usage: emptyUsage() });
    expect(frame.length).toBeLessThan(1000);
    expect(parseChildEvent(frame)).toMatchObject({ report: { output: "hello", outputTruncation: { truncated: false } } });
  });
  test("rejects legacy, malformed, wrong-version and oversized frames", () => {
    for (const line of ["warning", "{}", '{"version":2}', '{"version":1,"kind":"result"}', "x".repeat(2_000_000)]) {
      expect(() => parseChildEvent(line)).toThrow();
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
  test("timeouts and cancellation outrank assistant and protocol errors", () => {
    for (const outcome of ["timed_out", "cancelled"] as const) {
      expect(classifyExecution({ outcome, exitCode: 1, stderr: "" }, assistantReport({ ...assistant, stopReason: "error", errorMessage: "earlier" }), "protocol").outcome).toBe(outcome);
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
  test("is deterministic and byte-safe", () => {
    expect(truncateOutput("small", 20)).toBe("small");
    for (const limit of [5, 8, 18, 19, 20, 30, 40, 42, 43, 80]) {
      for (const truncate of [truncateOutput, truncateHeadTail]) {
        const value = "😀漢字".repeat(100);
        const output = truncate(value, limit);
        expect(output).toBe(truncate(value, limit));
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(limit);
        expect(output).not.toContain("�");
      }
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
  test("watchdog leaves a live parent's child group alone until pipe closes", async () => {
    if (process.platform === "win32") return;
    const victim = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    const pid = victim.pid!;
    const watchdog = spawnDeathWatchdog(victim);
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
