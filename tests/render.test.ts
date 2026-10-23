import { describe, expect, test } from "bun:test";
import {
  ToolExecutionComponent, initTheme,
  type AgentToolResult, type Theme, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import extension from "../extensions/pi-subagents/index.ts";
import { childListText, renderChildCall, renderChildResult, renderChildNotice, stripTerminalControls } from "../extensions/pi-subagents/render.ts";
import { childStatus, timeoutSummary } from "../extensions/pi-subagents/reports.ts";
import { emptyUsage, type ChildResult, type SubagentDetails } from "../extensions/pi-subagents/types.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const child: ChildResult = {
  id: "900c096e-a585-4c0f-9089-25ada5a73466", prompt: "Read the package version.", cwd: "/project", tools: ["read"],
  output: "pi-subagents 0.1.0", state: { status: "terminal", outcome: "completed", exitCode: 0, stopReason: "stop", finishedAt: 8000 }, startedAt: 0,
  stderr: "", usage: { ...emptyUsage(), turns: 2 }, model: "test/model",
};
test("status includes a terminal failure cause and bounded partial output", () => {
  const failedChild: ChildResult = {
    ...child,
    output: "partial report",
    state: { status: "terminal", outcome: "failed", exitCode: 1, stopReason: "error", finishedAt: 8000 },
    errorMessage: "child failed for a concrete reason",
  };
  const text = childStatus(failedChild);
  expect(text).toContain("cause: child failed for a concrete reason");
  expect(text).toContain("partial output: partial report");
  expect(childStatus(child)).not.toContain("cause:");
});

const result = (command: SubagentDetails["command"], children = [child]): AgentToolResult<SubagentDetails> => ({
  content: [{ type: "text", text: "fallback" }], details: { command, results: children },
});
const context = (args: Record<string, unknown>, expanded = false) => ({ args, expanded }) as NonNullable<Parameters<typeof renderChildCall>[2]>;
const lines = (command: SubagentDetails["command"], args: Record<string, unknown>, expanded = false, children = [child], width = 80) => [
  ...renderChildCall(args, theme, context(args, expanded)).render(width),
  ...renderChildResult(result(command, children), { expanded }, theme, context(args, expanded)).render(width),
].map((line) => stripTerminalControls(line).trimEnd());

describe("compact child rendering", () => {
  test("Pi's actual tool row passes context and expands without duplicate IDs", () => {
    initTheme("dark", false);
    let tool: ToolDefinition<any, any> | undefined;
    extension({ registerTool(value: ToolDefinition<any, any>) { tool = value; }, registerMessageRenderer() {}, on() {} } as any);
    const row = new ToolExecutionComponent("subagent", "test-call", { command: "wait", ids: [child.id] }, {}, tool, { requestRender() {} } as TUI, "/project");
    row.updateResult({ ...result("wait"), isError: false });
    const compact = row.render(80).map((line) => stripTerminalControls(line).trim()).filter(Boolean);
    expect(compact).toEqual(["subagent wait 900c096e", "✓ completed · 8s"]);
    row.setExpanded(true);
    const full = stripTerminalControls(row.render(80).join("\n"));
    expect(full.match(new RegExp(child.id, "g"))).toHaveLength(1);
    for (const value of [child.prompt, child.output!, "cwd: /project", "tools: read", "2 turns", "test/model"]) expect(full).toContain(value);
    row.setExpanded(false);
    expect(row.render(40).map((line) => stripTerminalControls(line).trim()).filter(Boolean)).toEqual(compact);
  });
  test("foreground runs show status only; reports stay behind expansion", () => {
    expect(lines("run", { command: "run", prompt: child.prompt })).toEqual([
      "subagent run", "✓ 900c096e completed · 8s",
    ]);
  });
  test.each(["starting", "running", "stopping"] as const)("a live row shows its %s phase once", (phase) => {
    const running = { ...child, state: { status: "running" } as const, phase, startedAt: undefined };
    expect(lines("run", { command: "run", prompt: child.prompt }, false, [running])).toEqual([
      "subagent run", `○ 900c096e ${phase} · Read the package version.`,
    ]);
  });
  test.each([child.id, "sa-42"])("targeted status identifies %s only in its header", (id) => {
    expect(lines("status", { command: "status", id }, false, [{ ...child, handle: "sa-42" }])).toEqual([
      `subagent status ${id.slice(0, 8)}`, "✓ completed · 8s · Read the package version.",
    ]);
  });
  test("status lists identify every child and task on one line each", () => {
    const second = { ...child, id: "abcd1234-0000", prompt: "Second task" };
    expect(lines("status", { command: "status" }, false, [child, second])).toEqual([
      "subagent status", "✓ 900c096e completed · 8s · Read the package version.", "✓ abcd1234 completed · 8s · Second task",
    ]);
  });
  test("omitted launch context is not rendered as a reasoning-only task", () => {
    const omitted = { ...child, cwd: "", tools: [], omittedFields: ["cwd", "tools"] as const };
    const text = lines("wait", { command: "wait", ids: [child.id] }, true, [{ ...omitted, omittedFields: [...omitted.omittedFields] }]).join("\n");
    expect(text).toContain("cwd: not retained (response budget)");
    expect(text).toContain("tools: not retained (response budget)");
    expect(text).not.toContain("tools: none");
    expect(lines("wait", { command: "wait", ids: [child.id] }, true, [{ ...child, tools: [] }]).join("\n")).toContain("tools: none");
  });
  test("running rows carry the task label and wait expiry stays explicit", () => {
    const active = { ...child, state: { status: "running" } as const, startedAt: undefined };
    expect(lines("spawn", { command: "spawn", prompt: child.prompt }, false, [active])).toEqual([
      "subagent spawn", "○ 900c096e started · Read the package version.",
    ]);
    expect(lines("wait", { command: "wait", ids: [child.id] }, false, [active])).toEqual([
      "subagent wait 900c096e", "○ running · Read the package version.", "Wait expired; child continues.",
    ]);
  });
  test("multi-child joins distinguish remaining work from wait expiry", () => {
    const active = { ...child, id: "abcd1234", state: { status: "running" } as const };
    const value = result("wait", [child, active]);
    value.details.waitExpired = false;
    const text = renderChildResult(value, { expanded: false }, theme).render(120).join("\n");
    expect(text).toContain("Child continues.");
    expect(text).not.toContain("expired");
    expect(renderChildCall({ command: "wait", ids: [child.id, active.id] }, theme).render(80).join("\n")).toContain("2 children");
  });
  test("wait emits one result-level continuation notice for several active children", () => {
    const first = { ...child, id: "first", handle: "sa-1", state: { status: "running" } as const };
    const second = { ...child, id: "second", handle: "sa-2", state: { status: "running" } as const };
    const value = result("wait", [first, second]);
    value.details.waitExpired = true;
    const text = renderChildResult(value, { expanded: false }, theme).render(120).join("\n");
    expect(text.match(/continue/gi)).toHaveLength(1);
  });
  test("expanded steer shows the steering message instead of the original task", () => {
    const args = { command: "steer", id: child.id, message: "focus on empty input" };
    const active = { ...child, state: { status: "running" } as const, prompt: "ORIGINAL_TASK_PROMPT", startedAt: undefined };
    const text = lines("steer", args, true, [active], 120).join("\n");
    expect(text).toContain("focus on empty input");
    expect(text).not.toContain("ORIGINAL_TASK_PROMPT");
  });
  test("expanded active activity is rendered once with its last time", () => {
    const lastActivityAt = 1_700_000_000_000;
    const active = { ...child, state: { status: "running" } as const, activity: "tool" as const,
      currentTool: "read", lastActivityAt, startedAt: undefined };
    const expanded = lines("status", { command: "status", id: child.id }, true, [active], 120).join("\n");
    expect(expanded).toContain("running · tool: read");
    expect(expanded).not.toContain("activity: tool (read)");
    expect(expanded).toContain(`last activity: ${new Date(lastActivityAt).toISOString()}`);
  });
  test("expanded failure reports include an embedded diagnostic once and keep partial output", () => {
    const failedChild: ChildResult = { ...child, output: "partial report", stderr: "UNIQUE_STDERR_DIAGNOSTIC",
      errorMessage: "Child produced no terminal assistant output; a final response is required.",
      state: { status: "terminal", outcome: "failed", exitCode: 1, stopReason: "error", finishedAt: 8000 } };
    const text = lines("wait", { command: "wait", ids: [child.id] }, true, [failedChild], 120).join("\n");
    expect(text.match(/UNIQUE_STDERR_DIAGNOSTIC/g)).toHaveLength(1);
    expect(text).toContain("partial report");
  });
  test("generic cancellation diagnostics are not repeated in compact rows", () => {
    const cancelled: ChildResult = { ...child, stderr: "",
      state: { status: "terminal", outcome: "cancelled", exitCode: 1, stopReason: "aborted", finishedAt: 8000 },
      errorMessage: "Subagent cancelled." };
    const generic = lines("stop", { command: "stop", id: child.id }, false, [cancelled]).join("\n");
    expect(generic).toContain("cancelled");
    expect(generic).not.toContain("Subagent cancelled.");
    const withDiagnostic = { ...cancelled, stderr: "cancelled by user signal" };
    expect(lines("stop", { command: "stop", id: child.id }, false, [withDiagnostic]).join("\n"))
      .toContain("cancelled by user signal");
  });
  test("old spawn and status snapshots do not acquire a live elapsed timer", () => {
    const active = { ...child, state: { status: "running" } as const, startedAt: 0 };
    for (const command of ["spawn", "status", "wait"] as const) {
      const text = lines(command, { command }, false, [active]).join("\n");
      expect(text).not.toContain("elapsed");
      expect(text).not.toMatch(/· \d+[smh]/);
    }
  });
  test("failed, timed-out and cancelled children remain distinguishable", () => {
    for (const termination of ["failed", "timed_out", "cancelled"] as const) {
      const failed = { ...child, state: { status: "terminal", outcome: termination, exitCode: 1, finishedAt: 8000 } as const, errorMessage: "Reason for stopping" };
      const text = lines("stop", { command: "stop", id: child.id }, false, [failed]).join("\n");
      expect(text).toContain(termination.replaceAll("_", " "));
      expect(text).toContain("Reason for stopping");
      expect(text).not.toContain(child.output!);
    }
  });
  test("incomplete output and diagnostic streams remain visible on expansion", () => {
    const incomplete: ChildResult = { ...child,
      state: { status: "terminal", outcome: "incomplete", stopReason: "length", exitCode: 0, finishedAt: 8000 },
      errorMessage: "Model output limit reached", stdout: "diagnostic stdout", stderr: "diagnostic stderr",
      outputTruncation: { truncated: true, originalBytes: 1000, retainedBytes: Buffer.byteLength(child.output!) },
    };
    const text = lines("wait", { command: "wait", ids: [child.id] }, true, [incomplete]).join("\n");
    for (const label of ["! incomplete", child.output!, "Model output limit reached", "Output shortened", "diagnostic stdout", "diagnostic stderr"]) expect(text).toContain(label);
  });

  test("activity is visible without private payloads and last activity survives failure rendering", () => {
    const lastActivityAt = 1_700_000_000_000;
    const active: ChildResult = { ...child, state: { status: "running" }, startedAt: undefined, lastActivityAt, activity: "tool", currentTool: "read" };
    expect(childStatus(active)).toContain("activity: tool (read) · last activity: 2023-11-14T22:13:20.000Z");
    expect(lines("status", { command: "status", id: child.id }, false, [active]).join("\n")).toContain("running · tool: read");
    expect(lines("status", { command: "status", id: child.id }, false, [{ ...active, activity: "thinking", currentTool: undefined }]).join("\n")).toContain("running · thinking");
    const failed: ChildResult = { ...child, lastActivityAt, sessionFile: "/tmp/recover.jsonl",
      state: { status: "terminal", outcome: "failed", exitCode: 1, finishedAt: 8000 }, errorMessage: "provider failed" };
    const expanded = lines("status", { command: "status", id: child.id }, true, [failed], 120).join("\n");
    expect(expanded).toContain("last activity: 2023-11-14T22:13:20.000Z");
    expect(expanded).toContain("session: /tmp/recover.jsonl");
    const completed = { ...child, lastActivityAt };
    expect(childStatus(completed)).not.toContain("last activity:");
    expect(lines("wait", { command: "wait", ids: [child.id] }, true, [completed], 120).join("\n")).not.toContain("last activity:");
    for (const width of [20, 40, 80]) {
      const rows = renderChildResult(result("status", [{ ...active, currentTool: "a".repeat(256) }]), { expanded: false }, theme).render(width);
      expect(rows).toHaveLength(1);
      expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
    }
  });

  test("command list omits default inbox and bounds cwd to one clean line", () => {
    const inbox = { ...child, cwd: "/work\nspace\u001b[31m", notify: "inbox" as const };
    const turn = { ...child, id: "second", handle: "sa-2", notify: "turn" as const, cwd: `/${"d".repeat(5000)}` };
    const rows = childListText([inbox, turn]).split("\n");
    expect(rows).toHaveLength(2);
    const defaultRow = rows.find((row) => row.startsWith("900c096e"))!;
    expect(defaultRow).toContain("/work space");
    expect(defaultRow).not.toContain("inbox");
    expect(defaultRow).not.toContain("\u001b");
    expect(rows.find((row) => row.startsWith("sa-2"))).toContain(" · turn · ");
  });
  test("narrow terminals keep one bounded preview row per child", () => {
    const long = { ...child, prompt: "wide界🙂 ".repeat(1000), state: { status: "running" } as const };
    for (const width of [20, 40, 80, 120]) {
      const rows = renderChildResult(result("run", [long]), { expanded: false }, theme).render(width);
      expect(rows).toHaveLength(1);
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  });
  test("prompts are hidden until expansion, then shown without terminal controls", () => {
    const args = { command: "run", prompt: "hello\n\tworld\x1b[31m " + "x".repeat(500) };
    expect(renderChildCall(args, theme).render(40).map((line) => stripTerminalControls(line).trim())).toEqual(["subagent run"]);
    const rows = renderChildCall(args, theme, context(args, true)).render(40);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.join(" ")).toContain("hello");
    expect(rows.join("")).not.toContain("\x1b[31m");
    expect(() => renderChildCall({ command: {}, prompt: 123, id: [] }, theme).render(40)).not.toThrow();
  });
  test("timeout report shows runtime without repeating the generic cause", () => {
    const timedOut: ChildResult = { ...child, output: undefined,
      state: { status: "terminal", outcome: "timed_out", exitCode: 1, finishedAt: 1_800_000 },
      errorMessage: timeoutSummary(1_800_000, 1_800_000),
    };
    const value = result("wait", [timedOut]);
    expect(renderChildResult(value, { expanded: false }, theme).render(120).map((line) => line.trim()))
      .toEqual(["✗ 900c096e timed out · 30m 0s"]);
    const expanded = renderChildResult(value, { expanded: true }, theme).render(120).join("\n");
    expect(expanded).toContain("Subagent timed out during execution.");
    expect(expanded).toContain("execution deadline 30m 0s");
  });
  test("old or malformed transcript details fall back to text; oversized output stays bounded", () => {
    for (const details of [
      { results: [{ agent: "worker" }] }, { command: "run", results: [{ ...child, model: {} }] },
      { command: "run", results: [{ ...child, usage: { ...child.usage, turns: -1.5 } }] },
    ]) {
      const value = { content: [{ type: "text" as const, text: "old output" }], details } as any;
      expect(renderChildResult(value, { expanded: true }, theme).render(80).join("\n")).toContain("old output");
    }
    const oversized = result("run", [{ ...child, output: "x".repeat(200000) }]);
    expect(renderChildResult(oversized, { expanded: true }, theme).render(80).join("\n").length).toBeLessThan(70000);
  });
  test("readiness notices render safe text, never hidden reports", () => {
    const message = { role: "custom" as const, customType: "subagent-ready", content: "Ready: sa-1\u001b[31m. Use wait.", display: true, timestamp: 0, details: { handles: ["sa-1"] } };
    const text = renderChildNotice(message, { expanded: false, outputPad: 1 }, theme)!.render(80).join("\n");
    expect(text).toContain("Ready: sa-1. Use wait.");
    expect(text).not.toContain("\u001b[31m");
  });
});
