import type { AgentToolResult, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { truncateHeadTail, truncateOutput } from "./bounds.ts";
import { MAX_OUTPUT_BYTES, MAX_RETAINED_RUNS } from "./limits.ts";
import { activitySummary, formatElapsed, isTimeoutSummary, lastActivitySummary, resultText, runtimeLabel } from "./reports.ts";
import type { SubagentDetails } from "./types.ts";
import { Check } from "typebox/value";
import { ChildResultSchema } from "./result-schema.ts";
import { failed, isOutputTruncation } from "./types.ts";
import type { ChildResult, UsageSummary } from "./types.ts";

interface ChildRenderContext {
  expanded: boolean;
  args: { id?: unknown; ids?: unknown };
}

function isRenderableChildResult(value: unknown): value is ChildResult {
  return Check(ChildResultSchema, value)
    && (value.outputTruncation === undefined || isOutputTruncation(value.outputTruncation));
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageSummary, model?: string): string {
  const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  if (model) parts.push(stripTerminalControls(model));
  return parts.join(" ");
}

/** Keep untrusted agent text from emitting terminal control sequences in the TUI. */
export function stripTerminalControls(value: string): string {
  return value
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001BP[\s\S]*?(?:\u0007|\u001B\\)/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function clean(value: string, bytes = MAX_OUTPUT_BYTES): string {
  return stripTerminalControls(truncateOutput(value, bytes));
}

function oneLine(text: string): string {
  return stripTerminalControls(text).replace(/\s+/g, " ").trim();
}

function oneLineBounded(text: string, bytes: number): string {
  return truncateOutput(oneLine(text), bytes).replace(/\s+/g, " ").trim();
}

/** Human-facing /subagents list: live work first, then oldest starts. */
export function childListText(results: readonly ChildResult[]): string {
  const ordered = [...results].sort((left, right) => {
    const running = Number(right.state.status === "running") - Number(left.state.status === "running");
    return running || (left.startedAt ?? 0) - (right.startedAt ?? 0);
  });
  return ordered.map((result) => {
    const status = result.state.status === "running"
      ? `${result.phase ?? "starting"}${result.startedAt ? ` · ${Math.max(0, Math.round((Date.now() - result.startedAt) / 1000))}s` : ""}`
      : result.state.outcome;
    const handle = result.handle ?? result.id.slice(0, 8);
    const notify = result.notify === "turn" ? " · turn" : "";
    return `${handle} [${status}]${notify} · ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"} · ${oneLineBounded(result.cwd, 512)}`;
  }).join("\n");
}

/**
 * Collapsed rows are human-facing: a task label while it identifies live work
 * or a status listing, otherwise only a failure diagnostic. Successful reports
 * are agent-facing content and stay behind expansion.
 */
function collapsedPreview(child: ChildResult, command: SubagentDetails["command"] | undefined): string {
  const statusList = command === "status";
  if (child.state.status === "running" || statusList) return child.omittedFields?.includes("prompt") ? "task not retained" : oneLine(child.prompt);
  if (child.state.outcome === "completed") return "";
  // The timeout heading already says what happened and how long it ran; the
  // expanded view carries the elapsed/deadline summary.
  if (child.state.outcome === "timed_out" && isTimeoutSummary(child.errorMessage)) return "";
  const genericCancellation = child.state.outcome === "cancelled" && /^subagent cancelled\.?$/i.test(child.errorMessage?.trim() ?? "");
  const cause = genericCancellation
    ? child.stderr || child.stdout
    : child.errorMessage || child.stderr || child.stdout;
  return cause ? oneLine(clean(cause, 1024)) : "";
}

/** IDs are abbreviated only for display; tool arguments and retained data stay exact. */
function displayId(id: string, expanded = false): string {
  const text = clean(id, 256).replace(/\s+/g, " ");
  return expanded ? text : text.slice(0, 8);
}

function singleLine(text: string): Component {
  return { render: (width) => [truncateToWidth(text, width)], invalidate() {} };
}

function targetId(args: ChildRenderContext["args"]): string | undefined {
  if (typeof args.id === "string") return args.id;
  return Array.isArray(args.ids) && args.ids.length === 1 && typeof args.ids[0] === "string" ? args.ids[0] : undefined;
}

export function renderChildCall(args: Record<string, unknown>, theme: Theme, context?: ChildRenderContext): Component {
  const expanded = context?.expanded ?? false;
  const command = typeof args.command === "string" ? clean(args.command, 64).replace(/\s+/g, " ") : "";
  const target = targetId(args);
  const id = target ? ` ${displayId(target, expanded)}` : Array.isArray(args.ids) ? ` · ${args.ids.length} children` : "";
  const container = new Container();
  container.addChild(new Text(theme.fg("toolTitle", theme.bold(`subagent ${command}${id}`)), 0, 0));
  // Prompts and steering messages are agent-facing instruction text; humans see
  // them only on expansion. Steering shows its message, never the original task.
  const detail = command === "steer" ? args.message : args.prompt;
  if (expanded && typeof detail === "string" && detail) {
    container.addChild(new Text(theme.fg("dim", clean(detail, 8192)), 0, 0));
  }
  return container;
}

function renderOutput(text: string, expanded: boolean, theme: Theme): Component {
  if (expanded) return new Markdown(text, 0, 0, getMarkdownTheme());
  const preview = new Text(text, 0, 0);
  return {
    render(width) {
      const lines = preview.render(width);
      if (lines.length <= 5) return lines;
      const key = keyText("app.tools.expand");
      return [...lines.slice(0, 5), truncateToWidth(theme.fg("dim", `… ${key ? `${key} to expand` : "expand for more"}`), width)];
    },
    invalidate() { preview.invalidate(); },
  };
}

function childHeading(child: ChildResult, theme: Theme, options: { expanded: boolean; showId: boolean; command?: SubagentDetails["command"] }): string {
  const { expanded, showId, command } = options;
  const active = child.state.status === "running";
  const outcome = child.state.status === "terminal" ? child.state.outcome : undefined;
  const status = active
    ? child.phase === "starting" || child.phase === "stopping" ? child.phase : command === "spawn" ? "started" : "running"
    : outcome!.replaceAll("_", " ");
  const color = active ? "muted" : outcome === "cancelled" || outcome === "incomplete" ? "warning" : failed(child) ? "error" : "success";
  const icon = active ? "○" : outcome === "cancelled" ? "−" : outcome === "incomplete" ? "!" : failed(child) ? "✗" : "✓";
  const id = showId ? `${theme.fg("accent", displayId(child.handle ?? child.id, expanded))} ` : "";
  // Spawn/status/wait are snapshots, not live activity indicators.
  const duration = active && command !== "run" ? "" : runtimeLabel(child);
  const activity = active && child.activity
    ? ` · ${child.activity}${child.currentTool ? `: ${oneLine(clean(child.currentTool, 256))}` : ""}` : "";
  return `${theme.fg(color, icon)} ${id}${theme.fg(color, status)}${duration ? theme.fg("dim", ` · ${duration}`) : ""}${theme.fg("dim", activity)}`;
}

function renderChildren(details: unknown, expanded: boolean, theme: Theme, targetId?: string): Component | undefined {
  const data = details as Partial<SubagentDetails> | undefined;
  const results = Array.isArray(data?.results) ? data.results.slice(0, MAX_RETAINED_RUNS) : [];
  if (!results.length || !results.every(isRenderableChildResult)) return undefined;
  const container = new Container();
  let remaining = MAX_OUTPUT_BYTES;
  let runningCount = 0;
  for (const child of results) {
    const active = child.state.status === "running";
    if (active) runningCount++;
    const targeted = targetId !== undefined && (child.id === targetId || child.handle === targetId);
    const heading = childHeading(child, theme, { expanded, showId: !targeted, command: data?.command });
    if (expanded) {
      container.addChild(new Text(heading, 0, 0));
    } else {
      // One status line per child: outcome, duration, and a single-line preview.
      const preview = collapsedPreview(child, data?.command);
      container.addChild(singleLine(preview ? `${heading} · ${theme.fg("dim", preview)}` : heading));
    }
    if (expanded) {
      // The heading already carries live activity; expansion adds only the last time.
      const activity = active && child.activity ? lastActivitySummary(child) : activitySummary(child);
      if (activity) container.addChild(new Text(theme.fg("dim", clean(activity, 512)), 0, 0));
      // Status/wait/stop rows need task labels; run/spawn/steer payloads are in their call header.
      if (data?.command !== "run" && data?.command !== "spawn" && data?.command !== "steer") {
        container.addChild(new Text(theme.fg("dim", child.omittedFields?.includes("prompt") ? "Task prompt omitted to fit the response budget." : clean(child.prompt, 8192)), 0, 0));
      }
      const report = resultText(child);
      let renderedReport = "";
      if (!active) {
        const output = truncateOutput(report, remaining);
        remaining = Math.max(0, remaining - Buffer.byteLength(output, "utf8"));
        renderedReport = stripTerminalControls(output).trimEnd();
        container.addChild(renderOutput(renderedReport, true, theme));
      }
      if (child.outputTruncation?.truncated) {
        container.addChild(new Text(theme.fg("warning", `Output shortened: ${child.outputTruncation.retainedBytes}/${child.outputTruncation.originalBytes} UTF-8 bytes retained.`), 0, 0));
      }
      for (const [label, value] of [["stderr", child.stderr], ["stdout", child.stdout]] as const) {
        if (!value || remaining <= 0) continue;
        // resultText may already embed the retained diagnostic. Keep the row only
        // when it contributes content that the bounded report does not contain.
        const safeValue = stripTerminalControls(value).trim();
        if (!safeValue || value === report || renderedReport.includes(safeValue)) continue;
        const diagnostic = truncateHeadTail(value, Math.min(remaining, 2048));
        remaining = Math.max(0, remaining - Buffer.byteLength(diagnostic));
        container.addChild(new Text(theme.fg("dim", `${label}: ${stripTerminalControls(diagnostic)}`), 0, 0));
      }
      const cwd = child.omittedFields?.includes("cwd") ? "not retained (response budget)" : clean(child.cwd, 1024);
      const tools = child.omittedFields?.includes("tools") ? "not retained (response budget)" : clean(child.tools.join(", "), 1024) || "none";
      const session = child.sessionFile ? `\nsession: ${clean(child.sessionFile, 1024)}` : "";
      container.addChild(new Text(theme.fg("dim", `cwd: ${cwd}\ntools: ${tools}${session}`), 0, 0));
      if (!active) {
        const cleanup = child.cleanupMs ? ` · cleanup ${formatElapsed(child.cleanupMs)}` : "";
        container.addChild(new Text(theme.fg("dim", formatUsage(child.usage, child.model ? clean(child.model, 256) : undefined) + (child.thinking ? ` · thinking: ${child.thinking}` : "") + cleanup), 0, 0));
      }
    }
  }
  // A join result has one continuation state, not one notice per live child.
  if (data?.command === "wait" && runningCount > 0) {
    const notice = data.waitExpired === false
      ? runningCount === 1 ? "Child continues." : "Children continue."
      : runningCount === 1 ? "Wait expired; child continues." : "Wait expired; children continue.";
    container.addChild(new Text(theme.fg("dim", notice), 0, 0));
  }
  return container;
}

export function renderChildResult(result: AgentToolResult<SubagentDetails>, { expanded }: { expanded: boolean }, theme: Theme, context?: ChildRenderContext): Component {
  const rendered = renderChildren(result.details, expanded, theme, context?.args ? targetId(context.args) : undefined);
  if (rendered) return rendered;
  const text = result.content[0];
  return renderOutput(text?.type === "text" && typeof text.text === "string" ? clean(text.text) : "(no output)", expanded, theme);
}

export const renderChildNotice: MessageRenderer = (message, { outputPad }) =>
  new Text(typeof message.content === "string" ? clean(message.content) : "Child results ready; use subagent wait.", outputPad, 0);
