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
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Types ───────────────────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: "user" | "project";
}

interface RunResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  cost: number;
  duration: number;
  sessionPath?: string;
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
const MAX_CONCURRENCY = 4;
const MAX_RETRIES = 3;
const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB per agent output
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
  let t = s;
  while (Buffer.byteLength(t, "utf-8") > maxBytes) t = t.slice(0, -1);
  return `${t}\n[truncated — ${Buffer.byteLength(s, "utf-8")} bytes total]`;
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

function loadAgents(dir: string, source: "user" | "project"): AgentConfig[] {
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
    agents.push({
      name: meta.name, description: meta.description,
      model: meta.model || undefined,
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
  for (const a of loadAgents(path.join(os.homedir(), ".pi", "agents"), "user")) map.set(a.name, a);
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

function buildArgs(
  agent: AgentConfig, task: string, sessionDir: string, overrideModel?: string,
): { args: string[]; tmpFile?: string; cmd: string; baseArgs: string[] } {
  const { cmd, baseArgs } = getPiCmd();
  const args = [...baseArgs, "--mode", "json", "-p", "--session-dir", sessionDir];
  const model = overrideModel ?? agent.model;
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
  cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; parseStdout?: boolean },
): Promise<{ exitCode: number; output: string; stderr: string; cost: number }> {
  const { cwd, env, signal, parseStdout = true } = opts;
  return new Promise(resolve => {
    let output = "", stderr = "", cost = 0;
    let closed = false;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const stdio: ["ignore", "pipe" | "ignore", "pipe"] = parseStdout ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"];
    const proc = spawn(cmd, args, { cwd, shell: false, stdio, env });

    let buf = "";
    const processLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const texts: string[] = [];
        for (const p of ev.message.content ?? []) { if (p.type === "text") texts.push(p.text); }
        if (texts.length) output = texts.join("\n");
        cost += ev.message.usage?.cost?.total ?? 0;
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
      resolve({ exitCode: c ?? 0, output, stderr, cost });
    });
    proc.on("error", () => { if (!closed) resolve({ exitCode: 1, output, stderr, cost }); });

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
  agents: AgentConfig[], name: string, task: string, cwd: string, depth: number, signal?: AbortSignal, overrideModel?: string,
): Promise<RunResult> {
  const agent = agents.find(a => a.name === name);
  if (!agent) {
    const avail = agents.map(a => `"${a.name}"`).join(", ") || "none";
    return { agent: name, task, exitCode: 1, output: "", stderr: `Unknown agent "${name}". Available: ${avail}`, cost: 0, duration: 0 };
  }

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const { args, tmpFile, cmd } = buildArgs(agent, task, sessionDir, overrideModel);
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
    };
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
  }
}

/** Background run — spawns detached, returns immediately. stdout ignored (read from session files). */
function runAgentAsync(
  agents: AgentConfig[], name: string, task: string, cwd: string, depth: number, overrideModel?: string,
): RunRecord {
  const agent = agents.find(a => a.name === name);
  const id = genId();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));

  if (!agent) {
    const avail = agents.map(a => `"${a.name}"`).join(", ") || "none";
    const record: RunRecord = {
      id, agent: name, task, status: "failed", startedAt: Date.now(), sessionPath: sessionDir,
      result: { agent: name, task, exitCode: 1, output: "", stderr: `Unknown agent "${name}". Available: ${avail}`, cost: 0, duration: 0 },
    };
    runs.set(id, record);
    persistRuns();
    return record;
  }

  const { args, tmpFile, cmd } = buildArgs(agent, task, sessionDir, overrideModel);
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
    };
    record.proc = undefined;
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
    persistRuns();
  });
  proc.on("error", () => {
    record.status = "failed";
    record.result = {
      agent: name, task, exitCode: 1, output: "", stderr: stderr || "process error", cost: 0,
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
    return { agent: run.agent, task: message, exitCode: 1, output: "", stderr: `No session file found in ${run.sessionPath}`, cost: 0, duration: 0 };
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
  const results = new Array<R>(items.length);
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
  return `${icon} ${r.agent} (${ms}${c})`;
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
      "Actions: list (agents), status/wait (background runs), resume (follow-up). Set action, omit mode.",
      "Background: background=true returns run id. action=wait to block for result.",
      "Chain templates: {task} = original request, {previous} = prior step output (empty on first step). Gates: shell cmd, exit 0 = pass, $SUBAGENT_OUTPUT = step output.",
      "Model: agent definition sets default, parent can override with model param. Max depth: 3.",
    ].join("\n"),

    parameters: Type.Object({
      action: Type.Optional(Type.String({ enum: ["list", "status", "wait", "resume"], description: "Lifecycle action." })),
      id: Type.Optional(Type.String({ description: "Run id for status/wait/resume actions" })),
      background: Type.Optional(Type.Boolean({ description: "Run in background (single mode only). Returns immediately." })),
      agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
      task: Type.Optional(Type.String({ description: "Task for single mode, {task} template source for chain mode, or follow-up message for resume" })),
      model: Type.Optional(Type.String({ description: "Override agent's default model (actual model name, e.g. 'openrouter/deepseek/deepseek-v4-flash')" })),
      tasks: Type.Optional(Type.Array(Type.Object({
        agent: Type.String({ description: "Agent name. Use action=list to see available agents." }),
        task: Type.String({ description: "Task description for this agent." }),
        cwd: Type.Optional(Type.String({ description: "Working directory for this agent (absolute path). Defaults to top-level cwd." })),
      }), { description: "Parallel mode: array of agent+task pairs. Max 8 tasks, 4 run concurrently." })),
      chain: Type.Optional(Type.Array(Type.Object({
        agent: Type.String({ description: "Agent name. Use action=list to see available agents." }),
        task: Type.String({ description: "Task template. {task} = original request, {previous} = prior step output (empty on first step)." }),
        cwd: Type.Optional(Type.String({ description: "Working directory for this step (absolute path). Defaults to top-level cwd." })),
        gate: Type.Optional(Type.String({ description: "Shell command to validate step output. Exit 0 = pass. Step output in $SUBAGENT_OUTPUT env var." })),
        gateTimeout: Type.Optional(Type.Integer({ description: "Gate timeout in ms. Default: 30000." })),
        onFail: Type.Optional(Type.String({ enum: ["retry", "skip", "abort"], description: "Action on gate failure. retry: re-run step (max 3). skip: continue chain. abort: stop. Default: abort." })),
      }), { description: "Chain mode: sequential steps with optional quality gates between them." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the run (absolute path). Defaults to the current project directory." })),
    }),

    async execute(_id, params, signal, _onUpdate, ctx) {
      // ── Lifecycle actions ──
      if (params.action) {
        if (params.action === "list") {
          const agents = discoverAgents(ctx.cwd);
          if (!agents.length) return ok("No agents found. Place .md files in .pi/agents/ (project) or ~/.pi/agents/ (global).");
          const lines = agents.map(a => {
            const model = a.model ? ` [${a.model}]` : "";
            const tools = a.tools?.length ? ` tools:${a.tools.join(",")}` : "";
            return `${a.name}: ${a.description}${model}${tools} (${a.source})`;
          });
          return ok(`Available agents:\n${lines.join("\n")}`);
        }

        if (params.action === "status") {
          if (!params.id) return err("Provide id for status action.");
          const match = findRun(params.id);
          if (!match) return err(`Run not found: ${params.id}`);
          if ("ambiguous" in match) return err(`Ambiguous id "${params.id}" — matches ${match.ambiguous.join(", ")}. Provide more characters.`);
          return ok(fmtRunStatus(match), { run: match });
        }

        if (params.action === "wait") {
          if (!params.id) return err("Provide id for wait action.");
          const match = findRun(params.id);
          if (!match) return err(`Run not found: ${params.id}`);
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
          const cwd = params.cwd ? path.resolve(params.cwd) : ctx.cwd;
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

        return err(`Unknown action: ${params.action}`);
      }

      // ── Validate: exactly one execution mode ──
      const hasSingle = Boolean(params.agent && params.task);
      const hasChain = Boolean(params.chain?.length);
      const hasParallel = Boolean(params.tasks?.length);
      const modeCount = Number(hasSingle) + Number(hasChain) + Number(hasParallel);
      if (modeCount !== 1) {
        const agents = discoverAgents(ctx.cwd);
        const avail = agents.map(a => `${a.name}: ${a.description}`).join("\n") || "none";
        return err(`Provide exactly one mode: agent+task, tasks[], or chain[]. Or use an action.\n\nAvailable agents:\n${avail}`);
      }

      const cwd = params.cwd ? path.resolve(params.cwd) : ctx.cwd;
      if (!fs.existsSync(cwd)) return err(`cwd does not exist: ${cwd}`);

      const agents = discoverAgents(cwd);
      const depth = getDepth();
      if (depth >= MAX_DEPTH) return err(`Max depth (${MAX_DEPTH}) reached. Cannot spawn deeper.`);

      // ── Background single ──
      if (hasSingle && params.background) {
        const record = runAgentAsync(agents, params.agent!, params.task!, cwd, depth + 1, params.model);
        return ok(
          `Background run started: ${record.id}\nAgent: ${record.agent}\nSession: ${record.sessionPath}\n\nUse action: 'wait', id: '${record.id}' to get the result.`,
          { mode: "background", runId: record.id, sessionPath: record.sessionPath },
        );
      }

      // ── Foreground single ──
      if (hasSingle) {
        const r = await runAgentSync(agents, params.agent!, params.task!, cwd, depth + 1, signal, params.model);
        const d = { mode: "single", results: [r] };
        return r.exitCode === 0 ? ok(r.output, d) : err(`Agent failed: ${r.stderr || r.output}`, d);
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
        let previous = "";
        let i = 0;
        let retries = 0;

        while (i < params.chain!.length) {
          const step = params.chain![i]!;
          let task = step.task.replace(/\{previous\}/g, previous);
          task = task.replace(/\{task\}/g, params.task ?? "");
          const r = await runAgentSync(agents, step.agent, task, step.cwd ? path.resolve(step.cwd) : cwd, depth + 1, signal);
          results.push(r);

          if (r.exitCode !== 0) {
            return err(`Chain failed at step ${i + 1} (${step.agent}): ${r.stderr || r.output}`, { mode: "chain", results });
          }

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

        const results = await mapConcurrent(params.tasks!, MAX_CONCURRENCY, (t) =>
          runAgentSync(agents, t.agent, t.task, t.cwd ? path.resolve(t.cwd) : cwd, depth + 1, signal)
        );

        const okCount = results.filter(r => r.exitCode === 0).length;
        const summary = results.map(r =>
          `### [${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}\n${r.exitCode === 0 ? r.output : r.stderr || r.output}`
        ).join("\n\n---\n\n");
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
      if (expanded) {
        const c = new Container();
        c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`, 0, 0));
        c.addChild(new Spacer(1));
        c.addChild(new Text(text, 0, 0));
        return c;
      }
      const lines = text.split("\n");
      const preview = lines.length > 10
        ? [...lines.slice(0, 10), theme.fg("muted", `... +${lines.length - 10} more (Ctrl+O to expand)`)]
        : lines;
      return new Text(`${icon} ${preview.join("\n")}`, 0, 0);
    },
  });
}
