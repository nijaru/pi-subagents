import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { AgentConfig } from "./agents.ts";

import { MAX_CHAIN_STEPS, MAX_DIAGNOSTIC_BYTES, MAX_PARALLEL_TASKS, MAX_TASK_BYTES, MAX_WORKFLOW_STEPS } from "./limits.ts";
import type { SubagentDetails } from "./types.ts";
import { truncateOutput } from "./bounds.ts";

export type SubagentParams = Static<typeof SubagentParamsSchema>;

export const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke", minLength: 1, maxLength: 256 }),
  task: Type.String({ description: "Task to delegate", minLength: 1, maxLength: MAX_TASK_BYTES }),
  model: Type.Optional(Type.String({ description: "Optional model override for this task" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
}, { additionalProperties: false });

export const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke", minLength: 1, maxLength: 256 }),
  task: Type.String({ description: "Task, with optional {previous} for the preceding output", minLength: 1, maxLength: MAX_TASK_BYTES }),
  model: Type.Optional(Type.String({ description: "Optional model override for this step" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this step" })),
}, { additionalProperties: false });

export const WorkflowStep = Type.Object({
  id: Type.String({ description: "Stable workflow node id", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
  agent: Type.String({ description: "Name of the agent to invoke", minLength: 1, maxLength: 256 }),
  task: Type.String({ description: "Task, with optional {previous} for the preceding output", minLength: 1, maxLength: MAX_TASK_BYTES }),
  model: Type.Optional(Type.String({ description: "Optional model override for this node" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this node" })),
  onSuccess: Type.Optional(Type.String({ description: "Next node after a successful run", maxLength: 64 })),
  onFailure: Type.Optional(Type.String({ description: "Next node after a failed run", maxLength: 64 })),
}, { additionalProperties: false });

export const Workflow = Type.Object({
  start: Type.Optional(Type.String({ description: "Starting node id; defaults to the first node", maxLength: 64 })),
  steps: Type.Array(WorkflowStep, { description: `Bounded workflow nodes (maximum ${MAX_WORKFLOW_STEPS})`, maxItems: MAX_WORKFLOW_STEPS }),
}, { additionalProperties: false });

export const Background = Type.Object({
  action: StringEnum(["start", "status", "result", "stop"] as const, { description: "Background lifecycle action" }),
  runId: Type.Optional(Type.String({ description: "Background run id for status, result, or stop", minLength: 1, maxLength: 64 })),
  agent: Type.Optional(Type.String({ description: "Agent name for background start", minLength: 1, maxLength: 256 })),
  task: Type.Optional(Type.String({ description: "Task for background start", minLength: 1, maxLength: MAX_TASK_BYTES })),
}, { additionalProperties: false });

export const SubagentParamsSchema = Type.Object({
  action: Type.Optional(StringEnum(["list"] as const, { description: "List available agents" })),
  agent: Type.Optional(Type.String({ description: "Agent name for single mode", minLength: 1, maxLength: 256 })),
  task: Type.Optional(Type.String({ description: "Task for single mode", minLength: 1, maxLength: MAX_TASK_BYTES })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks (maximum 8)", maxItems: MAX_PARALLEL_TASKS })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential steps using {previous} (maximum 32)", maxItems: MAX_CHAIN_STEPS })),
  workflow: Type.Optional(Workflow),
  background: Type.Optional(Background),
  agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { description: "Agent scope; bundled agents are always included" })),
  model: Type.Optional(Type.String({ description: "Model override, provider/model-id; applies to every mode" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the delegation" })),
}, { additionalProperties: false });

export function requestedAgentNames(params: SubagentParams): string[] {
  const names = new Set<string>();
  if (params.agent) names.add(params.agent.trim());
  for (const task of params.tasks ?? []) names.add(task.agent.trim());
  for (const step of params.chain ?? []) names.add(step.agent.trim());
  for (const step of params.workflow?.steps ?? []) names.add(step.agent.trim());
  if (params.background?.action === "start" && params.background.agent) names.add(params.background.agent.trim());
  return [...names];
}

export function modeOf(params: SubagentParams): SubagentDetails["mode"] {
  if (params.background !== undefined) return "background";
  if (params.workflow !== undefined) return "workflow";
  if (params.chain !== undefined) return "chain";
  if (params.tasks !== undefined) return "parallel";
  return "single";
}

export function validSingle(params: SubagentParams): boolean {
  return typeof params.agent === "string" && params.agent.trim().length > 0 && typeof params.task === "string" && params.task.trim().length > 0;
}

export function hasValidItems(params: SubagentParams): boolean {
  return (params.tasks ?? []).every((item) => item.agent.trim().length > 0 && item.task.trim().length > 0)
    && (params.chain ?? []).every((item) => item.agent.trim().length > 0 && item.task.trim().length > 0)
    && (params.workflow?.steps ?? []).every((item) => item.agent.trim().length > 0 && item.task.trim().length > 0);
}

export function hasBlankModel(params: SubagentParams): boolean {
  return [
    params.model,
    ...(params.tasks ?? []).map((item) => item.model),
    ...(params.chain ?? []).map((item) => item.model),
    ...(params.workflow?.steps ?? []).map((item) => item.model),
  ].some((model) => model !== undefined && model.trim().length === 0);
}

export function availableText(agents: AgentConfig[]): string {
  return truncateOutput(agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none", MAX_DIAGNOSTIC_BYTES);
}
