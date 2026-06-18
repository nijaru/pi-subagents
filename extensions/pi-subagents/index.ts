/**
 * pi-subagents — Clean declarative agent delegation for pi.
 *
 * Three patterns: single spawn, sequential chain, parallel fan-out.
 * Quality gates between chain steps.
 * Agent definitions: markdown files with YAML frontmatter.
 * Context isolation by default. Bounded depth (default 3).
 * Background execution with status/wait/resume. Run persistence across restarts.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { type ExtensionAPI, type ExtensionContext, createAgentSession, type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Types ───────────────────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  execution?: "inline" | "subprocess";
  tools?: string[];
  systemPrompt: string;
  source: "bundled" | "user" | "project";
}

/** Parsed message from pi's JSON event stream. */
interface AgentMessage {
  role: "assistant" | "user" | "tool";
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  toolResult?: { name: string; output: string };
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface RunResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  cost: number;
  duration: number;
  messages: AgentMessage[];
  turns: number;
  model?: string;
  stopReason?: string;
  sessionPath?: string;
  sessionId?: string;
}

interface RunRecord {
  id: string;
  agent: string;
  task: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  sessionPath: string;
  result?: RunResult;
  // Not persisted — only for live processes
  proc?: ReturnType<typeof spawn>;
}

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean };

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_DEPTH = 3;
const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4; // limit concurrent subprocess spawns
const MAX_RETRIES = 3;
const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB per agent output
const PER_TASK_OUTPUT_CAP = 50 * 1024; // 50KB per task in parallel mode
const DEFAULT_GATE_TIMEOUT_MS = 30_000;
const DEPTH_ENV = "PI_SUBAGENT_DEPTH";

// ── State ───────────────────────────────────────────────────────────────────

const runs = new Map<string, RunRecord>();

function runsFilePath(): string {
  return path.join(os.homedir(), ".pi", "agent", "subagent-runs.json");
}

/** Atomic write: write to temp file, then rename. */
function persistRuns(): void {
  const entries: Array<Omit<RunRecord, "proc">> = [];
  for (const r of runs.values()) {
    const { proc: _, ...rest } = r;
    entries.push(rest);
  }
  try {
    const fp = runsFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(entries));
    fs.renameSync(tmp, fp);
  } catch {}
}

function loadRuns(): void {
  try {
    const data = JSON.parse(fs.readFileSync(runsFilePath(), "utf-8"));
    if (!Array.isArray(data)) return;
    for (const r of data) {
      if (r.id && r.sessionPath) runs.set(r.id, r as RunRecord);
    }
  } catch {}
}

/** Reconcile persisted running records: if session file exists with output, mark completed. */
function reconcileRuns(): void {
  let changed = false;
  for (const [id, r] of runs) {
    if (r.status !== "running") continue;
    // If we have a live process, leave it alone
    if (r.proc) continue;
    // Check if session file has output (process completed while we were away)
    const session = readSessionOutput(r.sessionPath);
    if (session.output) {
      r.status = "completed";
      r.result = {
        agent: r.agent, task: r.task, exitCode: 0,
        output: truncate(session.output, MAX_OUTPUT_BYTES), stderr: "",
        cost: session.cost, duration: Date.now() - r.startedAt, sessionPath: r.sessionPath,
        messages: [], turns: 0,
      };
      changed = true;
    } else if (!fs.existsSync(r.sessionPath)) {
      // Session dir gone — stale run
      runs.delete(id);
      changed = true;
    }
    // else: still running or no output yet, leave as-is
  }
  if (changed) persistRuns();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const ok = (text: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text }], details });
const err = (text: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text }], details, isError: true });

function genId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function getDepth(): number {
  const v = parseInt(process.env[DEPTH_ENV] ?? "0", 10);
  return isNaN(v) ? 0 : v;
}

function childEnv(depth: number): NodeJS.ProcessEnv {
  return { ...process.env, [DEPTH_ENV]: String(depth) };
}

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf-8") <= maxBytes) return s;
  // Binary search for the right cutoff point — O(n log n) vs O(n²) char-by-char
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf-8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}\n[truncated — ${Buffer.byteLength(s, "utf-8")} bytes total]`;
}

/** Find newest session JSONL file by modification time. */
function findSessionFile(sessionDir: string): string | undefined {
  try {
    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? path.join(sessionDir, files[0]!.name) : undefined;
  } catch {
    return undefined;
  }
}

function parseSessionFile(sessionPath: string): { output: string; cost: number } {
  let output = "", cost = 0;
  try {
    const content = fs.readFileSync(sessionPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const texts: string[] = [];
        for (const p of ev.message.content ?? []) { if (p.type === "text") texts.push(p.text); }
        if (texts.length) output = texts.join("\n");
        cost += ev.message.usage?.cost?.total ?? 0;
      }
    }
  } catch {}
  return { output, cost };
}

function readSessionOutput(sessionDir: string): { output: string; cost: number } {
  const file = findSessionFile(sessionDir);
  return file ? parseSessionFile(file) : { output: "", cost: 0 };
}

function fmtRunStatus(r: RunRecord): string {
  const elapsed = Date.now() - r.startedAt;
  const ms = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
  const cost = r.result?.cost;
  const costStr = cost ? ` $${cost.toFixed(4)}` : "";
  return `${r.agent} [${r.status}] (${ms}${costStr}) id:${r.id}`;
}

function findRun(id: string): RunRecord | { ambiguous: string[] } | undefined {
  const exact = runs.get(id);
  if (exact) return exact;
  const matches = Array.from(runs.values()).filter(r => r.id.startsWith(id));
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0]!;
  return { ambiguous: matches.map(r => r.id) };
}

/** Kill a process group (not just the direct child). */
function killProc(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (proc.pid && typeof proc.pid === "number") {
      // Kill the process group (negative pid)
      process.kill(-proc.pid, signal);
    }
  } catch {
    try { proc.kill(signal); } catch {}
  }
}

// ── Agent Discovery ─────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const s = content.replace(/\r\n/g, "\n");
  if (!s.startsWith("---")) return { meta: {}, body: s };
  const end = s.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: s };
  const meta: Record<string, string> = {};
  for (const line of s.slice(4, end).split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      let v = m[2]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      meta[m[1]!] = v;
    }
  }
  return { meta, body: s.slice(end + 4).trim() };
}

function loadAgents(dir: string, source: "bundled" | "user" | "project"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  const agents: AgentConfig[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.name.endsWith(".md") || !e.isFile()) continue;
    const fp = path.join(dir, e.name);
    let raw: string;
    try { raw = fs.readFileSync(fp, "utf-8"); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.name || !meta.description) continue;
    const tools = meta.tools?.split(",").map(t => t.trim()).filter(Boolean);
    const execution = meta.execution as "inline" | "subprocess" | undefined;
    agents.push({
      name: meta.name, description: meta.description,
      model: meta.model || undefined,
      execution: execution === "subprocess" ? "subprocess" : undefined, // default inline, only store if subprocess
      tools: tools?.length ? tools : undefined,
      systemPrompt: body, source,
    });
  }
  return agents;
}

function isProjectRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"))
    || fs.existsSync(path.join(dir, "package.json"))
    || fs.existsSync(path.join(dir, "Cargo.toml"))
    || fs.existsSync(path.join(dir, "go.mod"));
}

function discoverAgents(cwd: string): AgentConfig[] {
  const map = new Map<string, AgentConfig>();
  // 1. Bundled agents (lowest priority) — ships with the extension
  // import.meta.dir may be undefined in pi's extension loader
  const extensionDir = import.meta.dir ?? __dirname;
  let bundledDir: string;
  try {
    bundledDir = path.resolve(extensionDir, "..", "..", "agents");
  } catch {
    return []; // can't resolve bundled dir — skip
  }
  for (const a of loadAgents(bundledDir, "bundled")) map.set(a.name, a);
  // 2. User-level agents (override bundled)
  for (const a of loadAgents(path.join(os.homedir(), ".pi", "agents"), "user")) map.set(a.name, a);
  // 3. Project-level agents (highest priority)
  let dir = cwd;
  const home = os.homedir();
  while (true) {
    // Check both .pi/agents/ and agents/ at each level
    const piAgents = path.join(dir, ".pi", "agents");
    const agents = path.join(dir, "agents");
    let found = false;
    if (fs.existsSync(piAgents)) {
      for (const a of loadAgents(piAgents, "project")) map.set(a.name, a);
      found = true;
    }
    if (fs.existsSync(agents)) {
      for (const a of loadAgents(agents, "project")) map.set(a.name, a);
      found = true;
    }
    if (found) break;
    // Stop at project root or home directory to avoid walking to /
    if (isProjectRoot(dir) || dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return Array.from(map.values());
}

/** Find the .md file path for an agent by name. Walks up from cwd (like discoverAgents) then checks user global. */
function findAgentFile(cwd: string, name: string): string | undefined {
  // Walk up from cwd checking .pi/agents/ and agents/ at each level
  let dir = cwd;
  const home = os.homedir();
  while (true) {
    const piPath = path.join(dir, ".pi", "agents", `${name}.md`);
    if (fs.existsSync(piPath)) return piPath;
    const agentsPath = path.join(dir, "agents", `${name}.md`);
    if (fs.existsSync(agentsPath)) return agentsPath;
    if (isProjectRoot(dir) || dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Check user global
  const userPath = path.join(home, ".pi", "agents", `${name}.md`);
  if (fs.existsSync(userPath)) return userPath;
  return undefined;
}

// ── Subprocess Runner ───────────────────────────────────────────────────────

function getPiCmd(): { cmd: string; baseArgs: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { cmd: process.execPath, baseArgs: [script] };
  }
  const exec = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(exec)) return { cmd: "pi", baseArgs: [] };
  return { cmd: process.execPath, baseArgs: [] };
}

function resolveModel(agent: AgentConfig, overrideModel?: string): string | undefined {
  return overrideModel ?? agent.model;
}

/** Resolve model string to a Model object via the registry. */
function findModel(modelStr: string | undefined, ctx?: ExtensionContext): unknown {
  if (!modelStr || !ctx?.modelRegistry) return undefined;
  const [provider, ...rest] = modelStr.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) return undefined;
  return ctx.modelRegistry.find(provider, modelId);
}

function buildArgs(
  agent: AgentConfig, task: string, sessionDir: string, overrideModel?: string, opts?: { context?: "fresh" | "fork"; parentSessionFile?: string },
): { args: string[]; tmpFile?: string; cmd: string; baseArgs: string[] } {
  const { cmd, baseArgs } = getPiCmd();
  const args = [...baseArgs, "--mode", "json", "-p"];
  // Context mode: fork inherits parent session, fresh starts clean
  if (opts?.context === "fork" && opts.parentSessionFile) {
    args.push("--fork", opts.parentSessionFile);
  } else {
    args.push("--session-dir", sessionDir);
  }
  const model = resolveModel(agent, overrideModel);
  if (model) args.push("--model", model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
  let tmpFile: string | undefined;
  if (agent.systemPrompt.trim()) {
    tmpFile = path.join(sessionDir, "system-prompt.md");
    fs.writeFileSync(tmpFile, agent.systemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt", tmpFile);
  }
  args.push(`Task: ${task}`);
  return { args, tmpFile, cmd, baseArgs };
}

/** Shared spawn + parse logic for foreground runs. */
function spawnAndParse(
  cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; parseStdout?: boolean; onMessage?: (msg: AgentMessage) => void },
): Promise<{ exitCode: number; output: string; stderr: string; cost: number; messages: AgentMessage[]; turns: number; model?: string; stopReason?: string }> {
  const { cwd, env, signal, parseStdout = true, onMessage } = opts;
  return new Promise(resolve => {
    let output = "", stderr = "", cost = 0, turns = 0, model: string | undefined, stopReason: string | undefined;
    const messages: AgentMessage[] = [];
    let closed = false;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const stdio: ["ignore", "pipe" | "ignore", "pipe"] = parseStdout ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"];
    const proc = spawn(cmd, args, { cwd, shell: false, stdio, env });

    let buf = "";
    const processLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }

      // Capture tool calls from tool_use events (sub-agent invocations, file ops, etc.)
      if (ev.type === "tool_use" || ev.type === "tool_use_start") {
        const toolName = ev.name ?? ev.tool?.name ?? "unknown";
        const toolArgs = ev.input ?? ev.args ?? {};
        const msg: AgentMessage = { role: "assistant", toolCalls: [{ name: toolName, args: toolArgs }] };
        messages.push(msg);
        onMessage?.(msg);
      }

      // Capture tool results for visibility
      if (ev.type === "tool_result_end" || ev.type === "tool_result") {
        const toolName = ev.name ?? "tool";
        let toolOutput = "";
        if (typeof ev.result === "string") toolOutput = ev.result;
        else if (ev.result?.text) toolOutput = ev.result.text;
        else if (ev.content?.text) toolOutput = ev.content.text;
        const msg: AgentMessage = { role: "tool", toolResult: { name: toolName, output: truncate(toolOutput, 2048) } };
        messages.push(msg);
        onMessage?.(msg);
      }

      // Capture assistant messages (final text + usage)
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        turns++;
        const texts: string[] = [];
        for (const p of ev.message.content ?? []) {
          if (p.type === "text" && p.text) texts.push(p.text);
          if (p.type === "toolCall") {
            const toolName = p.name ?? "tool";
            const toolArgs = p.arguments ?? p.input ?? {};
            messages.push({ role: "assistant", toolCalls: [{ name: toolName, args: toolArgs }] });
          }
        }
        if (texts.length) output = texts.join("\n");
        const u = ev.message.usage;
        const usage = u ? { input: u.input ?? u.inputTokens ?? 0, output: u.output ?? u.outputTokens ?? 0, cacheRead: u.cacheRead ?? u.cache_read_input_tokens ?? 0, cacheWrite: u.cacheCreation ?? u.cache_write ?? 0, cost: u.cost?.total ?? u.cost ?? 0 } : undefined;
        if (usage) cost += usage.cost;
        if (ev.message.model) model = ev.message.model;
        if (ev.message.stopReason) stopReason = ev.message.stopReason;
        const msg: AgentMessage = { role: "assistant", text: output, usage, model: ev.message.model, stopReason: ev.message.stopReason };
        messages.push(msg);
        onMessage?.(msg);
      }

      // Capture error messages
      if (ev.type === "error") {
        const msg: AgentMessage = { role: "assistant", errorMessage: ev.message ?? ev.error ?? "Unknown error" };
        messages.push(msg);
        onMessage?.(msg);
      }
    };

    if (parseStdout && proc.stdout) {
      proc.stdout.on("data", d => {
        buf += d.toString();
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const l of lines) processLine(l);
      });
    }
    proc.stderr?.on("data", d => { stderr += d.toString(); });
    proc.on("close", c => {
      closed = true;
      if (killTimeout) clearTimeout(killTimeout);
      if (buf.trim()) processLine(buf);
      resolve({ exitCode: c ?? 0, output, stderr, cost, messages, turns, model, stopReason });
    });
    proc.on("error", () => { if (!closed) resolve({ exitCode: 1, output, stderr, cost, messages, turns, model, stopReason }); });

    if (signal) {
      const kill = () => {
        killProc(proc, "SIGTERM");
        killTimeout = setTimeout(() => { if (!closed) killProc(proc, "SIGKILL"); }, 5000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

/** Foreground run — blocks until the subprocess exits. */
async function runAgentSync(
  agents: AgentConfig[], name: string, task: string, cwd: string, depth: number, signal?: AbortSignal, overrideModel?: string, contextOpts?: { context?: "fresh" | "fork"; parentSessionFile?: string }, ctx?: ExtensionContext, overrideExecution?: "inline" | "subprocess",
): Promise<RunResult> {
  const agent = agents.find(a => a.name === name);
  if (!agent) {
    const avail = agents.map(a => `"${a.name}"`).join(", ") || "none";
    return { agent: name, task, exitCode: 1, output: "", stderr: `Unknown agent "${name}". Available: ${avail}`, cost: 0, duration: 0, messages: [], turns: 0 };
  }

  // Execution routing: param override > agent config > default (inline)
  const execution = overrideExecution ?? agent.execution;
  if (execution !== "subprocess") {
    return runAgentInLine(agent, task, cwd, overrideModel, signal, ctx); // contextOpts not applicable — inline shares parent memory
  }

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const { args, tmpFile, cmd } = buildArgs(agent, task, sessionDir, overrideModel, contextOpts);
  const start = Date.now();

  try {
    const raw = await spawnAndParse(cmd, args, { cwd, env: childEnv(depth), signal, parseStdout: true });
    let { output, cost } = raw;
    // Fallback: read from session file if stdout parsing missed output
    if (!output || cost === 0) {
      const session = readSessionOutput(sessionDir);
      if (!output && session.output) output = session.output;
      if (cost === 0 && session.cost > 0) cost = session.cost;
    }
    return {
      agent: name, task, exitCode: raw.exitCode,
      output: truncate(output, MAX_OUTPUT_BYTES), stderr: truncate(raw.stderr, MAX_OUTPUT_BYTES),
      cost, duration: Date.now() - start, sessionPath: sessionDir,
      messages: raw.messages, turns: raw.turns, model: raw.model, stopReason: raw.stopReason,
    };
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
  }
}

/** In-process run — uses createAgentSession() SDK API. Shared memory, no subprocess overhead. */
async function runAgentInLine(
  agent: AgentConfig, task: string, cwd: string, overrideModel?: string, signal?: AbortSignal, ctx?: ExtensionContext,
): Promise<RunResult> {
  const start = Date.now();
  let session: AgentSession | undefined;
  let abortHandler: (() => void) | undefined;

  try {
    // Resolve model: override > agent.model > inherit parent
    const modelStr = resolveModel(agent, overrideModel);
    let model: unknown = undefined;
    if (modelStr) {
      model = findModel(modelStr, ctx);
      if (!model) {
        // Model configured but not in registry — return a clear error
        return {
          agent: agent.name, task, exitCode: 1, output: "",
          stderr: `Model "${modelStr}" not found in registry. Check that the provider/model ID is correct and the API key is configured. Run 'pi models' to see available models.`,
          cost: 0, duration: Date.now() - start, messages: [], turns: 0,
        };
      }
    }

    // Prepend system prompt to task (createAgentSession doesn't accept systemPrompt)
    const fullTask = agent.systemPrompt.trim()
      ? `${agent.systemPrompt}\n\n---\n\nTask: ${task}`
      : task;

    // Create in-process session
    const result = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(),
      tools: agent.tools,
      ...(model ? { model: model as any } : {}),
    });
    session = result.session;

    // Handle abort signal — store reference for cleanup
    if (signal) {
      abortHandler = () => { session?.abort(); };
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    // Run the agent
    await session.prompt(fullTask);

    // Extract messages with tool calls, usage, and text
    const parsedMessages: AgentMessage[] = [];
    let output = "";
    let cost = 0;
    let turns = 0;
    let modelId: string | undefined;
    let stopReason: string | undefined;
    const rawMessages = session.messages as Array<{
      role: string;
      content?: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
      model?: string;
      stopReason?: string;
      // ToolResultMessage fields
      toolName?: string;
      toolCallId?: string;
    }>;

    for (const msg of rawMessages) {
      if (msg.role === "assistant") {
        turns++;
        const texts: string[] = [];
        const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
        for (const p of msg.content ?? []) {
          if (p.type === "text" && p.text) texts.push(p.text);
          if (p.type === "toolCall" && p.name) toolCalls.push({ name: p.name, args: p.arguments ?? {} });
        }
        if (texts.length) output = texts.join("\n");
        const u = msg.usage;
        const usage = u ? { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0 } : undefined;
        if (usage) cost += usage.cost;
        if (msg.model) modelId = msg.model;
        if (msg.stopReason) stopReason = msg.stopReason;
        parsedMessages.push({ role: "assistant", text: texts.join("\n") || undefined, toolCalls: toolCalls.length ? toolCalls : undefined, usage, model: msg.model, stopReason: msg.stopReason });
      }
      if (msg.role === "toolResult") {
        const toolName = msg.toolName ?? "tool";
        const texts: string[] = [];
        for (const p of msg.content ?? []) {
          if (p.type === "text" && p.text) texts.push(p.text);
        }
        parsedMessages.push({ role: "tool", toolResult: { name: toolName, output: truncate(texts.join("\n"), 2048) } });
      }
    }

    return {
      agent: agent.name, task, exitCode: 0,
      output: truncate(output, MAX_OUTPUT_BYTES), stderr: "",
      cost, duration: Date.now() - start, sessionId: session.sessionId,
      messages: parsedMessages, turns, model: modelId, stopReason,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      agent: agent.name, task, exitCode: 1, output: "", stderr: msg, cost: 0, duration: Date.now() - start, messages: [], turns: 0,
    };
  } finally {
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    session?.dispose();
  }
}

/** Background run — spawns detached, returns immediately. stdout ignored (read from session files). */
function runAgentAsync(
  agents: AgentConfig[], name: string, task: string, cwd: string, depth: number, overrideModel?: string, contextOpts?: { context?: "fresh" | "fork"; parentSessionFile?: string },
): RunRecord {
  const agent = agents.find(a => a.name === name);
  const id = genId();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));

  if (!agent) {
    const avail = agents.map(a => `"${a.name}"`).join(", ") || "none";
    const record: RunRecord = {
      id, agent: name, task, status: "failed", startedAt: Date.now(), sessionPath: sessionDir,
      result: { agent: name, task, exitCode: 1, output: "", stderr: `Unknown agent "${name}". Available: ${avail}`, cost: 0, duration: 0, messages: [], turns: 0 },
    };
    runs.set(id, record);
    persistRuns();
    return record;
  }

  const { args, tmpFile, cmd } = buildArgs(agent, task, sessionDir, overrideModel, contextOpts);
  // stdout ignored — we read from session files. This prevents pipe buffer hangs.
  const proc = spawn(cmd, args, {
    cwd, shell: false, stdio: ["ignore", "ignore", "pipe"],
    env: childEnv(depth), detached: true,
  });
  proc.unref();

  const record: RunRecord = {
    id, agent: name, task, status: "running", startedAt: Date.now(), sessionPath: sessionDir, proc,
  };
  runs.set(id, record);
  persistRuns();

  let stderr = "";
  proc.stderr.on("data", d => { stderr += d.toString(); });
  proc.on("close", code => {
    const session = readSessionOutput(sessionDir);
    record.status = code === 0 ? "completed" : "failed";
    record.result = {
      agent: name, task, exitCode: code ?? 1,
      output: truncate(session.output, MAX_OUTPUT_BYTES), stderr: truncate(stderr, MAX_OUTPUT_BYTES),
      cost: session.cost, duration: Date.now() - record.startedAt, sessionPath: sessionDir,
      messages: [], turns: 0,
    };
    record.proc = undefined;
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
    persistRuns();
  });
  proc.on("error", () => {
    record.status = "failed";
    record.result = {
      agent: name, task, exitCode: 1, output: "", stderr: stderr || "process error", cost: 0, messages: [], turns: 0,
      duration: Date.now() - record.startedAt, sessionPath: sessionDir,
    };
    record.proc = undefined;
    persistRuns();
  });

  return record;
}

/** Resume a completed or failed run with a follow-up message. */
async function resumeRun(
  run: RunRecord, message: string, cwd: string, signal?: AbortSignal,
): Promise<RunResult> {
  const sessionFile = findSessionFile(run.sessionPath);
  if (!sessionFile) {
    return { agent: run.agent, task: message, exitCode: 1, output: "", stderr: `No session file found in ${run.sessionPath}`, cost: 0, duration: 0, messages: [], turns: 0 };
  }

  const { cmd, baseArgs } = getPiCmd();
  const args = [...baseArgs, "--mode", "json", "-p", "--session", sessionFile, message];
  const start = Date.now();

  const raw = await spawnAndParse(cmd, args, { cwd, env: childEnv(getDepth()), signal, parseStdout: true });
  let { output, cost } = raw;
  // Fallback: read from session file
  if (!output || cost === 0) {
    const session = readSessionOutput(run.sessionPath);
    if (!output && session.output) output = session.output;
    if (cost === 0 && session.cost > 0) cost = session.cost;
  }

  return {
    agent: run.agent, task: message, exitCode: raw.exitCode,
    output: truncate(output, MAX_OUTPUT_BYTES), stderr: truncate(raw.stderr, MAX_OUTPUT_BYTES),
    cost, duration: Date.now() - start, sessionPath: run.sessionPath,
    messages: raw.messages, turns: raw.turns, model: raw.model, stopReason: raw.stopReason,
  };
}

// ── Gate Execution ──────────────────────────────────────────────────────────

async function runGate(
  gateCmd: string, stepOutput: string, cwd: string, timeoutMs: number, signal?: AbortSignal,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise(resolve => {
    let stderr = "";
    let closed = false;
    let gateTimeout: ReturnType<typeof setTimeout> | undefined;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const proc = spawn("sh", ["-c", gateCmd], {
      cwd, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SUBAGENT_OUTPUT: stepOutput },
      signal: signal?.aborted ? AbortSignal.abort() : undefined,
    });
    const cleanup = () => {
      if (gateTimeout) clearTimeout(gateTimeout);
      if (killTimeout) clearTimeout(killTimeout);
    };
    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("close", c => {
      closed = true;
      cleanup();
      resolve({ exitCode: c ?? 1, stderr: truncate(stderr, 1024) });
    });
    proc.on("error", () => { if (!closed) { cleanup(); resolve({ exitCode: 1, stderr: "gate process error" }); } });
    // Configurable timeout
    gateTimeout = setTimeout(() => {
      if (closed) return;
      killProc(proc, "SIGTERM");
      killTimeout = setTimeout(() => { if (!closed) killProc(proc, "SIGKILL"); }, 5000);
    }, timeoutMs);
    // Signal
    if (signal && !signal.aborted) {
      const onAbort = () => {
        if (closed) return;
        killProc(proc, "SIGTERM");
        killTimeout = setTimeout(() => { if (!closed) killProc(proc, "SIGKILL"); }, 5000);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ── Concurrency ─────────────────────────────────────────────────────────────

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await fn(item, i);
    }
  }));
  return results;
}

function fmtResult(r: RunResult): string {
  const icon = r.exitCode === 0 ? "✓" : "✗";
  const ms = r.duration < 1000 ? `${r.duration}ms` : `${(r.duration / 1000).toFixed(1)}s`;
  const c = r.cost > 0 ? ` $${r.cost.toFixed(4)}` : "";
  const t = r.turns > 0 ? ` ${r.turns}t` : "";
  const tc = r.messages.filter(m => m.toolCalls?.length).length;
  const tcStr = tc > 0 ? ` ${tc}tc` : "";
  return `${icon} ${r.agent} (${ms}${c}${t}${tcStr})`;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Load and reconcile persisted runs on startup
  loadRuns();
  reconcileRuns();

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: agent+task (single), chain[...] (sequential), tasks[...] (parallel, max 8). Use exactly one.",
      "Actions: list (agents), status/wait (background runs), resume (follow-up), interrupt (cancel). Set action, omit mode.",
      "Agent management: create/update/delete define NEW agent types (.md files). To run an existing agent, use agent+task directly.",
      "Background: background=true returns run id. action=wait to block for result.",
      "Chain templates: {task} = original request, {previous} = prior step output (empty on first step). Gates: shell cmd, exit 0 = pass, $SUBAGENT_OUTPUT = step output.",
      "Model: agent definition sets default, parent can override with model param.",
      "Execution: execution param overrides agent default. inline (default): in-process, shared memory. subprocess: isolated, crash-safe.",
      "Max depth: 3.",
    ].join("\n"),

    parameters: Type.Object({
      action: Type.Optional(Type.String({ enum: ["list", "status", "wait", "resume", "interrupt", "create", "update", "delete"], description: "Lifecycle action. interrupt: cancel running agent. create/update/delete: manage agent DEFINITIONS (.md files) — NOT for running agents. To run an agent, use agent+task directly." })),
      id: Type.Optional(Type.String({ description: "Run id for status/wait/resume actions" })),
      background: Type.Optional(Type.Boolean({ description: "Run in background (single mode only). Returns immediately." })),
      agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
      task: Type.Optional(Type.String({ description: "Task for single mode, {task} template source for chain mode, or follow-up message for resume" })),
      model: Type.Optional(Type.String({ description: "Override agent's default model (provider/model-id format, e.g. 'openrouter/anthropic/fable-5')" })),
      execution: Type.Optional(Type.String({ enum: ["inline", "subprocess"], description: "Execution mode. 'inline' (default): in-process, shared memory, EventBus access. 'subprocess': isolated, 230MB per agent, crash-safe." })),
      tasks: Type.Optional(Type.Array(Type.Object({
        agent: Type.String({ description: "Agent name. Use action=list to see available agents." }),
        task: Type.String({ description: "Task description for this agent." }),
        cwd: Type.Optional(Type.String({ description: "Working directory for this agent (absolute path). Defaults to top-level cwd." })),
      }), { description: "Parallel mode: array of agent+task pairs. Max 8 tasks, all run concurrently by default." })),
      concurrency: Type.Optional(Type.Integer({ description: "Max concurrent agents in parallel mode. Default: 8 (inline agents are cheap)." })),
      chain: Type.Optional(Type.Array(Type.Object({
        agent: Type.String({ description: "Agent name. Use action=list to see available agents." }),
        task: Type.String({ description: "Task template. {task} = original request, {previous} = prior step output (empty on first step)." }),
        cwd: Type.Optional(Type.String({ description: "Working directory for this step (absolute path). Defaults to top-level cwd." })),
        gate: Type.Optional(Type.String({ description: "Shell command to validate step output. Exit 0 = pass. Step output in $SUBAGENT_OUTPUT env var." })),
        gateTimeout: Type.Optional(Type.Integer({ description: "Gate timeout in ms. Default: 30000." })),
        onFail: Type.Optional(Type.String({ enum: ["retry", "skip", "abort"], description: "Action on gate failure. retry: re-run step (max 3). skip: continue chain. abort: stop. Default: abort." })),
        as: Type.Optional(Type.String({ description: "Named output. Available as {outputs.name} in later chain steps." })),
      }), { description: "Chain mode: sequential steps with optional quality gates between them." })),
      context: Type.Optional(Type.String({ enum: ["fresh", "fork"], description: "Context mode. 'fresh' (default): child gets only the task. 'fork': child inherits parent's session history." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the run (absolute path). Defaults to the current project directory." })),
      acceptance: Type.Optional(Type.Object({
        criteria: Type.Optional(Type.Array(Type.String(), { description: "Describes what 'done' looks like. Reported in output for parent to evaluate." })),
        verify: Type.Optional(Type.Array(Type.String(), { description: "Shell commands to validate output. All must exit 0 for acceptance to pass." })),
        maxAttempts: Type.Optional(Type.Integer({ description: "Max retry attempts on acceptance failure. Default: 1 (no retries)." })),
      }, { description: "Acceptance contract. Defines success criteria and verification for the agent's output." })),
      prompt: Type.Optional(Type.String({ description: "System prompt for create/update actions. The agent's instructions." })),
    }),

    async execute(_id, params, signal, _onUpdate, ctx) {
      // Defensive fallback: ctx.cwd can be undefined in some execution contexts
      const effectiveCwd = ctx.cwd ?? process.cwd();

      // ── Lifecycle actions ──
      if (params.action) {
        if (params.action === "list") {
          const agents = discoverAgents(effectiveCwd);
          if (!agents.length) return ok("No agents found. Place .md files in .pi/agents/ (project) or ~/.pi/agents/ (global).");
          const lines = agents.map(a => {
            const model = a.model ? ` [${a.model}]` : "";
            const exec = a.execution === "subprocess" ? " subprocess" : "";
            const tools = a.tools?.length ? ` tools:${a.tools.join(",")}` : "";
            return `${a.name}: ${a.description}${model}${exec}${tools} (${a.source})`;
          });
          return ok(`Available agents:\n${lines.join("\n")}`);
        }

        if (params.action === "status") {
          if (!params.id) return err("Provide id for status action.");
          const match = findRun(params.id);
          if (!match) {
            // Check if they passed an agent name instead of a run ID
            const agents = discoverAgents(effectiveCwd);
            const agentMatch = agents.find(a => a.name === params.id);
            if (agentMatch) {
              return err(`"${params.id}" is an agent name, not a run ID. To run an agent, use:\n\n  subagent(agent="${params.id}", task="your task here")\n\nThen use action="status" with the returned run ID.`);
            }
            return err(`Run not found: ${params.id}`);
          }
          if ("ambiguous" in match) return err(`Ambiguous id "${params.id}" — matches ${match.ambiguous.join(", ")}. Provide more characters.`);
          return ok(fmtRunStatus(match), { run: match });
        }

        if (params.action === "wait") {
          if (!params.id) return err("Provide id for wait action.");
          const match = findRun(params.id);
          if (!match) {
            // Check if they passed an agent name instead of a run ID
            const agents = discoverAgents(effectiveCwd);
            const agentMatch = agents.find(a => a.name === params.id);
            if (agentMatch) {
              return err(`"${params.id}" is an agent name, not a run ID. To run an agent, use:\n\n  subagent(agent="${params.id}", task="your task here")\n\nThen use action="wait" with the returned run ID.`);
            }
            return err(`Run not found: ${params.id}`);
          }
          if ("ambiguous" in match) return err(`Ambiguous id "${params.id}" — matches ${match.ambiguous.join(", ")}. Provide more characters.`);
          if (match.status !== "running") {
            const r = match.result!;
            const d = { mode: "background", results: [r] };
            return r.exitCode === 0 ? ok(r.output, d) : err(`Agent failed: ${r.stderr || r.output}`, d);
          }
          await new Promise<void>(resolve => {
            if (match.status !== "running") return resolve();
            const poll = setInterval(() => { if (match.status !== "running") { clearInterval(poll); resolve(); } }, 500);
            signal?.addEventListener("abort", () => { clearInterval(poll); resolve(); }, { once: true });
          });
          if (signal?.aborted) return err("Wait aborted.");
          const r = match.result!;
          const d = { mode: "background", results: [r] };
          return r.exitCode === 0 ? ok(r.output, d) : err(`Agent failed: ${r.stderr || r.output}`, d);
        }

        if (params.action === "resume") {
          if (!params.id) return err("Provide id for resume action.");
          if (!params.task) return err("Provide task (follow-up message) for resume action.");
          const match = findRun(params.id);
          if (!match) return err(`Run not found: ${params.id}`);
          if ("ambiguous" in match) return err(`Ambiguous id "${params.id}" — matches ${match.ambiguous.join(", ")}. Provide more characters.`);
          const cwd = params.cwd ? path.resolve(params.cwd) : effectiveCwd;
          const r = await resumeRun(match, params.task, cwd, signal);
          // Create a new run record for the resumed turn
          const resumeId = genId();
          const resumeRecord: RunRecord = {
            id: resumeId, agent: r.agent, task: r.task, status: r.exitCode === 0 ? "completed" : "failed",
            startedAt: Date.now() - r.duration, sessionPath: r.sessionPath ?? match.sessionPath, result: r,
          };
          runs.set(resumeId, resumeRecord);
          persistRuns();
          const d = { mode: "resume", results: [r], originalRunId: match.id, resumeId };
          return r.exitCode === 0 ? ok(r.output, d) : err(`Resume failed: ${r.stderr || r.output}`, d);
        }

        if (params.action === "interrupt") {
          if (!params.id) return err("Provide id for interrupt action.");
          const match = findRun(params.id);
          if (!match) return err(`Run not found: ${params.id}`);
          if ("ambiguous" in match) return err(`Ambiguous id "${params.id}" — matches ${match.ambiguous.join(", ")}. Provide more characters.`);
          if (match.status !== "running") return err(`Run ${match.id} is ${match.status}, not running. Cannot interrupt.`);
          if (!match.proc) return err(`Run ${match.id} has no process handle. It may have been started in a different session.`);
          try {
            killProc(match.proc, "SIGTERM");
            return ok(`Sent SIGTERM to ${match.agent} (${match.id}). It may take a few seconds to stop.`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Failed to interrupt ${match.id}: ${msg}`);
          }
        }

        if (params.action === "create") {
          if (!params.agent) return err("Provide agent name for create action.");
          if (!params.task && !params.prompt) return err("Provide task (description) and/or prompt (system prompt) for create action.");
          // If only prompt given, use agent name as description
          const description = params.task ?? `${params.agent} agent`;
          const systemPrompt = params.prompt ?? "";
          const existingAgents = discoverAgents(effectiveCwd);
          const alreadyExists = existingAgents.find(a => a.name === params.agent);
          if (alreadyExists) {
            return err(`Agent "${params.agent}" already exists (${alreadyExists.source}). You don't need to create it — just run it directly:\n\n  subagent(agent="${params.agent}", task="your task here")\n\naction="create" is for defining NEW agent types. To run an existing agent, use agent+task.`);
          }
          const agentsDir = path.join(effectiveCwd, ".pi", "agents");
          fs.mkdirSync(agentsDir, { recursive: true });
          const fp = path.join(agentsDir, `${params.agent}.md`);
          // Quote YAML values that contain special characters
          // oxlint-disable-next-line no-useless-escape — \[ IS needed inside character class for literal bracket
          const yamlQuote = (v: string) => /[:#"'\n{}\[\],&*?|>!%@`]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"` : v;
          const fm = [
            "---",
            `name: ${yamlQuote(params.agent)}`,
            `description: ${yamlQuote(description)}`,
            params.model ? `model: ${yamlQuote(params.model)}` : "",
            "---",
            "",
            systemPrompt,
          ].filter(Boolean).join("\n");
          fs.writeFileSync(fp, fm, "utf-8");
          return ok(`Created agent "${params.agent}" at ${fp}`);
        }

        if (params.action === "update") {
          if (!params.agent) return err("Provide agent name for update action.");
          const existing = findAgentFile(effectiveCwd, params.agent);
          if (!existing) return err(`Agent "${params.agent}" not found.`);
          const raw = fs.readFileSync(existing, "utf-8");
          const { meta, body } = parseFrontmatter(raw);
          if (params.task) meta.description = params.task;
          if (params.model) meta.model = params.model;
          const prompt = params.prompt || body;
          const fm = ["---", ...Object.entries(meta).map(([k, v]) => `${k}: ${v}`), "---", "", prompt].join("\n");
          fs.writeFileSync(existing, fm, "utf-8");
          return ok(`Updated agent "${params.agent}" at ${existing}`);
        }

        if (params.action === "delete") {
          if (!params.agent) return err("Provide agent name for delete action.");
          const existing = findAgentFile(effectiveCwd, params.agent);
          if (!existing) return err(`Agent "${params.agent}" not found.`);
          try {
            fs.unlinkSync(existing);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(`Failed to delete "${params.agent}": ${msg}`);
          }
          return ok(`Deleted agent "${params.agent}" (${existing})`);
        }

        return err(`Unknown action: ${params.action}`);
      }

      // ── Validate: exactly one execution mode ──
      const hasSingle = Boolean(params.agent && params.task);
      const hasChain = Boolean(params.chain?.length);
      const hasParallel = Boolean(params.tasks?.length);
      const modeCount = Number(hasSingle) + Number(hasChain) + Number(hasParallel);
      if (modeCount !== 1) {
        const agents = discoverAgents(effectiveCwd);
        const avail = agents.map(a => `${a.name}: ${a.description}`).join("\n") || "none";
        return err(`Provide exactly one mode: agent+task, tasks[], or chain[]. Or use an action.\n\nAvailable agents:\n${avail}`);
      }

      const cwd = params.cwd ? path.resolve(params.cwd) : effectiveCwd;
      if (!fs.existsSync(cwd)) return err(`cwd does not exist: ${cwd}`);

      const agents = discoverAgents(cwd);
      const depth = getDepth();
      if (depth >= MAX_DEPTH) return err(`Max depth (${MAX_DEPTH}) reached. Cannot spawn deeper.`);

      // Build context options for fork mode
      const contextOpts = params.context === "fork"
        ? { context: "fork" as const, parentSessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined }
        : undefined;
      if (params.context === "fork" && !contextOpts?.parentSessionFile) {
        return err("Cannot use context: 'fork' — no parent session file available.");
      }

      // ── Background single ──
      if (hasSingle && params.background) {
        const record = runAgentAsync(agents, params.agent!, params.task!, cwd, depth + 1, params.model, contextOpts);
        return ok(
          `Background run started: ${record.id}\nAgent: ${record.agent}\nSession: ${record.sessionPath}\n\nUse action: 'wait', id: '${record.id}' to get the result.`,
          { mode: "background", runId: record.id, sessionPath: record.sessionPath },
        );
      }

      // ── Foreground single ──
      if (hasSingle) {
        const maxAttempts = params.acceptance?.maxAttempts ?? 1;
        let lastResult: RunResult | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const r = await runAgentSync(agents, params.agent!, params.task!, cwd, depth + 1, signal, params.model, contextOpts, ctx, params.execution as "inline" | "subprocess" | undefined);
          lastResult = r;

          if (r.exitCode !== 0) {
            const d = { mode: "single" as const, results: [r] };
            return err(`Agent failed: ${r.stderr || r.output}`, d);
          }

          // Run acceptance verification if specified
          if (params.acceptance?.verify?.length) {
            const verifyResults: string[] = [];
            let allPassed = true;
            for (const cmd of params.acceptance.verify) {
              const { exitCode } = await runGate(cmd, r.output, cwd, 30_000, signal);
              const passed = exitCode === 0;
              verifyResults.push(`${passed ? "✓" : "✗"} ${cmd}`);
              if (!passed) allPassed = false;
            }

            if (allPassed) {
              const criteria = params.acceptance.criteria?.length
                ? `\nCriteria: ${params.acceptance.criteria.join(", ")}` : "";
              return ok(`${r.output}\n\nAcceptance: all checks passed${criteria}\n${verifyResults.join("\n")}`, { mode: "single", results: [r], accepted: true });
            }

            if (attempt < maxAttempts) continue; // retry
            return err(`Acceptance failed after ${attempt} attempt(s):\n${verifyResults.join("\n")}`, { mode: "single", results: [r], accepted: false });
          }

          // No acceptance — return directly
          const d = { mode: "single" as const, results: [r] };
          return ok(r.output, d);
        }

        // Should not reach here, but safety fallback
        const d = { mode: "single" as const, results: lastResult ? [lastResult] : [] };
        return err("Agent did not produce a result.", d);
      }

      // ── Chain with quality gates ──
      if (hasChain) {
        // Validate all chain agents exist before executing any
        for (let si = 0; si < params.chain!.length; si++) {
          const step = params.chain![si]!;
          const cfg = agents.find(a => a.name === step.agent);
          if (!cfg) return err(`Chain step ${si + 1}: unknown agent "${step.agent}". Use action="list" to see available agents.`);
        }

        const results: RunResult[] = [];
        const outputs: Record<string, string> = {};
        let previous = "";
        let i = 0;
        let retries = 0;

        while (i < params.chain!.length) {
          const step = params.chain![i]!;
          let task = step.task.replace(/\{previous\}/g, previous);
          task = task.replace(/\{task\}/g, params.task ?? "");
          // Replace {outputs.name} with stored named outputs
          task = task.replace(/\{outputs\.([^}]+)\}/g, (_: string, key: string) => outputs[key] ?? "");
          const r = await runAgentSync(agents, step.agent, task, step.cwd ? path.resolve(step.cwd) : cwd, depth + 1, signal, undefined, contextOpts, ctx);
          results.push(r);

          if (r.exitCode !== 0) {
            return err(`Chain failed at step ${i + 1} (${step.agent}): ${r.stderr || r.output}`, { mode: "chain", results });
          }

          // Store named output if step defines 'as'
          if (step.as) outputs[step.as] = r.output;

          if (step.gate) {
            const timeout = step.gateTimeout ?? DEFAULT_GATE_TIMEOUT_MS;
            const { exitCode: gateExit, stderr: gateStderr } = await runGate(step.gate, r.output, step.cwd ? path.resolve(step.cwd) : cwd, timeout, signal);

            if (gateExit !== 0) {
              const onFail = step.onFail ?? "abort";
              if (onFail === "retry" && retries < MAX_RETRIES) {
                retries++;
                previous = `[RETRY ${retries}/${MAX_RETRIES} — gate failed: ${gateStderr || `exit ${gateExit}`}]\n${r.output}`;
                continue;
              }
              if (onFail === "skip") {
                previous = r.output;
                i++;
                retries = 0;
                continue;
              }
              return err(`Gate failed at step ${i + 1} (${step.agent}): ${gateStderr || `exit ${gateExit}`}`, { mode: "chain", results });
            }
          }

          previous = r.output;
          i++;
          retries = 0;
        }

        const summary = results.map(fmtResult).join("\n");
        return ok(`${summary}\n\n${results[results.length - 1]?.output ?? ""}`, { mode: "chain", results });
      }

      // ── Parallel ──
      if (hasParallel) {
        if (params.tasks!.length > MAX_PARALLEL) return err(`Too many tasks (${params.tasks!.length}). Max: ${MAX_PARALLEL}.`);

        const concurrency = Math.max(1, Math.min(params.concurrency ?? MAX_CONCURRENCY, MAX_PARALLEL));
        const results = await mapConcurrent(params.tasks!, concurrency, (t) =>
          runAgentSync(agents, t.agent, t.task, t.cwd ? path.resolve(t.cwd) : cwd, depth + 1, signal, undefined, contextOpts, ctx, params.execution as "inline" | "subprocess" | undefined)
        );

        const okCount = results.filter(r => r.exitCode === 0).length;
        const summary = results.map(r => {
          const raw = r.exitCode === 0 ? r.output : r.stderr || r.output;
          const output = truncate(raw, PER_TASK_OUTPUT_CAP);
          return `### [${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}\n${output}`;
        }).join("\n\n---\n\n");
        const d = { mode: "parallel", results };
        const text = `Parallel: ${okCount}/${results.length} succeeded\n\n${summary}`;
        return okCount < results.length ? err(text, d) : ok(text, d);
      }

      return err("Internal error: no mode matched");
    },

    renderCall(args, theme) {
      const label = args.action
        ? args.action + (args.id ? ` ${args.id}` : "")
        : args.chain?.length ? `chain (${args.chain.length})`
        : args.tasks?.length ? `parallel (${args.tasks.length})`
        : args.background ? `bg ${args.agent ?? "?"}`
        : args.agent ?? "?";
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", label)}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
      const d = result.details as { results?: RunResult[] } | undefined;
      const hasErr = d?.results?.some(r => r.exitCode !== 0) ?? false;
      const icon = hasErr ? theme.fg("error", "✗") : theme.fg("success", "✓");

      // Build summary line with usage stats
      const summaryParts: string[] = [];
      if (d?.results?.length) {
        const totalCost = d.results.reduce((s, r) => s + r.cost, 0);
        const totalTurns = d.results.reduce((s, r) => s + r.turns, 0);
        if (totalCost > 0) summaryParts.push(`$${totalCost.toFixed(4)}`);
        if (totalTurns > 0) summaryParts.push(`${totalTurns} turn${totalTurns > 1 ? "s" : ""}`);
        // Count tool calls across all results
        const toolCallCount = d.results.reduce((s, r) => s + r.messages.filter(m => m.toolCalls?.length).length, 0);
        if (toolCallCount > 0) summaryParts.push(`${toolCallCount} tool call${toolCallCount > 1 ? "s" : ""}`);
      }
      const summaryLine = summaryParts.length ? ` ${theme.fg("muted", `(${summaryParts.join(", ")})`)}` : "";

      if (expanded) {
        const c = new Container();
        c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}${summaryLine}`, 0, 0));

        // Show tool calls from the first result with messages
        const firstWithMessages = d?.results?.find(r => r.messages.length > 0);
        if (firstWithMessages) {
          const toolCalls = firstWithMessages.messages.filter(m => m.role === "assistant" && m.toolCalls?.length);
          if (toolCalls.length > 0) {
            c.addChild(new Spacer(1));
            c.addChild(new Text(theme.fg("muted", "Tool calls:"), 0, 0));
            for (const msg of toolCalls.slice(0, 10)) {
              for (const tc of msg.toolCalls ?? []) {
                const args = Object.keys(tc.args).length > 0
                  ? ` ${theme.fg("muted", JSON.stringify(tc.args).slice(0, 120))}`
                  : "";
                c.addChild(new Text(`  ${theme.fg("accent", tc.name)}${args}`, 0, 0));
              }
            }
            if (toolCalls.length > 10) c.addChild(new Text(theme.fg("muted", `  ... +${toolCalls.length - 10} more`), 0, 0));
          }
        }

        c.addChild(new Spacer(1));
        c.addChild(new Text(text, 0, 0));
        return c;
      }

      // Collapsed: show first few lines + summary
      const lines = text.split("\n");
      const preview = lines.length > 8
        ? [...lines.slice(0, 8), theme.fg("muted", `... +${lines.length - 8} more (Ctrl+O to expand)`)]
        : lines;
      return new Text(`${icon} ${preview.join("\n")}${summaryLine}`, 0, 0);
    },
  });
}
