import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryResult, AgentScope } from "./agents.ts";
import { findNearestProjectRoot } from "./agents.ts";

import { DEPTH_ENV, MAX_BACKGROUND_ACTIVE, MAX_BACKGROUND_RUNS, MAX_CHAIN_CONTEXT_BYTES, MAX_CHAIN_STEPS, MAX_DEPTH, MAX_DIAGNOSTIC_BYTES, MAX_OUTPUT_BYTES, MAX_PARALLEL_TASKS, MAX_TASK_BYTES, MAX_WORKFLOW_STEPS, MAX_WORKFLOW_TRANSITIONS } from "./limits.ts";
import { emptyUsage, getFinalOutput } from "./types.ts";
import type { AgentResult, SubagentDetails } from "./types.ts";
import { boundDetails, interpolatePrevious, truncateOutput } from "./bounds.ts";
import type { ControlContext, DelegationPolicy, DepthStatus } from "./control.ts";
import type { ChildRunRequest, ChildSupervisor, ExecutionContext } from "./supervisor.ts";
import { copyResult, failed, modelName, potentiallyMutating, resolveModel, resultText } from "./supervisor.ts";
import { formatDuration } from "./render.ts";
import { backgroundActive, backgroundStatus, backgroundSummary, backgroundText, backgroundToolDetails, pruneBackgroundRuns } from "./background.ts";
import type { BackgroundRun } from "./background.ts";
import type { SubagentParams } from "./params.ts";
import { hasBlankModel, hasValidItems, modeOf, requestedAgentNames, validSingle } from "./params.ts";

export type BaseDetailsFn = (mode: SubagentDetails["mode"], results: AgentResult[], action?: SubagentDetails["action"]) => SubagentDetails;

export class SubagentExecutionError extends Error {
  constructor(message: string, readonly details: SubagentDetails) {
    super(message);
    this.name = "SubagentExecutionError";
  }
}

export function toolResult(text: string, details: SubagentDetails, isError = false): AgentToolResult<SubagentDetails> {
  const boundedText = truncateOutput(text, MAX_OUTPUT_BYTES);
  const bounded = boundDetails(details);
  // pi-agent-core intentionally turns thrown tool errors into its normal error
  // result and does not preserve custom Error fields. Keep throwing for that
  // semantic, but do not claim these details survive that boundary.
  if (isError) throw new SubagentExecutionError(boundedText, bounded);
  return { content: [{ type: "text", text: boundedText }], details: bounded };
}

export function cwdFor(base: string, value: string | undefined): string {
  return path.resolve(base, value ?? ".");
}

export function existingDirectory(directory: string): string | undefined {
  try {
    if (!fs.statSync(directory).isDirectory()) return undefined;
    return fs.realpathSync.native(directory);
  } catch {
    return undefined;
  }
}

function isWithinDirectory(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function requestedProjectAgents(names: string[], agents: AgentConfig[]): AgentConfig[] {
  return names.map((name) => agents.find((agent) => agent.name === name)).filter((agent): agent is AgentConfig => agent?.source === "project");
}

export async function confirmProjectAgents(
  ctx: ExtensionContext,
  names: string[],
  agents: AgentConfig[],
  projectAgentsDir: string | null,
  trustedProjectRoot: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<{ allowed: boolean; reason?: string }> {
  const projectAgents = requestedProjectAgents(names, agents);
  if (projectAgents.length === 0) return { allowed: true };

  // A UI confirmation is not available in print/RPC mode. Requiring both pi's
  // project-trust decision and this explicit confirmation prevents a model from
  // opting into a repository-controlled prompt without a user-approved boundary.
  if (projectRoot !== trustedProjectRoot) {
    return { allowed: false, reason: "Project agents must belong to the trusted project cwd." };
  }
  if (typeof ctx.isProjectTrusted === "function" && !ctx.isProjectTrusted()) {
    return { allowed: false, reason: "The current project is not trusted by pi." };
  }
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
    return { allowed: false, reason: "Project agents require an interactive confirmation; headless delegation cannot run repository-controlled prompts." };
  }
  const allowed = await ctx.ui.confirm(
    "Use project-local agents?",
    `Agents: ${truncateOutput(projectAgents.map((agent) => agent.name).join(", "), MAX_DIAGNOSTIC_BYTES)}\nSource: ${projectAgentsDir ?? "unknown"}\n\nProject agents are repository-controlled prompts. Only continue for trusted repositories.`,
    { signal },
  );
  return allowed ? { allowed: true } : { allowed: false, reason: "Project-local agents were not approved." };
}

export interface ListEnv {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  visibleAgents: AgentConfig[];
  discovery: AgentDiscoveryResult;
  trustedProjectRoot: string;
  projectRoot: string;
  baseDetails: BaseDetailsFn;
}

/** Metadata-only agent listing; renders no body in the interactive TUI. */
export async function runListAction(env: ListEnv): Promise<AgentToolResult<SubagentDetails>> {
  const listApproval = await confirmProjectAgents(
    env.ctx,
    env.visibleAgents.filter((agent) => agent.source === "project").map((agent) => agent.name),
    env.discovery.agents,
    env.discovery.projectAgentsDir,
    env.trustedProjectRoot,
    env.projectRoot,
    env.signal,
  );
  if (!listApproval.allowed) {
    return toolResult(listApproval.reason ?? "Project-local agents were not approved.", env.baseDetails("single", []), true);
  }
  const lines = env.visibleAgents.map((agent) => {
    const configuredModel = agent.model ? ` [${agent.model}]` : " [parent model]";
    const tools = agent.tools?.length ? agent.tools.join(",") : "none";
    const capability = agent.capability ?? "unspecified";
    const delegation = agent.delegation ? "yes" : "no";
    const outputSchema = agent.outputSchema ? "yes" : "no";
    const allowedAgents = agent.allowedAgents?.join(",") || "any";
    const maxDelegationDepth = agent.maxDelegationDepth === undefined ? "global" : String(agent.maxDelegationDepth);
    return `${agent.name}: ${agent.description}${configuredModel} (${agent.source}; capability=${capability}; delegation=${delegation}; outputSchema=${outputSchema}; allowedAgents=${allowedAgents}; maxDelegationDepth=${maxDelegationDepth}; tools=${tools})`;
  });
  return toolResult(lines.length ? `Available agents:\n${lines.join("\n")}` : "No agents found.", env.baseDetails("single", [], "list"));
}

/**
 * Background status/result/stop handling. These observe the in-memory registry
 * and never spawn, so they return before spawn-guard validation (policy, depth
 * budget, task sizes) that only constrains new work. Depth itself still
 * applies: background runs are a top-level-only lifecycle.
 */
export async function handleBackgroundQuery(
  params: SubagentParams,
  depth: DepthStatus,
  backgroundRuns: Map<string, BackgroundRun>,
  baseDetails: BaseDetailsFn,
): Promise<AgentToolResult<SubagentDetails>> {
  const background = params.background!;
  if (depth.depth > 0) {
    return toolResult("Background runs are only available from the top-level Pi session.", baseDetails("background", []), true);
  }
  if (background.agent !== undefined || background.task !== undefined || params.model !== undefined || params.cwd !== undefined) {
    return toolResult(`Background ${background.action} accepts only runId.`, backgroundToolDetails(background.action), true);
  }
  if (!background.runId?.trim()) {
    if (background.action !== "status") {
      return toolResult(`Background ${background.action} requires runId.`, backgroundToolDetails(background.action), true);
    }
    const summaries = [...backgroundRuns.values()].map(backgroundSummary);
    const text = summaries.length === 0
      ? "No background runs."
      : summaries.map((run) => {
        const duration = formatDuration(run.startedAt, run.finishedAt);
        const runtime = duration ? ` · ${duration}${run.status === "starting" || run.status === "running" ? " elapsed" : ""}` : "";
        return `${run.agent} [${run.status}${runtime}] (${run.runId})`;
      }).join("\n");
    return toolResult(text, backgroundToolDetails("status", undefined, [], summaries));
  }
  const target = backgroundRuns.get(background.runId.trim());
  if (!target) {
    return toolResult(`Unknown background run: ${background.runId.trim()}.`, backgroundToolDetails(background.action), true);
  }
  if (background.action === "status") {
    return toolResult(backgroundText(target), backgroundToolDetails("status", target, target.result ? [copyResult(target.result)] : []));
  }
  if (background.action === "stop") {
    if (backgroundActive(target)) {
      target.controller.abort();
      if (target.promise) await target.promise;
    }
    return toolResult(backgroundText(target), backgroundToolDetails("stop", target, target.result ? [copyResult(target.result)] : []), target.details.status === "failed" || target.details.status === "timed_out");
  }
  if (backgroundActive(target)) {
    return toolResult(`${backgroundText(target)}\nUse background status while it runs, then request result again.`, backgroundToolDetails("result", target, target.result ? [copyResult(target.result)] : []));
  }
  return toolResult(resultText(target.result!), backgroundToolDetails("result", target, target.result ? [copyResult(target.result)] : []), target.details.status !== "completed");
}

export interface ValidationEnv {
  params: SubagentParams;
  depth: DepthStatus;
  inheritedPolicy?: DelegationPolicy;
  discovery: AgentDiscoveryResult;
  baseDetails: BaseDetailsFn;
}

/**
 * Spawn-guard validation for new delegations: mode shape, nested policy,
 * budgets, and filesystem preconditions. Returns normally when the request
 * may proceed; throws a tool error otherwise.
 */
export function validateDelegationRequest(env: ValidationEnv): void {
  const { params, depth, inheritedPolicy, discovery, baseDetails } = env;
  const hasSingle = params.agent !== undefined || params.task !== undefined;
  const hasBackground = params.background !== undefined;
  if (hasSingle && !validSingle(params)) {
    return toolResult("Single mode requires both a non-blank agent and task.", baseDetails("single", []), true) as never;
  }
  if (params.tasks && params.tasks.length === 0) {
    return toolResult("Parallel mode requires at least one task.", baseDetails("parallel", []), true) as never;
  }
  if (params.chain && params.chain.length === 0) {
    return toolResult("Chain mode requires at least one step.", baseDetails("chain", []), true) as never;
  }
  if (params.workflow && params.workflow.steps.length === 0) {
    return toolResult("Workflow mode requires at least one step.", baseDetails("workflow", []), true) as never;
  }
  if (hasBackground) {
    const background = params.background!;
    if (depth.depth > 0) {
      return toolResult("Background runs are only available from the top-level Pi session.", baseDetails("background", []), true) as never;
    }
    if (background.action === "start") {
      if (!background.agent?.trim() || !background.task?.trim()) {
        return toolResult("Background start requires both a non-blank agent and task.", baseDetails("background", []), true) as never;
      }
      if (background.runId) {
        return toolResult("Background start must not include runId.", baseDetails("background", []), true) as never;
      }
      const backgroundAgent = discovery.agents.find((agent) => agent.name === background.agent!.trim());
      if (backgroundAgent?.delegation) {
        return toolResult("Background runs cannot use delegation-capable agents; start one child without nested delegation.", baseDetails("background", []), true) as never;
      }
    }
  }
  if (!hasValidItems(params)) {
    return toolResult("Agent names and tasks must not be blank.", baseDetails(modeOf(params), []), true) as never;
  }
  if (inheritedPolicy?.allowedAgents && requestedAgentNames(params).some((name) => !inheritedPolicy.allowedAgents!.includes(name))) {
    return toolResult(`Nested delegation is restricted to: ${inheritedPolicy.allowedAgents.join(", ") || "none"}.`, baseDetails(modeOf(params), []), true) as never;
  }
  if (inheritedPolicy?.remainingDepth !== undefined && inheritedPolicy.remainingDepth <= 0) {
    return toolResult("Nested delegation depth policy does not permit another level.", baseDetails(modeOf(params), []), true) as never;
  }
  if (hasBlankModel(params)) {
    return toolResult("Model overrides must not be blank.", baseDetails(modeOf(params), []), true) as never;
  }
  if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
    return toolResult(`Too many parallel tasks (${params.tasks.length}). Maximum is ${MAX_PARALLEL_TASKS}.`, baseDetails("parallel", []), true) as never;
  }
  if (params.chain && params.chain.length > MAX_CHAIN_STEPS) {
    return toolResult(`Too many chain steps (${params.chain.length}). Maximum is ${MAX_CHAIN_STEPS}.`, baseDetails("chain", []), true) as never;
  }
  if (params.workflow && params.workflow.steps.length > MAX_WORKFLOW_STEPS) {
    return toolResult(`Too many workflow steps (${params.workflow.steps.length}). Maximum is ${MAX_WORKFLOW_STEPS}.`, baseDetails("workflow", []), true) as never;
  }
  if (params.workflow) {
    const steps = params.workflow.steps;
    const ids = new Set<string>();
    for (const step of steps) {
      if (ids.has(step.id)) {
        return toolResult(`Workflow node ids must be unique: "${step.id}".`, baseDetails("workflow", []), true) as never;
      }
      ids.add(step.id);
    }
    const start = params.workflow.start ?? steps[0]?.id;
    if (!start || !ids.has(start)) {
      return toolResult(`Workflow start node does not exist: "${start ?? ""}".`, baseDetails("workflow", []), true) as never;
    }
    for (const step of steps) {
      for (const next of [step.onSuccess, step.onFailure]) {
        if (next !== undefined && !ids.has(next)) {
          return toolResult(`Workflow node "${step.id}" references missing node "${next}".`, baseDetails("workflow", []), true) as never;
        }
      }
    }
  }
  const texts = [
    params.task,
    ...(params.tasks ?? []).map((item) => item.task),
    ...(params.chain ?? []).map((item) => item.task),
    ...(params.workflow?.steps ?? []).map((item) => item.task),
    ...(hasBackground && params.background!.action === "start" ? [params.background!.task] : []),
  ];
  if (texts.some((text) => text !== undefined && Buffer.byteLength(text, "utf8") > MAX_TASK_BYTES)) {
    return toolResult(`Tasks must be at most ${MAX_TASK_BYTES} bytes.`, baseDetails(modeOf(params), []), true) as never;
  }

  if (!depth.valid || depth.depth >= MAX_DEPTH) {
    return toolResult(
      `Subagent depth limit reached or invalid ${DEPTH_ENV}; refusing to spawn (maximum depth ${MAX_DEPTH}).`,
      baseDetails(modeOf(params), []),
      true,
    ) as never;
  }
}

export interface TaskGuardEnv {
  params: SubagentParams;
  requestedRoot: string;
  rootCwd: string | undefined;
  discovery: AgentDiscoveryResult;
  trustedProjectRoot: string;
  backgroundRuns: Map<string, BackgroundRun>;
  baseDetails: BaseDetailsFn;
}

/**
 * Per-task working-directory and mutation-safety guards. Resolves every task
 * location (including background starts) against the canonical root cwd,
 * keeps project agents inside the trusted project, and rejects concurrent
 * mutators that share a project root. Returns the verified canonical root cwd.
 */
export function checkTaskLocations(env: TaskGuardEnv): string {
  const { params, requestedRoot, rootCwd, discovery, trustedProjectRoot, backgroundRuns, baseDetails } = env;
  if (!rootCwd) {
    return toolResult(`Working directory does not exist: ${requestedRoot}`, baseDetails(modeOf(params), []), true) as never;
  }
  const hasSingle = params.agent !== undefined || params.task !== undefined;
  const hasParallel = params.tasks !== undefined;
  const hasBackground = params.background !== undefined;
  const projectAgentNames = new Set(requestedProjectAgents(requestedAgentNames(params), discovery.agents).map((agent) => agent.name));
  const taskLocations = [
    ...(hasSingle ? [{ agent: params.agent!, task: params.task!, cwd: undefined }] : []),
    ...(params.tasks ?? []),
    ...(params.chain ?? []),
    ...(params.workflow?.steps ?? []),
    ...(hasBackground && params.background!.action === "start" ? [{ agent: params.background!.agent!, task: params.background!.task!, cwd: undefined }] : []),
  ];
  const activeBackgroundMutationRoots = new Set([...backgroundRuns.values()].filter((run) => run.mutating && (run.details.status === "starting" || run.details.status === "running")).map((run) => run.projectRoot));
  const parallelMutators = new Map<string, string[]>();
  for (const item of taskLocations) {
    const requestedCwd = cwdFor(rootCwd, item.cwd);
    const taskCwd = existingDirectory(requestedCwd);
    if (!taskCwd) {
      return toolResult(`Working directory does not exist: ${requestedCwd}`, baseDetails(modeOf(params), []), true) as never;
    }
    if (projectAgentNames.has(item.agent.trim()) && !isWithinDirectory(trustedProjectRoot, taskCwd)) {
      return toolResult(
        `Project agent "${item.agent.trim()}" may only run within the trusted project cwd (project root): ${trustedProjectRoot}`,
        baseDetails(modeOf(params), []),
        true,
      ) as never;
    }
    const configuredAgent = discovery.agents.find((agent) => agent.name === item.agent.trim());
    // Unknown names are reported by the supervisor, not the mutation guard;
    // grouping them as mutating would mask the real "Unknown agent" error.
    const mutating = configuredAgent ? potentiallyMutating(configuredAgent) : false;
    const conflictRoot = findNearestProjectRoot(taskCwd) ?? taskCwd;
    if (mutating && activeBackgroundMutationRoots.has(conflictRoot)) {
      return toolResult(
        `Background mutation rejected: a background run already owns project root ${conflictRoot}. Stop it or use a distinct project root.`,
        baseDetails(modeOf(params), []),
        true,
      ) as never;
    }
    if (hasParallel && mutating) {
      // Distinct subdirectories of one repository still share files and
      // Git state. Reject concurrent mutators at the nearest project root,
      // falling back to the canonical cwd outside recognized projects.
      const names = parallelMutators.get(conflictRoot) ?? [];
      names.push(item.agent.trim());
      parallelMutators.set(conflictRoot, names);
    }
  }
  if (hasParallel) {
    for (const [taskCwd, names] of parallelMutators) {
      if (names.length > 1) {
        return toolResult(
          `Parallel mutation rejected: potentially mutating agents (${names.join(", ")}) share project root ${taskCwd}. Use distinct project roots or a serial chain.`,
          baseDetails("parallel", []),
          true,
        ) as never;
      }
    }
  }
  return rootCwd;
}

function terminalWorkflowFailure(result: AgentResult, signal?: AbortSignal): boolean {
  if (signal?.aborted || result.termination === "cancelled" || result.termination === "timed_out") return true;
  const diagnostic = result.errorMessage ?? "";
  return /Root (?:descendant budget exhausted|subagent deadline reached)|Timed out acquiring subagent control state lock|reservation is missing|control state is malformed/i.test(diagnostic);
}

function missingStepCwdResult(agent: string, task: string, step: number, execution: ExecutionContext, requestedStepCwd: string): AgentResult {
  return {
    agent: agent.trim(),
    agentSource: "unknown",
    task: truncateOutput(task, MAX_DIAGNOSTIC_BYTES),
    runId: randomUUID(),
    parentRunId: execution.runId,
    rootRunId: execution.rootRunId,
    depth: execution.depth + 1,
    step,
    exitCode: 1,
    stopReason: "error",
    termination: "failed",
    errorMessage: truncateOutput(`Working directory does not exist: ${requestedStepCwd}`, MAX_DIAGNOSTIC_BYTES),
    stderr: "",
    messages: [],
    usage: emptyUsage(),
  };
}

export interface ModeEnv {
  params: SubagentParams;
  signal?: AbortSignal;
  rootCwd: string;
  agentScope: AgentScope;
  discovery: AgentDiscoveryResult;
  projectRoot: string;
  parentModel: Model<any> | undefined;
  control: ControlContext;
  execution: ExecutionContext;
  supervisor: ChildSupervisor;
  backgroundRuns: Map<string, BackgroundRun>;
  cleanupBackgroundRun: (run: BackgroundRun) => Promise<void>;
  baseDetails: BaseDetailsFn;
  notify: (text: string, details: SubagentDetails) => void;
  emitSingle: (mode: SubagentDetails["mode"], results: AgentResult[], result: AgentResult, progress?: string) => void;
}

export async function runSingleMode(env: ModeEnv): Promise<AgentToolResult<SubagentDetails>> {
  const result = await env.supervisor.run({
    name: env.params.agent!.trim(),
    task: env.params.task!,
    cwd: env.rootCwd,
    modelOverride: env.params.model,
    signal: env.signal,
    emit: (current, progress) => env.emitSingle("single", [current], current, progress),
  });
  return toolResult(resultText(result), env.baseDetails("single", [result]), failed(result));
}

export async function runParallelMode(env: ModeEnv): Promise<AgentToolResult<SubagentDetails>> {
  const placeholders: AgentResult[] = (env.params.tasks ?? []).map((task) => {
    const configuredAgent = env.discovery.agents.find((agent) => agent.name === task.agent.trim());
    return {
      agent: task.agent.trim(),
      agentSource: configuredAgent?.source ?? "unknown",
      task: truncateOutput(task.task, MAX_DIAGNOSTIC_BYTES),
      runId: randomUUID(),
      parentRunId: env.execution.runId,
      rootRunId: env.execution.rootRunId,
      depth: env.execution.depth + 1,
      exitCode: -1,
      stderr: "",
      messages: [],
      usage: emptyUsage(),
      model: configuredAgent
        ? resolveModel(configuredAgent, env.params.model ?? task.model, env.parentModel)
        : env.params.model ?? task.model ?? modelName(env.parentModel),
    };
  });
  const current = placeholders.map(copyResult);
  try {
    env.notify(`Parallel: 0/${current.length} done`, env.baseDetails("parallel", current));
  } catch (error) {
    return toolResult(`Subagent update failed: ${error instanceof Error ? error.message : String(error)}`, env.baseDetails("parallel", current), true);
  }
  const requests = env.params.tasks!.map((task, index): ChildRunRequest => ({
    name: task.agent.trim(),
    task: task.task,
    cwd: existingDirectory(cwdFor(env.rootCwd, task.cwd)) ?? cwdFor(env.rootCwd, task.cwd),
    modelOverride: env.params.model ?? task.model,
    signal: env.signal,
    emit: (result, progress) => {
      current[index] = copyResult(result);
      const done = current.filter((item) => item.exitCode !== -1).length;
      env.notify(progress ?? `Parallel: ${done}/${current.length} done`, env.baseDetails("parallel", current.map(copyResult)));
    },
  }));
  const results = await env.supervisor.runBatch(requests);
  const successCount = results.filter((result) => !failed(result)).length;
  const summary = results.map((result) => {
    const status = failed(result)
      ? `failed${result.termination ? ` (${result.termination})` : result.stopReason ? ` (${result.stopReason})` : ""}`
      : result.termination ?? "completed";
    return `### [${result.agent}] ${status}\n\n${truncateOutput(resultText(result), MAX_DIAGNOSTIC_BYTES)}`;
  }).join("\n\n---\n\n");
  return toolResult(`Parallel: ${successCount}/${results.length} succeeded\n\n${truncateOutput(summary, MAX_OUTPUT_BYTES)}`, env.baseDetails("parallel", results), successCount !== results.length);
}

export async function runChainMode(env: ModeEnv): Promise<AgentToolResult<SubagentDetails>> {
  const results: AgentResult[] = [];
  let previous = "";
  for (let index = 0; index < env.params.chain!.length; index++) {
    const step = env.params.chain![index]!;
    const task = interpolatePrevious(step.task, previous, MAX_TASK_BYTES);
    const requestedStepCwd = cwdFor(env.rootCwd, step.cwd);
    const stepCwd = existingDirectory(requestedStepCwd);
    if (!stepCwd) {
      const errorResult = missingStepCwdResult(step.agent, task, index + 1, env.execution, requestedStepCwd);
      results.push(errorResult);
      return toolResult(`Chain stopped at step ${index + 1} (${step.agent}): ${resultText(errorResult)}`, env.baseDetails("chain", results), true);
    }
    const result = await env.supervisor.run({
      name: step.agent.trim(),
      task,
      cwd: stepCwd,
      modelOverride: env.params.model ?? step.model,
      step: index + 1,
      signal: env.signal,
      emit: (current, progress) => env.emitSingle("chain", [...results, current], current, progress),
    });
    results.push(result);
    if (failed(result)) {
      return toolResult(`Chain stopped at step ${index + 1} (${step.agent}): ${resultText(result)}`, env.baseDetails("chain", results), true);
    }
    previous = truncateOutput(result.output || getFinalOutput(result.messages), MAX_CHAIN_CONTEXT_BYTES);
  }
  const finalResult = results[results.length - 1];
  return toolResult(finalResult ? resultText(finalResult) : "(no output)", env.baseDetails("chain", results));
}

export async function runWorkflowMode(env: ModeEnv): Promise<AgentToolResult<SubagentDetails>> {
  const workflow = env.params.workflow!;
  const steps = new Map(workflow.steps.map((step) => [step.id, step]));
  const results: AgentResult[] = [];
  let currentId = workflow.start ?? workflow.steps[0]!.id;
  let previous = "";
  for (let transition = 0; transition < MAX_WORKFLOW_TRANSITIONS; transition++) {
    const step = steps.get(currentId);
    if (!step) {
      return toolResult(`Workflow reached missing node "${currentId}".`, env.baseDetails("workflow", results), true);
    }
    const task = interpolatePrevious(step.task, previous, MAX_TASK_BYTES);
    const requestedStepCwd = cwdFor(env.rootCwd, step.cwd);
    const stepCwd = existingDirectory(requestedStepCwd);
    if (!stepCwd) {
      const errorResult = missingStepCwdResult(step.agent, task, transition + 1, env.execution, requestedStepCwd);
      results.push(errorResult);
      return toolResult(`Workflow stopped at ${step.id} (${step.agent}): ${resultText(errorResult)}`, env.baseDetails("workflow", results), true);
    }
    const result = await env.supervisor.run({
      name: step.agent.trim(),
      task,
      cwd: stepCwd,
      modelOverride: env.params.model ?? step.model,
      step: transition + 1,
      signal: env.signal,
      emit: (current, progress) => env.emitSingle("workflow", [...results, current], current, progress),
    });
    results.push(result);
    const failedRun = failed(result);
    previous = truncateOutput(result.output || resultText(result), MAX_CHAIN_CONTEXT_BYTES);
    if (failedRun && terminalWorkflowFailure(result, env.signal)) {
      return toolResult(`Workflow stopped at ${step.id} (${step.agent}): ${resultText(result)}`, env.baseDetails("workflow", results), true);
    }
    const next = failedRun ? step.onFailure : step.onSuccess;
    if (!next) {
      if (failedRun) {
        return toolResult(`Workflow stopped at ${step.id} (${step.agent}): ${resultText(result)}`, env.baseDetails("workflow", results), true);
      }
      return toolResult(resultText(result), env.baseDetails("workflow", results));
    }
    currentId = next;
  }
  return toolResult(`Workflow exceeded the ${MAX_WORKFLOW_TRANSITIONS}-transition root budget.`, env.baseDetails("workflow", results), true);
}

export async function startBackgroundRun(env: ModeEnv): Promise<AgentToolResult<SubagentDetails>> {
  const background = env.params.background!;
  await Promise.all([...env.backgroundRuns.values()]
    .filter((run) => !backgroundActive(run) && !run.cleanedUp)
    .map((run) => env.cleanupBackgroundRun(run)));
  pruneBackgroundRuns(env.backgroundRuns);
  if ([...env.backgroundRuns.values()].filter(backgroundActive).length >= MAX_BACKGROUND_ACTIVE) {
    return toolResult(`Too many active background runs. Maximum is ${MAX_BACKGROUND_ACTIVE}.`, backgroundToolDetails("start"), true);
  }
  if (env.backgroundRuns.size >= MAX_BACKGROUND_RUNS) {
    return toolResult(`Too many retained background runs. Maximum is ${MAX_BACKGROUND_RUNS}. Retrieve or stop an existing run before starting another.`, backgroundToolDetails("start"), true);
  }
  const backgroundAgent = background.agent!.trim();
  const backgroundConfigured = env.discovery.agents.find((agent) => agent.name === backgroundAgent);
  const backgroundMutating = backgroundConfigured ? potentiallyMutating(backgroundConfigured) : false;
  const backgroundRun: BackgroundRun = {
    details: {
      runId: randomUUID(),
      agent: backgroundAgent,
      status: "starting",
      createdAt: Date.now(),
    },
    task: background.task!,
    cwd: env.rootCwd,
    agentScope: env.agentScope,
    projectAgentsDir: env.discovery.projectAgentsDir,
    projectRoot: env.projectRoot,
    mutating: backgroundMutating,
    control: env.control,
    controller: new AbortController(),
    cleanedUp: false,
  };
  env.backgroundRuns.set(backgroundRun.details.runId, backgroundRun);
  const backgroundPromise = env.supervisor.run({
    name: backgroundRun.details.agent,
    task: backgroundRun.task,
    cwd: backgroundRun.cwd,
    modelOverride: env.params.model,
    signal: backgroundRun.controller.signal,
    emit: (current, progress) => {
      backgroundRun.result = copyResult(current);
      if (current.startedAt !== undefined) backgroundRun.details.startedAt = current.startedAt;
      if (current.finishedAt !== undefined) backgroundRun.details.finishedAt = current.finishedAt;
      if (backgroundRun.details.status === "starting") backgroundRun.details.status = "running";
      if (progress) backgroundRun.details.progress = truncateOutput(progress, MAX_DIAGNOSTIC_BYTES);
    },
  }).then((result) => {
    backgroundRun.result = copyResult(result);
    backgroundRun.details.status = backgroundStatus(result);
    backgroundRun.details.finishedAt = result.finishedAt ?? Date.now();
    backgroundRun.details.progress = truncateOutput(resultText(result), MAX_DIAGNOSTIC_BYTES);
    return result;
  }).catch((error) => {
    const result: AgentResult = {
      agent: backgroundRun.details.agent,
      agentSource: "unknown",
      task: truncateOutput(backgroundRun.task, MAX_DIAGNOSTIC_BYTES),
      runId: backgroundRun.details.runId,
      parentRunId: undefined,
      rootRunId: backgroundRun.control.rootRunId,
      depth: 1,
      exitCode: 1,
      stopReason: "error",
      termination: "failed",
      errorMessage: truncateOutput(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_BYTES),
      stderr: "",
      messages: [],
      usage: emptyUsage(),
    };
    backgroundRun.result = result;
    backgroundRun.details.status = "failed";
    backgroundRun.details.finishedAt = Date.now();
    backgroundRun.details.progress = truncateOutput(result.errorMessage ?? "Background run failed.", MAX_DIAGNOSTIC_BYTES);
    return result;
  }).finally(() => env.cleanupBackgroundRun(backgroundRun));
  backgroundRun.promise = backgroundPromise;
  return toolResult(`Started background run ${backgroundRun.details.runId} for ${backgroundRun.details.agent}.`, backgroundToolDetails("start", backgroundRun));
}
