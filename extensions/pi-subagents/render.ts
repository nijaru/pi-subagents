import type { AgentToolResult, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { truncateHeadTail, truncateOutput } from "./bounds.ts";
import { MAX_OUTPUT_BYTES, MAX_RETAINED_RUNS } from "./limits.ts";
import { failed, resultText } from "./supervisor.ts";
import type { SubagentDetails } from "./types.ts";
import { isFiniteNumber, isOutputTruncation } from "./types.ts";
import type { ChildResult, UsageSummary } from "./types.ts";

interface ChildRenderContext {
  expanded: boolean;
  args: { id?: unknown };
}

export function isRenderableUsage(value: unknown): value is UsageSummary {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  const cost = usage.cost;
  return ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "turns"].every((key) => isFiniteNumber(usage[key]))
    && !!cost && typeof cost === "object"
    && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => isFiniteNumber((cost as Record<string, unknown>)[key]));
}

export function isRenderableChildResult(value: unknown): value is ChildResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ChildResult>;
  return typeof result.id === "string"
    && typeof result.prompt === "string"
    && typeof result.cwd === "string"
    && Array.isArray(result.tools) && result.tools.every((tool) => typeof tool === "string")
    && (result.output === undefined || typeof result.output === "string")
    && (result.stdout === undefined || typeof result.stdout === "string")
    && (result.outputTruncation === undefined || isOutputTruncation(result.outputTruncation))
    && (result.errorMessage === undefined || typeof result.errorMessage === "string")
    && (result.model === undefined || typeof result.model === "string")
    && isFiniteNumber(result.startedAt ?? 0)
    && (result.state?.status === "running"
      || (result.state?.status === "terminal"
        && (result.state.outcome === "completed" || result.state.outcome === "incomplete" || result.state.outcome === "failed" || result.state.outcome === "cancelled" || result.state.outcome === "timed_out")
        && isFiniteNumber(result.state.exitCode)
        && isFiniteNumber(result.state.finishedAt)))
    && typeof result.stderr === "string"
    && isRenderableUsage(result.usage);
}

export function formatDuration(startedAt?: number, finishedAt?: number): string | undefined {
  if (!isFiniteNumber(startedAt)) return undefined;
  const end = isFiniteNumber(finishedAt) ? finishedAt : Date.now();
  const totalSeconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds}s`;
}

export function runtimeLabel(result: ChildResult): string {
  const duration = formatDuration(result.startedAt, result.state.status === "terminal" ? result.state.finishedAt : undefined);
  if (!duration) return "";
  return `${duration}${result.state.status === "running" ? " elapsed" : ""}`;
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

/** IDs are abbreviated only for display; tool arguments and retained data stay exact. */
function displayId(id: string, expanded = false): string {
  const text = clean(id, 256).replace(/\s+/g, " ");
  return expanded ? text : text.slice(0, 8);
}

function singleLine(text: string): Component {
  return { render: (width) => [truncateToWidth(text, width)], invalidate() {} };
}

export function renderChildCall(args: Record<string, unknown>, theme: Theme, context?: ChildRenderContext): Component {
  const expanded = context?.expanded ?? false;
  const command = typeof args.command === "string" ? clean(args.command, 64).replace(/\s+/g, " ") : "";
  const id = typeof args.id === "string" ? ` ${displayId(args.id, expanded)}` : "";
  const container = new Container();
  container.addChild(new Text(theme.fg("toolTitle", theme.bold(`subagent ${command}${id}`)), 0, 0));
  if (typeof args.prompt === "string" && args.prompt) {
    const prompt = clean(args.prompt, expanded ? 8192 : 1024);
    container.addChild(expanded
      ? new Text(theme.fg("dim", prompt), 0, 0)
      : singleLine(theme.fg("dim", prompt.replace(/\s+/g, " "))));
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

function childHeading(child: ChildResult, theme: Theme, options: { expanded: boolean; showId: boolean; notification: boolean; command?: SubagentDetails["command"] }): string {
  const { expanded, showId, notification, command } = options;
  const active = child.state.status === "running";
  const outcome = child.state.status === "terminal" ? child.state.outcome : undefined;
  const status = active ? command === "spawn" ? "started" : "running" : outcome!.replaceAll("_", " ");
  const color = active ? "muted" : outcome === "cancelled" || outcome === "incomplete" ? "warning" : failed(child) ? "error" : "success";
  const icon = active ? "○" : outcome === "cancelled" ? "−" : outcome === "incomplete" ? "!" : failed(child) ? "✗" : "✓";
  const id = showId ? `${theme.fg("accent", displayId(child.id, expanded))} ` : "";
  // Spawn/status/wait are snapshots, not live activity indicators.
  const duration = active && command !== "run" ? "" : runtimeLabel(child);
  return `${theme.fg(color, icon)} ${notification ? "subagent " : ""}${id}${theme.fg(color, status)}${duration ? theme.fg("dim", ` · ${duration}`) : ""}`;
}

function renderChildren(details: unknown, expanded: boolean, theme: Theme, targetId?: string, notification = false): Component | undefined {
  const data = details as Partial<SubagentDetails> | undefined;
  const results = Array.isArray(data?.results) ? data.results.slice(0, MAX_RETAINED_RUNS) : [];
  if (!results.length || !results.every(isRenderableChildResult)) return undefined;
  const container = new Container();
  let remaining = MAX_OUTPUT_BYTES;
  for (const child of results) {
    const active = child.state.status === "running";
    const heading = childHeading(child, theme, { expanded, showId: notification || child.id !== targetId, notification, command: data?.command });
    container.addChild(notification && !expanded ? singleLine(heading) : new Text(heading, 0, 0));
    // Status lists need task labels; run/spawn already show the prompt in their call header.
    if (data?.command !== "run" && data?.command !== "spawn" && (expanded || (!notification && data?.command === "status"))) {
      const prompt = clean(child.prompt, expanded ? 8192 : 1024);
      container.addChild(expanded ? new Text(theme.fg("dim", prompt), 0, 0) : singleLine(theme.fg("dim", prompt.replace(/\s+/g, " "))));
    }
    if (active && data?.command === "wait") {
      container.addChild(new Text(theme.fg("dim", "Wait expired; child continues."), 0, 0));
    }
    if (!active && (expanded || (!notification && data?.command !== "status"))) {
      const output = truncateOutput(resultText(child), remaining);
      remaining = Math.max(0, remaining - Buffer.byteLength(output, "utf8"));
      container.addChild(renderOutput(stripTerminalControls(output).trimEnd(), expanded, theme));
    }
    if (expanded) {
      if (child.outputTruncation?.truncated) {
        container.addChild(new Text(theme.fg("warning", `Output shortened: ${child.outputTruncation.retainedBytes}/${child.outputTruncation.originalBytes} UTF-8 bytes retained.`), 0, 0));
      }
      for (const [label, value] of [["stderr", child.stderr], ["stdout", child.stdout]] as const) {
        if (!value || value === resultText(child) || remaining <= 0) continue;
        const diagnostic = truncateHeadTail(value, Math.min(remaining, 2048));
        remaining -= Buffer.byteLength(diagnostic);
        container.addChild(new Text(theme.fg("dim", `${label}: ${stripTerminalControls(diagnostic)}`), 0, 0));
      }
      container.addChild(new Text(theme.fg("dim", `cwd: ${clean(child.cwd, 1024)}\ntools: ${clean(child.tools.join(", "), 1024) || "none"}`), 0, 0));
      if (!active) container.addChild(new Text(theme.fg("dim", formatUsage(child.usage, child.model ? clean(child.model, 256) : undefined)), 0, 0));
    }
  }
  return container;
}

export function renderChildResult(result: AgentToolResult<SubagentDetails>, { expanded }: { expanded: boolean }, theme: Theme, context?: ChildRenderContext): Component {
  const rendered = renderChildren(result.details, expanded, theme, typeof context?.args?.id === "string" ? context.args.id : undefined);
  if (rendered) return rendered;
  const text = result.content[0];
  return renderOutput(text?.type === "text" && typeof text.text === "string" ? clean(text.text) : "(no output)", expanded, theme);
}

export const renderChildCompletion: MessageRenderer = (message, { expanded, outputPad }, theme) => {
  const rendered = renderChildren(message.details, expanded, theme, undefined, true);
  if (!rendered) return new Text(typeof message.content === "string" ? clean(message.content) : "Background child finished.", outputPad, 0);
  const box = new Box(outputPad, 0, (text) => theme.bg("customMessageBg", text));
  box.addChild(rendered);
  return box;
};
