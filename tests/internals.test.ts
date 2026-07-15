import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { getFinalOutput, getPiInvocation, interpolatePrevious, parseJsonEventLine, readDepth, stripTerminalControls, truncateOutput } from "../extensions/pi-subagents/index.ts";

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  model: "fake/model",
  stopReason: "stop",
  timestamp: 0,
};

describe("depth guard", () => {
  test("accepts unset and valid values", () => {
    expect(readDepth(undefined)).toEqual({ valid: true, depth: 0 });
    expect(readDepth("2")).toEqual({ valid: true, depth: 2 });
  });

  test("fails closed for malformed, negative, fractional, and unsafe values", () => {
    for (const value of ["", "-1", "1.5", "abc", "9007199254740992"]) {
      expect(readDepth(value).valid).toBe(false);
      expect(readDepth(value).depth).toBe(3);
    }
  });
});

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
    expect(getFinalOutput([{ ...assistant, content: [null] } as any])).toBe("");
  });
});

describe("terminal rendering safety", () => {
  test("strips ANSI and OSC controls from untrusted text", () => {
    expect(stripTerminalControls("before\u001b]0;evil title\u0007\u001b[31mafter\u001b[0m")).toBe("beforeafter");
  });
});

describe("bounded chain interpolation", () => {
  test("does not expand repeated previous placeholders beyond the task cap", () => {
    const task = "{previous}".repeat(10_000);
    const value = interpolatePrevious(task, "x".repeat(50 * 1024), 100 * 1024);
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(100 * 1024);
  });
});

describe("deterministic truncation", () => {
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
});

function pathReal(value: string): string {
  // realpath is intentionally kept local so the test only asserts the public contract.
  return fs.realpathSync.native(value);
}
