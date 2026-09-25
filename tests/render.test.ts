import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension from "../extensions/pi-subagents/index.ts";
import { renderChildCall, renderChildResult, renderChildCompletion, stripTerminalControls } from "../extensions/pi-subagents/render.ts";
import { boundDetails } from "../extensions/pi-subagents/bounds.ts";
import { emptyUsage, type ChildResult, type SubagentDetails } from "../extensions/pi-subagents/types.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const child: ChildResult = {
  id: "900c096e-a585-4c0f-9089-25ada5a73466", prompt: "Read the package version.", cwd: "/project", tools: ["read"],
  output: "pi-subagents 0.1.0", state: { status: "terminal", outcome: "completed", exitCode: 0, stopReason: "stop", finishedAt: 8000 }, startedAt: 0,
  stderr: "", usage: { ...emptyUsage(), turns: 2 }, model: "test/model",
};
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
    expect(full).toContain("2 turns");
    row.setExpanded(false);
    expect(row.render(40).map((line) => stripTerminalControls(line).trim()).filter(Boolean)).toEqual(compact);
  });
  test("foreground runs show status only; reports stay behind expansion", () => {
    expect(lines("run", { command: "run", prompt: child.prompt })).toEqual([
      "subagent run", "✓ 900c096e completed · 8s",
    ]);
  });
  test("targeted status and wait show the ID only in the call header", () => {
    expect(lines("status", { command: "status", id: child.id })).toEqual([
      "subagent status 900c096e", "✓ completed · 8s · Read the package version.",
    ]);
    expect(lines("wait", { command: "wait", ids: [child.id] })).toEqual([
      "subagent wait 900c096e", "✓ completed · 8s",
    ]);
  });
  test("status lists identify every child and task on one line each", () => {
    const second = { ...child, id: "abcd1234-0000", prompt: "Second task" };
    expect(lines("status", { command: "status" }, false, [child, second])).toEqual([
      "subagent status", "✓ 900c096e completed · 8s · Read the package version.", "✓ abcd1234 completed · 8s · Second task",
    ]);
  });
  test("expansion exposes full identity, context, output, and usage", () => {
    const text = lines("wait", { command: "wait", ids: [child.id] }, true).join("\n");
    expect(text.match(new RegExp(child.id, "g"))).toHaveLength(1);
    for (const value of [child.prompt, child.output!, "cwd: /project", "tools: read", "2 turns", "test/model"]) expect(text).toContain(value);
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
  test("detail budgets preserve truthful truncation metadata and bounded diagnostics", () => {
    const output = "界".repeat(1000);
    const large: ChildResult = { ...child, output, stdout: "x".repeat(10000),
      outputTruncation: { truncated: false, originalBytes: Buffer.byteLength(output), retainedBytes: Buffer.byteLength(output) },
    };
    const details = boundDetails({ command: "wait", results: [large] }, 1800);
    const bounded = details.results[0]!;
    expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThanOrEqual(1800);
    expect(bounded.outputTruncation).toEqual({ truncated: true, originalBytes: Buffer.byteLength(output), retainedBytes: Buffer.byteLength(bounded.output ?? "") });
    expect(large.outputTruncation?.truncated).toBe(false);
    expect(bounded.stdout).toBeDefined();
  });
  test("narrow terminals keep one bounded preview row per child", () => {
    const long = { ...child, output: "wide界🙂 ".repeat(1000) };
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
  test("completion is a one-line notice with details available on expansion", () => {
    const message = { role: "custom" as const, customType: "subagent-complete", content: "Full model-facing message", display: true, timestamp: 0, details: result("wait").details };
    const before = JSON.stringify(message);
    const compact = renderChildCompletion(message, { expanded: false, outputPad: 1 }, theme)!;
    expect(compact.render(80).map((line) => line.trim())).toEqual(["✓ subagent 900c096e completed · 8s"]);
    expect(compact.render(20)).toHaveLength(1);
    const full = renderChildCompletion(message, { expanded: true, outputPad: 1 }, theme)!.render(80).join("\n");
    expect(full).toContain(child.id);
    expect(full).toContain(child.output!);
    expect(full).toContain(child.prompt);
    expect(JSON.stringify(message)).toBe(before);
  });
});
