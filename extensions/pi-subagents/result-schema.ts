import type { StopReason } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { THINKING_LEVELS } from "./types.ts";

// Kept off the child execution path: these schemas describe parent-facing data.
export const OutcomeSchema = Type.Enum(["completed", "incomplete", "failed", "cancelled", "timed_out"] as const, { type: "string" });

/** Liveness is explicit; an assistant result does not imply process cleanup finished. */
export const ChildStateSchema = Type.Union([
  Type.Object({ status: Type.Literal("running") }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("terminal"),
    outcome: OutcomeSchema,
    exitCode: Type.Integer(),
    stopReason: Type.Optional(Type.Enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"] as const satisfies readonly StopReason[], { type: "string" })),
    finishedAt: Type.Number({ minimum: 0 }),
  }, { additionalProperties: false }),
]);

const usageFields = {
  input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }),
};
export const UsageSchema = Type.Object({
  ...usageFields,
  totalTokens: Type.Number({ minimum: 0 }),
  cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
  reasoning: Type.Optional(Type.Number({ minimum: 0 })),
  cost: Type.Object({ ...usageFields, total: Type.Number({ minimum: 0 }), totalFromProvider: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  turns: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const OutputTruncationSchema = Type.Object({
  truncated: Type.Boolean(),
  originalBytes: Type.Integer({ minimum: 0 }),
  retainedBytes: Type.Integer({ minimum: 0, description: "Retained UTF-8 bytes, including any truncation marker." }),
}, { additionalProperties: false });

export const ChildActivitySchema = Type.Enum(["model", "thinking", "text", "tool", "retry", "compaction"] as const, { type: "string",
  description: "Observed model/token/tool activity, Pi retry backoff, or compaction. No reasoning text or tool payloads.",
});

const ToolNameSchema = Type.String({ maxLength: 256, pattern: "^[A-Za-z][A-Za-z0-9_.:-]*$" });

export const ChildResultSchema = Type.Object({
  id: Type.String(),
  handle: Type.Optional(Type.String({ description: "Short session-scoped handle; preferred in wait/status/stop/steer calls." })),
  phase: Type.Optional(Type.Enum(["starting", "running", "stopping"] as const, { type: "string", description: "Live execution phase; absent once terminal." })),
  errorKind: Type.Optional(Type.Enum(["startup", "provider", "protocol", "deadline", "cancelled", "cleanup", "unknown"] as const, { type: "string" })),
  timeoutPhase: Type.Optional(Type.Enum(["startup", "execution"] as const, { type: "string", description: "Which deadline expired for a timed_out result." })),
  cleanupMs: Type.Optional(Type.Integer({ minimum: 0, description: "Process-tree cleanup time excluded from the reported task runtime." })),
  taskFinishedAt: Type.Optional(Type.Number({ minimum: 0, description: "Leader exit or terminal-cause time, before cleanup." })),
  deadline: Type.Optional(Type.Object({
    phase: Type.Enum(["startup", "execution"] as const, { type: "string" }),
    startedAt: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 }),
    expiresAt: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 }),
  }, { additionalProperties: false, description: "Effective phase deadline in Unix milliseconds, after defaults/environment resolution. Retained after termination; activity never extends it." })),
  lastActivityAt: Type.Optional(Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000, description: "Parent-observed Unix milliseconds of the latest foreground activity event, including Pi retry/compaction; retained after termination. Not a progress or stall verdict." })),
  activity: Type.Optional({ ...ChildActivitySchema, description: "Current observed activity; absent after execution stops." }),
  currentTool: Type.Optional({ ...ToolNameSchema, description: "An observed tool call from the requested allowlist; one name when calls overlap. Name only; no arguments or results. Absent after execution stops." }),
  interruption: Type.Optional(Type.Object({
    activity: Type.Optional(ChildActivitySchema),
    activeToolCount: Type.Integer({ minimum: 0, description: "Tool calls with observed start and no observed end at interruption; includes parallel/nested calls, not proof that execution or side effects occurred." }),
    currentTool: Type.Optional(ToolNameSchema),
  }, { additionalProperties: false, description: "Observation frozen when execution was interrupted, before cleanup. currentTool is one allowlisted name, not the complete set. Not a cause diagnosis, rollback record, or safe-retry guarantee." })),
  prompt: Type.String(),
  cwd: Type.String(),
  sessionFile: Type.Optional(Type.String({ description: "Child Pi session path for persist/resume, including failed runs. Startup failure may occur before the file is created." })),
  tools: Type.Array(Type.String()),
  omittedFields: Type.Optional(Type.Array(Type.Enum(["prompt", "cwd", "tools", "sessionFile"] as const, { type: "string" }), {
    uniqueItems: true, description: "Fields omitted to fit the response budget; empty placeholders are not execution values. Retrieve an omitted sessionFile with status for this child alone.",
  })),
  output: Type.Optional(Type.String({ description: "Completed assistant reports from this execution on success (including steering/follow-ups); bounded visible assistant-text history on failure or interruption. Not a complete execution trace." })),
  outputTruncation: Type.Optional(OutputTruncationSchema),
  stdout: Type.Optional(Type.String({ description: "Diagnostic stdout; never the child protocol." })),
  startedAt: Type.Optional(Type.Number({ minimum: 0 })),
  state: ChildStateSchema,
  errorMessage: Type.Optional(Type.String()),
  stderr: Type.String(),
  usage: UsageSchema,
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.Enum(THINKING_LEVELS, { type: "string", description: "Effective effort verified at child startup." })),
}, { additionalProperties: false });

/** One bounded envelope for tool details and structured results; notices carry handles only. */
export const SubagentDetailsSchema = Type.Object({
  command: Type.Enum(["run", "spawn", "status", "wait", "stop", "steer"] as const, { type: "string" }),
  results: Type.Array(ChildResultSchema),
  waitExpired: Type.Optional(Type.Boolean({ description: "Wait budget expired with no selected child complete; not a child timeout." })),
}, { additionalProperties: false });
