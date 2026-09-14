import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { textFromMessage } from "../extensions/pi-subagents/types.ts";
import { truncateHeadTail, truncateOutput } from "../extensions/pi-subagents/bounds.ts";
import { stripTerminalControls } from "../extensions/pi-subagents/render.ts";
import { executable, getPiInvocation, parseJsonEventLine, spawnDeathWatchdog } from "../extensions/pi-subagents/subprocess.ts";

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  model: "fake/model",
  stopReason: "stop",
  timestamp: 0,
};

describe("JSON subprocess parsing", () => {
  test("parses final messages and progress while ignoring noise", () => {
    const message = parseJsonEventLine(JSON.stringify({ type: "message_end", message: assistant }));
    expect(message?.kind).toBe("message");
    expect(message?.message?.role).toBe("assistant");
    expect(parseJsonEventLine("startup warning")).toBeUndefined();
    const progress = parseJsonEventLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
    expect(progress).toEqual({ kind: "progress", text: "Running read..." });
    const finished = parseJsonEventLine(JSON.stringify({ type: "tool_execution_end", toolName: "read" }));
    expect(finished).toEqual({ kind: "progress", text: "Finished read." });
    expect(parseJsonEventLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    }))).toBeUndefined();
    expect(parseJsonEventLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning" },
    }))).toBeUndefined();
    expect(parseJsonEventLine(JSON.stringify({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "legacy cumulative snapshot" }] },
    }))).toBeUndefined();
  });

  test("preserves typed agent_end messages as a fallback", () => {
    const parsed = parseJsonEventLine(JSON.stringify({ type: "agent_end", messages: [assistant] }));
    expect(parsed?.kind).toBe("messages");
    expect(parsed?.messages).toHaveLength(1);
  });

  test("accepts user messages with string content", () => {
    const parsed = parseJsonEventLine(JSON.stringify({
      type: "message_end",
      message: { role: "user", content: "hello", timestamp: 0 },
    }));
    expect(parsed?.kind).toBe("message");
    expect(parsed?.message?.role).toBe("user");
  });

  test("preserves typed tool-result messages", () => {
    const parsed = parseJsonEventLine(JSON.stringify({
      type: "message_end",
      message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 0 },
    }));
    expect(parsed?.kind).toBe("message");
    expect(parsed?.message?.role).toBe("toolResult");
    expect(parseJsonEventLine(JSON.stringify({ type: "message_end", message: { role: "toolResult", content: "bad" } }))).toBeUndefined();
    expect(parseJsonEventLine(JSON.stringify({ type: "message_end", message: assistant }))?.kind).toBe("message");
  });

  test("rejects malformed message content and usage", () => {
    expect(parseJsonEventLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [null] } }))).toBeUndefined();
    expect(parseJsonEventLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }))).toBeUndefined();
    expect(parseJsonEventLine(JSON.stringify({
      type: "message_end",
      message: { ...assistant, usage: { ...assistant.usage, output: "bad" } },
    }))).toBeUndefined();
    expect(textFromMessage({ ...assistant, content: [null] } as any)).toBe("");
  });
});

describe("terminal rendering safety", () => {
  test("strips ANSI and OSC controls from untrusted text", () => {
    expect(stripTerminalControls("before\u001b]0;evil title\u0007\u001b[31mafter\u001b[0m")).toBe("beforeafter");
  });
});

describe("deterministic truncation", () => {
  test("head+tail truncation keeps both ends of over-budget text", () => {
    const value = "EARLY_DIAGNOSTIC\n" + "x".repeat(60000) + "\nFINAL_STACK_TRACE";
    const bounded = truncateHeadTail(value, 8192);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(8192);
    expect(bounded).toContain("EARLY_DIAGNOSTIC");
    expect(bounded).toContain("FINAL_STACK_TRACE");
    expect(bounded).toContain("truncated");
    expect(truncateHeadTail("short", 8192)).toBe("short");
    for (const limit of [8, 20, 40]) {
      const emoji = truncateHeadTail("😀漢字".repeat(50), limit);
      expect(Buffer.byteLength(emoji, "utf8")).toBeLessThanOrEqual(limit);
      expect(emoji).not.toContain("\ufffd");
    }
  });
  test("is unchanged below the limit and byte-safe above it", () => {
    expect(truncateOutput("small", 20)).toBe("small");
    const value = "😀漢字".repeat(100);
    const first = truncateOutput(value, 80);
    expect(first).toBe(truncateOutput(value, 80));
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(80);
    expect(first).toContain("Output truncated");
    expect(first).not.toContain("�");
    expect(Buffer.byteLength(truncateOutput(value, 5), "utf8")).toBeLessThanOrEqual(5);
    for (const limit of [18, 19, 20, 30, 42, 43]) {
      expect(Buffer.byteLength(truncateOutput(value, limit), "utf8")).toBeLessThanOrEqual(limit);
    }
  });
});

describe("pi invocation", () => {
  test("uses an explicitly configured absolute executable", () => {
    const old = process.env.PI_SUBAGENT_BIN;
    process.env.PI_SUBAGENT_BIN = process.execPath;
    try {
      const invocation = getPiInvocation(["--mode", "json"]);
      expect(invocation.command).toBe(pathReal(process.execPath));
      expect(invocation.args).toEqual(["--mode", "json"]);
    } finally {
      if (old === undefined) delete process.env.PI_SUBAGENT_BIN;
      else process.env.PI_SUBAGENT_BIN = old;
    }
  });

  test("does not treat directories as executables", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-bin-"));
    try {
      expect(executable(directory)).toBe(false);
      expect(executable(process.execPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function pathReal(value: string): string {
  // realpath is intentionally kept local so the test only asserts the public contract.
  return fs.realpathSync.native(value);
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("parent-death supervision", () => {
  test("the watchdog leaves a live parent's child group alone until the pipe closes", async () => {
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
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
});
