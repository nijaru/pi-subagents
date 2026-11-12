import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { MAX_PROCESS_TIMEOUT_MS, MAX_RETAINED_RUNS, MAX_STARTUP_TIMEOUT_MS, MAX_TASK_BYTES, MAX_WAIT_MS } from "./limits.ts";
import { THINKING_LEVELS } from "./types.ts";

// Keep the provider schema structural: strict-tool subsets differ in their
// support for length, uniqueness, pattern, and numeric constraints. Application
// validation below owns those limits for every provider, including nested calls.
export const SubagentParamsSchema = Type.Object({
  command: Type.Enum(["run", "spawn", "status", "wait", "stop", "steer"] as const, { type: "string",
    description: "run/spawn require prompt. run joins up to joinTimeoutMs, then continues in the background; spawn returns a handle immediately. wait requires ids and returns when any selected child finishes. status optionally takes id. stop requires id. steer requires id and message.",
  }),
  prompt: Type.Optional(Type.String({ description: "run/spawn: self-contained task with evidence, scope, constraints, expected output and checks; at most 100 KiB UTF-8." })),
  label: Type.Optional(Type.String({ description: "run/spawn: optional short task label, at most 80 characters on one line. Display only; use the returned handle for control." })),
  tools: Type.Optional(Type.Array(Type.String(), {
    description: "run/spawn: exact allowlist, at most 64 unique active/callable parent tool names. Defaults to read/search/web; request bash/edit/write explicitly. [] is reasoning-only. Children cannot delegate.",
  })),
  model: Type.Optional(Type.String({ description: "run/spawn: exact provider/model-id; omitted inherits the parent's model. At most 512 characters." })),
  thinking: Type.Optional(Type.Enum(THINKING_LEVELS, { type: "string",
    description: "run/spawn: reasoning effort. Omitted inherits parent effort for the same model; another model uses its own defaults. Unsupported explicit effort fails before prompting.",
  })),
  cwd: Type.Optional(Type.String({ description: "run/spawn: child working directory, relative to the parent cwd; at most 4096 characters. Concurrent writers need separate worktrees." })),
  id: Type.Optional(Type.String({ description: "status/stop/steer: child handle (sa-N) or full UUID, at most 128 characters. Omit for status to list retained children." })),
  message: Type.Optional(Type.String({ description: "steer: instruction delivered after the child's current assistant turn/tool calls; at most 100 KiB UTF-8. Queue acceptance does not prove delivery. Cancellation stops waiting, not the child; do not resend blindly." })),
  ids: Type.Optional(Type.Array(Type.String(), {
    description: "wait: 1–32 unique handles or UUIDs, each at most 128 characters. Returns ready reports and running snapshots. Wait again only on remaining children when blocked.",
  })),
  timeoutMs: Type.Optional(Type.Integer({ description: "wait: positive integer join budget in milliseconds, at most 600000; default 300000. Expiry/cancellation leaves children running; never changes their deadlines." })),
  executionTimeoutMs: Type.Optional(Type.Integer({ description: "run/spawn: optional execution cutoff after task submission, 1–7200000 milliseconds. Off unless set here or by PI_SUBAGENT_TIMEOUT_MS. Startup and join budgets are separate." })),
  startupTimeoutMs: Type.Optional(Type.Integer({ description: "run/spawn: process/configuration/tool readiness budget, 1–300000 milliseconds; defaults to PI_SUBAGENT_STARTUP_TIMEOUT_MS (30000)." })),
  joinTimeoutMs: Type.Optional(Type.Integer({ description: "run: foreground join budget, 1–600000 milliseconds; defaults to PI_SUBAGENT_FOREGROUND_MS (60000). Expiry returns a running handle, not a task failure." })),
  persist: Type.Optional(Type.Boolean({ description: "run/spawn: save the conversation for recovery; default true. May contain sensitive prompts/tool results. false disables retention. Mutually exclusive with resume." })),
  resume: Type.Optional(Type.String({ description: "run/spawn: stopped child's handle or saved session path, at most 4096 characters. Creates a new handle; old report stays readable. Handle resume defaults to original cwd. Tools/model/effort/trust use normal launch rules. Mutually exclusive with persist." })),
  trustProject: Type.Optional(Type.Boolean({ description: "run/spawn: one-shot --approve so child project resources can load without an RPC trust prompt; default false. Parent trust is not inherited." })),
}, { additionalProperties: false });

export type SubagentParams = Static<typeof SubagentParamsSchema>;

/** The flat wire schema stays provider-friendly; dispatch uses validated commands. */
export type SubagentCommand = SubagentParams & (
  | { command: "run" | "spawn"; prompt: string }
  | { command: "wait"; ids: string[] }
  | { command: "steer"; id: string; message: string }
  | { command: "stop"; id: string }
  | { command: "status" }
);

// Least privilege: a delegated task can read, search, and browse by default.
// Mutation tools (bash/edit/write) must be requested explicitly.
const DEFAULT_TOOLS = [
  "read", "grep", "find", "ls",
  "web_search", "web_fetch", "web_research", "resolve-library-id", "query-docs",
];

// Pi's nested-call allowlist keeps MCP resource tools reachable unless they are
// explicitly excluded. Keep this list aligned with Pi's built-in MCP extension.
export const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const;
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__") || (MCP_RESOURCE_TOOLS as readonly string[]).includes(name);
}

/**
 * CLI `--tools` controls the active model-facing set, but `executeTool()` and
 * codemode can reach registered tools. Compute the denylist needed to make the
 * requested set an actual boundary.
 */
export function excludedChildTools(selected: readonly string[], available: readonly string[]): string[] {
  const chosen = new Set(selected);
  const excluded = new Set<string>();
  if (!selected.some(isMcpTool)) excluded.add("mcp__*");
  // `executeTool()` can reach registered tools that are not active. Exclude
  // every unselected tool, not only the ones currently exposed to the model.
  for (const name of new Set(available)) {
    if (!chosen.has(name)) excluded.add(name);
  }
  for (const name of MCP_RESOURCE_TOOLS) {
    if (!chosen.has(name)) excluded.add(name);
  }
  return [...excluded];
}

export function selectTools(requested: string[] | undefined, active: string[], callable: readonly string[]): string[] {
  const tools = requested ?? DEFAULT_TOOLS.filter((name) => active.includes(name));
  if (requested === undefined && tools.length === 0) throw new Error("No default child tools are active. Specify tools: [] for a reasoning-only task.");
  if (tools.some((name) => name === "subagent")) throw new Error("Children are leaves: the subagent tool cannot be delegated.");
  const eligible = new Set([...active, ...callable]);
  const unavailable = tools.filter((name) => !eligible.has(name));
  if (unavailable.length) throw new Error(`Child tools must be active or callable in the parent: ${unavailable.join(", ")}.`);
  return [...tools];
}

function stringLimit(value: string | undefined, name: string, maximum: number): void {
  if (value === undefined) return;
  let length = 0;
  for (const _ of value) {
    if (++length > maximum) throw new Error(`${name} must be at most ${maximum} characters.`);
  }
  if (!length) throw new Error(`${name} must not be empty.`);
}

function listLimit(values: string[] | undefined, name: string, minimum: number, maximum: number, itemMaximum: number): void {
  if (values === undefined) return;
  if (values.length < minimum || values.length > maximum) throw new Error(`${name} requires ${minimum}–${maximum} items.`);
  if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values.`);
  for (const value of values) stringLimit(value, `${name} item`, itemMaximum);
}

export function validateCommand(params: SubagentParams): asserts params is SubagentCommand {
  for (const name of ["prompt", "message"] as const) {
    if (params[name] !== undefined && Buffer.byteLength(params[name], "utf8") > MAX_TASK_BYTES) throw new Error(`${name} must be at most ${MAX_TASK_BYTES} bytes.`);
  }
  for (const [name, maximum] of [["label", 80], ["model", 512], ["cwd", 4096], ["id", 128], ["resume", 4096]] as const) {
    stringLimit(params[name], name, maximum);
  }
  if (params.label !== undefined) {
    if (!params.label.trim()) throw new Error("label must not be blank.");
    // oxlint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(params.label)) throw new Error("label must be one line without control characters.");
  }
  listLimit(params.tools, "tools", 0, 64, 256);
  if (params.tools?.some((name) => !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name))) throw new Error("tools must contain valid tool names.");
  listLimit(params.ids, "ids", 1, MAX_RETAINED_RUNS, 128);
  for (const [name, maximum] of [["timeoutMs", MAX_WAIT_MS], ["joinTimeoutMs", MAX_WAIT_MS], ["startupTimeoutMs", MAX_STARTUP_TIMEOUT_MS], ["executionTimeoutMs", MAX_PROCESS_TIMEOUT_MS]] as const) {
    const value = params[name];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum)) throw new Error(`${name} must be an integer from 1 to ${maximum} milliseconds.`);
  }
  const start = params.command === "run" || params.command === "spawn";
  if (start) {
    if (!params.prompt?.trim()) throw new Error(`${params.command} requires a non-blank prompt.`);
    if (params.id !== undefined || params.ids !== undefined || params.timeoutMs !== undefined || params.message !== undefined) throw new Error(`${params.command} accepts only child creation options${params.command === "run" ? " and joinTimeoutMs" : ""}; use ids/timeoutMs for wait, or id/message for steer.`);
    if (params.persist !== undefined && params.resume !== undefined) throw new Error("persist and resume are mutually exclusive.");
    if (params.command === "spawn" && params.joinTimeoutMs !== undefined) throw new Error("spawn does not join; joinTimeoutMs is only accepted by run.");
    if (params.model !== undefined && !params.model.trim()) throw new Error("Model must not be blank.");
    if (params.cwd !== undefined && !params.cwd.trim()) throw new Error("Working directory must not be blank.");
  } else {
    if (params.prompt !== undefined || params.label !== undefined || params.tools !== undefined || params.model !== undefined || params.thinking !== undefined || params.cwd !== undefined || params.executionTimeoutMs !== undefined || params.startupTimeoutMs !== undefined || params.joinTimeoutMs !== undefined || params.persist !== undefined || params.resume !== undefined || params.trustProject !== undefined) throw new Error(`${params.command} does not accept child creation or join options.`);
    if (params.command === "wait") {
      if (params.id !== undefined || !params.ids?.length) throw new Error('wait requires ids: ["<child-id>", ...], not id.');
      if (params.message !== undefined) throw new Error("message is only accepted by steer.");
      if (params.ids.some((id) => !id.trim())) throw new Error("Child ids must not be blank.");
    } else if (params.command === "steer") {
      if (!params.id?.trim()) throw new Error("steer requires id.");
      if (!params.message?.trim()) throw new Error("steer requires a non-blank message.");
      if (params.ids !== undefined || params.timeoutMs !== undefined) throw new Error("ids and timeoutMs are only accepted by wait.");
    } else {
      if (params.command === "stop" && !params.id?.trim()) throw new Error("stop requires id.");
      if (params.message !== undefined) throw new Error("message is only accepted by steer.");
      if (params.id !== undefined && !params.id.trim()) throw new Error("Child id must not be blank.");
      if (params.ids !== undefined || params.timeoutMs !== undefined) throw new Error("ids and timeoutMs are only accepted by wait.");
    }
  }
}

/** Resolve a child's working directory against the parent's; symlinks are canonicalized. */
export function resolveCwd(parentCwd: string, requested: string | undefined): string {
  const directory = path.resolve(parentCwd, requested ?? ".");
  let stats: fs.Stats;
  try {
    stats = fs.statSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") throw new Error(`Working directory is not a directory: ${directory}`);
    if (code === "ENOENT") throw new Error(`Working directory does not exist: ${directory}`);
    throw new Error(`Cannot access working directory: ${directory}`);
  }
  if (!stats.isDirectory()) throw new Error(`Working directory is not a directory: ${directory}`);
  return fs.realpathSync.native(directory);
}
