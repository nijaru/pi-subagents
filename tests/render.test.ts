import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension from "../extensions/pi-subagents/index.ts";
import { renderChildCall, renderChildResult, renderChildCompletion, stripTerminalControls } from "../extensions/pi-subagents/render.ts";
import { emptyUsage, type ChildResult, type SubagentDetails } from "../extensions/pi-subagents/types.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const child: ChildResult = {
  id: "900c096e-a585-4c0f-9089-25ada5a73466", prompt: "Read the package version.", cwd: "/project", tools: ["read"],
  output: "pi-subagents 0.1.0", exitCode: 0, termination: "completed", startedAt: 0, finishedAt: 8000,
  stderr: "", messages: [], usage: { ...emptyUsage(), turns: 2 }, model: "test/model",
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
    const row = new ToolExecutionComponent("subagent", "test-call", { command: "wait", id: child.id }, {}, tool, { requestRender() {} } as TUI, "/project");
    row.updateResult({ ...result("wait"), isError: false });
    const compact = row.render(80).map((line) => stripTerminalControls(line).trim()).filter(Boolean);
    expect(compact).toEqual(["subagent wait 900c096e", "✓ completed · 8s", child.output!]);
    row.setExpanded(true);
    const full = stripTerminalControls(row.render(80).join("\n"));
    expect(full.match(new RegExp(child.id, "g"))).toHaveLength(1);
    expect(full).toContain("2 turns");
    row.setExpanded(false);
    expect(row.render(40).map((line) => stripTerminalControls(line).trim()).filter(Boolean)).toEqual(compact);
  });
  test("foreground prompt appears once, with short ID and no trailing spacer or usage", () => {
    expect(lines("run", { command: "run", prompt: child.prompt })).toEqual([
      "subagent run", child.prompt, "✓ 900c096e completed · 8s", child.output!,
    ]);
  });
  test("targeted status and wait show the ID only in the call header", () => {
    expect(lines("status", { command: "status", id: child.id })).toEqual([
      "subagent status 900c096e", "✓ completed · 8s", child.prompt,
    ]);
    expect(lines("wait", { command: "wait", id: child.id })).toEqual([
      "subagent wait 900c096e", "✓ completed · 8s", child.output!,
    ]);
  });
  test("status lists identify every child and task without outputs or blank rows", () => {
    const second = { ...child, id: "abcd1234-0000", prompt: "Second task" };
    expect(lines("status", { command: "status" }, false, [child, second])).toEqual([
      "subagent status", "✓ 900c096e completed · 8s", child.prompt, "✓ abcd1234 completed · 8s", "Second task",
    ]);
  });
  test("expansion exposes full identity, context, output, and usage", () => {
    const text = lines("wait", { command: "wait", id: child.id }, true).join("\n");
    expect(text.match(new RegExp(child.id, "g"))).toHaveLength(1);
    for (const value of [child.prompt, child.output!, "cwd: /project", "tools: read", "2 turns", "test/model"]) expect(text).toContain(value);
  });
  test("spawn omits duplicate prompt and wait expiry stays explicit", () => {
    const active = { ...child, exitCode: -1, termination: undefined, startedAt: undefined, finishedAt: undefined };
    expect(lines("spawn", { command: "spawn", prompt: child.prompt }, false, [active])).toEqual([
      "subagent spawn", child.prompt, "○ 900c096e started",
    ]);
    expect(lines("wait", { command: "wait", id: child.id }, false, [active])).toEqual([
      "subagent wait 900c096e", "○ running", "Wait expired; child continues.",
    ]);
  });
  test("old spawn and status snapshots do not acquire a live elapsed timer", () => {
    const active = { ...child, exitCode: -1, termination: undefined, startedAt: 0, finishedAt: undefined };
    for (const command of ["spawn", "status", "wait"] as const) {
      const text = lines(command, { command }, false, [active]).join("\n");
      expect(text).not.toContain("elapsed");
      expect(text).not.toContain(" · ");
    }
  });
  test("failed, timed-out and cancelled children remain distinguishable", () => {
    for (const termination of ["failed", "timed_out", "cancelled"] as const) {
      const failed = { ...child, exitCode: 1, termination, errorMessage: "Reason for stopping" };
      const text = lines("stop", { command: "stop", id: child.id }, false, [failed]).join("\n");
      expect(text).toContain(termination.replaceAll("_", " "));
      expect(text).toContain("Reason for stopping");
      expect(text).not.toContain(child.output!);
    }
  });
  test("narrow terminals cap visual output rows and label truncation", () => {
    const long = { ...child, output: "wide界🙂 ".repeat(1000) };
    for (const width of [20, 40, 80, 120]) {
      const rows = renderChildResult(result("run", [long]), { expanded: false }, theme).render(width);
      expect(rows.length).toBeLessThanOrEqual(8);
      expect(stripTerminalControls(rows.at(-1)!)).toContain("…");
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  });
  test("multiline prompts occupy one preview row and controls are stripped", () => {
    const rows = renderChildCall({ command: "run", prompt: "hello\n\tworld\x1b[31m " + "x".repeat(500) }, theme).render(40);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("hello world");
    expect(rows.join("")).not.toContain("\x1b[31m");
    expect(visibleWidth(rows[1]!)).toBeLessThanOrEqual(40);
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
