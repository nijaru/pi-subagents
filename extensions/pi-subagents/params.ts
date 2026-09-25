import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { MAX_RETAINED_RUNS, MAX_TASK_BYTES, MAX_WAIT_MS } from "./limits.ts";
import { THINKING_LEVELS } from "./types.ts";

export const SubagentParamsSchema = Type.Object({
  command: StringEnum(["run", "spawn", "status", "wait", "stop"] as const, {
    description: "run/spawn require prompt: run joins for up to 60s then continues in background; spawn returns immediately. wait requires ids and returns when any finishes. status optionally takes id; stop requires id and cancels/joins cleanup.",
  }),
  prompt: Type.Optional(Type.String({ description: "Self-contained task: scope, relevant evidence, constraints, expected output and checks", minLength: 1, maxLength: MAX_TASK_BYTES })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z][A-Za-z0-9_.:-]*$" }), {
    description: "Tool allowlist, restricted to the parent's active tools. Defaults to available coding and known research tools; [] means reasoning only. No nested subagent tool.", maxItems: 64, uniqueItems: true,
  })),
  model: Type.Optional(Type.String({ description: "run/spawn only: exact provider/model-id; omitted inherits the parent model", minLength: 1, maxLength: 512 })),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS, {
    description: "run/spawn only: reasoning effort supported by the selected model. Omitted inherits parent effort for the same model; a different model uses its Pi defaults. Unsupported explicit levels fail before prompting.",
  })),
  cwd: Type.Optional(Type.String({ description: "Child working directory; relative to the parent cwd", minLength: 1, maxLength: 4096 })),
  id: Type.Optional(Type.String({ description: "status/stop only: child id; omit for status to list retained children", minLength: 1, maxLength: 128 })),
  ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    description: "wait only: child ids to join. Returns all ready reports and identifies still-running children when any finishes. Wait again only on remaining ids when blocked.",
    minItems: 1, maxItems: MAX_RETAINED_RUNS, uniqueItems: true,
  })),
  timeoutMs: Type.Optional(Type.Integer({ description: "wait only: shared wait budget, not a child deadline. Default 5 minutes, maximum 10; wakes early on completion. Cancelling wait leaves children running.", minimum: 1, maximum: MAX_WAIT_MS })),
}, { additionalProperties: false });

export type SubagentParams = Static<typeof SubagentParamsSchema>;

// Always offered by default, and the source of the research tools in the default
// allowlist below; `read` is filtered out there because it is listed explicitly.
export const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", "web_search", "web_fetch", "web_research", "resolve-library-id", "query-docs",
]);
const CODING_TOOLS = ["read", "bash", "edit", "write"];
const DEFAULT_TOOLS = [...CODING_TOOLS, ...[...READ_ONLY_TOOLS].filter((name) => name !== "read")];

export function selectTools(requested: string[] | undefined, active: string[]): string[] {
  const tools = requested ?? DEFAULT_TOOLS.filter((name) => active.includes(name));
  if (requested === undefined && tools.length === 0) throw new Error("No default child tools are active. Specify tools: [] for a reasoning-only task.");
  if (tools.some((name) => name === "subagent")) throw new Error("Children are leaves: the subagent tool cannot be delegated.");
  const unavailable = tools.filter((name) => !active.includes(name));
  if (unavailable.length) throw new Error(`Child tools must be active in the parent: ${unavailable.join(", ")}.`);
  return [...tools];
}

export function validateCommand(params: SubagentParams): void {
  const start = params.command === "run" || params.command === "spawn";
  if (start) {
    if (!params.prompt?.trim()) throw new Error(`${params.command} requires a non-blank prompt.`);
    if (Buffer.byteLength(params.prompt, "utf8") > MAX_TASK_BYTES) throw new Error(`Prompt must be at most ${MAX_TASK_BYTES} bytes.`);
    if (params.id !== undefined || params.ids !== undefined || params.timeoutMs !== undefined) throw new Error(`${params.command} accepts only prompt, tools, model, thinking and cwd.`);
    if (params.model !== undefined && !params.model.trim()) throw new Error("Model must not be blank.");
    if (params.cwd !== undefined && !params.cwd.trim()) throw new Error("Working directory must not be blank.");
  } else {
    if (params.prompt !== undefined || params.tools !== undefined || params.model !== undefined || params.thinking !== undefined || params.cwd !== undefined) throw new Error(`${params.command} does not accept child creation options.`);
    if (params.command === "wait") {
      if (params.id !== undefined || !params.ids?.length) throw new Error('wait requires ids: ["<child-id>", ...], not id.');
      if (params.ids.some((id) => !id.trim())) throw new Error("Child ids must not be blank.");
    } else {
      if (params.command === "stop" && !params.id?.trim()) throw new Error("stop requires id.");
      if (params.id !== undefined && !params.id.trim()) throw new Error("Child id must not be blank.");
      if (params.ids !== undefined || params.timeoutMs !== undefined) throw new Error("ids and timeoutMs are only accepted by wait.");
    }
  }
}

/** Resolve a child's working directory against the parent's; symlinks are canonicalized. */
export function resolveCwd(parentCwd: string, requested: string | undefined): string {
  const directory = path.resolve(parentCwd, requested ?? ".");
  try {
    if (fs.statSync(directory).isDirectory()) return fs.realpathSync.native(directory);
  } catch { /* Report one actionable diagnostic for missing and invalid paths. */ }
  throw new Error(`Working directory does not exist: ${directory}`);
}
