import { StringEnum, type StopReason } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { THINKING_LEVELS } from "./types.ts";

// Kept off the child execution path: these schemas describe parent-facing data.
export const OutcomeSchema = StringEnum(["completed", "incomplete", "failed", "cancelled", "timed_out"] as const);

/** Liveness is explicit; an assistant result does not imply process cleanup finished. */
export const ChildStateSchema = Type.Union([
  Type.Object({ status: Type.Literal("running") }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("terminal"),
    outcome: OutcomeSchema,
    exitCode: Type.Integer(),
    stopReason: Type.Optional(StringEnum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"] as const satisfies readonly StopReason[])),
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
  cost: Type.Object({ ...usageFields, total: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
  turns: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const OutputTruncationSchema = Type.Object({
  truncated: Type.Boolean(),
  originalBytes: Type.Integer({ minimum: 0 }),
  retainedBytes: Type.Integer({ minimum: 0, description: "Retained UTF-8 bytes, including any truncation marker." }),
}, { additionalProperties: false });

export const ChildResultSchema = Type.Object({
  id: Type.String(),
  prompt: Type.String(),
  cwd: Type.String(),
  tools: Type.Array(Type.String()),
  output: Type.Optional(Type.String({ description: "Final assistant report, or partial output for an incomplete/failed child." })),
  outputTruncation: Type.Optional(OutputTruncationSchema),
  stdout: Type.Optional(Type.String({ description: "Diagnostic stdout; never the child protocol." })),
  startedAt: Type.Optional(Type.Number({ minimum: 0 })),
  state: ChildStateSchema,
  errorMessage: Type.Optional(Type.String()),
  stderr: Type.String(),
  usage: UsageSchema,
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Effective effort verified at child startup." })),
}, { additionalProperties: false });

/** One bounded envelope for tool details, structured results, and completion notices. */
export const SubagentDetailsSchema = Type.Object({
  command: StringEnum(["run", "spawn", "status", "wait", "stop"] as const),
  results: Type.Array(ChildResultSchema),
  waitExpired: Type.Optional(Type.Boolean({ description: "Wait budget expired with no selected child complete; not a child timeout." })),
}, { additionalProperties: false });
