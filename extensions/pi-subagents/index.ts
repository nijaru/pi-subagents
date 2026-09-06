import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { discoverAgents, findNearestProjectRoot } from "./agents.ts";

import { DEADLINE_ENV, DEPTH_ENV, MAX_BACKGROUND_ACTIVE, MAX_BACKGROUND_RUNS, MAX_CHAIN_CONTEXT_BYTES, MAX_CHAIN_STEPS, MAX_CONCURRENCY, MAX_DEPTH, MAX_DIAGNOSTIC_BYTES, MAX_OUTPUT_BYTES, MAX_PARALLEL_TASKS, MAX_TASK_BYTES, MAX_WORKFLOW_STEPS, MAX_WORKFLOW_TRANSITIONS, ROOT_ID_ENV, RUN_ID_ENV } from "./limits.ts";
import { emptyUsage, getFinalOutput, isFiniteNumber } from "./types.ts";
import type { AgentResult, SubagentDetails } from "./types.ts";
import { boundDetails, interpolatePrevious, truncateOutput } from "./bounds.ts";
import { createControlState, inheritedControlState, readDelegationPolicy, readDepth, releaseChild, reserveChild } from "./control.ts";
import type { ControlContext } from "./control.ts";
import { activeChildren, terminateProcessTree, waitForChildren } from "./subprocess.ts";
import { SubprocessChildSupervisor, copyResult, failed, modelName, potentiallyMutating, resolveModel, resultText } from "./supervisor.ts";
import type { ChildRunRequest, ChildSupervisor, ExecutionContext } from "./supervisor.ts";
import { aggregateUsage, formatDuration, formatUsage, isRenderableAgentResult, runtimeLabel, stripTerminalControls, truncateChars } from "./render.ts";
import { backgroundActive, backgroundStatus, backgroundSummary, backgroundText, backgroundToolDetails, pruneBackgroundRuns } from "./background.ts";
import type { BackgroundRun } from "./background.ts";
import { SubagentParamsSchema, availableText, hasBlankModel, hasValidItems, modeOf, requestedAgentNames, validSingle } from "./params.ts";

export type { AgentCapability, AgentConfig, AgentDiscoveryResult, AgentOutputSchema, AgentScope } from "./agents.ts";
export { discoverAgents, findNearestProjectAgentsDir, findNearestProjectRoot, getBundledAgentsDir, loadAgentsFromDir } from "./agents.ts";

// Public API of the package; the modules behind it are internal.
export { MAX_DEPTH, MAX_CONCURRENCY, MAX_DESCENDANTS } from "./limits.ts";
export type { AgentTermination, UsageSummary, AgentResult, BackgroundRunStatus, BackgroundRunDetails, SubagentDetails } from "./types.ts";
export { getFinalOutput } from "./types.ts";
export { truncateOutput, interpolatePrevious } from "./bounds.ts";
export type { DepthStatus } from "./control.ts";
export { readDepth } from "./control.ts";
export type { PiInvocation, ParsedJsonEvent } from "./subprocess.ts";
export { getPiInvocation, parseJsonEventLine } from "./subprocess.ts";
export { stripTerminalControls } from "./render.ts";
export { SubagentParamsSchema } from "./params.ts";
export type { SubagentParams } from "./params.ts";

function terminalWorkflowFailure(result: AgentResult, signal?: AbortSignal): boolean {
  if (signal?.aborted || result.termination === "cancelled" || result.termination === "timed_out") return true;
  const diagnostic = result.errorMessage ?? "";
  return /Root (?:descendant budget exhausted|subagent deadline reached)|Timed out acquiring subagent control state lock|reservation is missing|control state is malformed/i.test(diagnostic);
}

class SubagentExecutionError extends Error {
  constructor(message: string, readonly details: SubagentDetails) {
    super(message);
    this.name = "SubagentExecutionError";
  }
}

function toolResult(text: string, details: SubagentDetails, isError = false): AgentToolResult<SubagentDetails> {
  const boundedText = truncateOutput(text, MAX_OUTPUT_BYTES);
  const bounded = boundDetails(details);
  // pi-agent-core intentionally turns thrown tool errors into its normal error
  // result and does not preserve custom Error fields. Keep throwing for that
  // semantic, but do not claim these details survive that boundary.
  if (isError) throw new SubagentExecutionError(boundedText, bounded);
  return { content: [{ type: "text", text: boundedText }], details: bounded };
}

function requestedProjectAgents(names: string[], agents: AgentConfig[]): AgentConfig[] {
  return names.map((name) => agents.find((agent) => agent.name === name)).filter((agent): agent is AgentConfig => agent?.source === "project");
}

async function confirmProjectAgents(
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

function cwdFor(base: string, value: string | undefined): string {
  return path.resolve(base, value ?? ".");
}

function existingDirectory(directory: string): string | undefined {
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

export default function (pi: ExtensionAPI) {
  const backgroundRuns = new Map<string, BackgroundRun>();
  const cleanupBackgroundRun = async (run: BackgroundRun): Promise<void> => {
    if (run.cleanedUp) return;
    if (!run.control.ownerDirectory) {
      run.cleanedUp = true;
      return;
    }
    try {
      await fs.promises.rm(run.control.ownerDirectory, { recursive: true, force: true });
      run.cleanedUp = true;
    } catch {
      // Retain the pending state so session shutdown can retry cleanup.
    }
  };
  const activeBackgroundRuns = (): BackgroundRun[] => [...backgroundRuns.values()].filter(backgroundActive);
  const waitForBackgrounds = async (runs: BackgroundRun[]): Promise<void> => {
    if (runs.length === 0) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(done, 5000);
      Promise.allSettled(runs.map((run) => run.promise)).then(done);
    });
  };

  // A detached process group is used so cancellation cannot kill the parent
  // pi process. Reap groups when the extension/session is shut down as well.
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", async () => {
      const backgrounds = activeBackgroundRuns();
      for (const run of backgrounds) run.controller.abort();
      await waitForBackgrounds(backgrounds);
      await Promise.all([...backgroundRuns.values()].map((run) => cleanupBackgroundRun(run)));

      const children = [...activeChildren];
      if (children.length === 0) return;
      for (const child of children) terminateProcessTree(child, "SIGTERM");
      await waitForChildren(children, 5000);
      // Kill the original process groups even if a leader exited while a
      // descendant retained a pipe or otherwise outlived it.
      for (const child of children) terminateProcessTree(child, "SIGKILL");
      await waitForChildren(children, 1000);
    });
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate bounded work to isolated named child agents. Children start with fresh context.",
      `Bundled agents are always available. User agents come from ${path.join(getAgentDir(), "agents")}; project agents come from ${CONFIG_DIR_NAME}/agents and require pi trust plus interactive confirmation.`,
      "All modes share lifecycle, resource, and cleanup limits; potentially mutating parallel tasks sharing a project root are rejected.",
    ].join(" "),
    parameters: SubagentParamsSchema,
    // The tool owns its own parallel mode and rejects unsafe same-project-root writes.
    // Serialize sibling top-level calls so two separate tool calls cannot
    // bypass that per-call mutation guard.
    executionMode: "sequential",
    promptSnippet: "Delegate bounded work; prefer one child unless scopes are clearly independent.",
    promptGuidelines: [
      "Use subagent for one coherent task; use parallel only for independent, non-overlapping scopes, not duplicate investigations.",
      "Give subagent the decisions, constraints, paths, and checks it needs because children start fresh.",
      "Use subagent chains/workflows for explicit dependencies or branching; use subagent background mode only for long-running top-level work.",
    ],

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runId = randomUUID();
      const parentRunId = process.env[RUN_ID_ENV];
      const inheritedRootRunId = process.env[ROOT_ID_ENV] ?? runId;
      const depth = readDepth();
      const inheritedDelegation = readDelegationPolicy();
      const inheritedDeadline = Number(process.env[DEADLINE_ENV]);
      let detailRootRunId = inheritedRootRunId;
      let detailDeadline = Number.isSafeInteger(inheritedDeadline) ? inheritedDeadline : 0;
      const effectiveCwd = ctx.cwd ? path.resolve(ctx.cwd) : process.cwd();
      const agentScope: AgentScope = params.agentScope ?? "user";
      const requestedRoot = cwdFor(effectiveCwd, params.cwd);
      const rootCwd = existingDirectory(requestedRoot);
      const trustedCwd = existingDirectory(effectiveCwd) ?? effectiveCwd;
      const trustedProjectRoot = findNearestProjectRoot(trustedCwd) ?? trustedCwd;
      // Discover against the same canonical cwd that will be used to run the
      // child. This avoids approving one project and executing in another.
      const discovery = discoverAgents(rootCwd ?? effectiveCwd, agentScope);
      const projectRoot = findNearestProjectRoot(rootCwd ?? effectiveCwd) ?? (rootCwd ?? effectiveCwd);
      const baseDetails = (mode: SubagentDetails["mode"], results: AgentResult[], action?: SubagentDetails["action"]): SubagentDetails => ({
        action,
        mode,
        agentScope,
        projectAgentsDir: discovery.projectAgentsDir,
        runId,
        parentRunId,
        rootRunId: detailRootRunId,
        depth: depth.depth,
        deadlineMs: detailDeadline,
        results,
      });
      if (inheritedDelegation.error) {
        return toolResult(inheritedDelegation.error, baseDetails(modeOf(params), []), true);
      }
      const inheritedPolicy = inheritedDelegation.policy;
      const visibleAgents = inheritedPolicy?.allowedAgents
        ? discovery.agents.filter((agent) => inheritedPolicy.allowedAgents!.includes(agent.name))
        : discovery.agents;
      const hasSingleFields = params.agent !== undefined || params.task !== undefined;
      const hasSingle = hasSingleFields;
      const hasParallel = params.tasks !== undefined;
      const hasChain = params.chain !== undefined;
      const hasWorkflow = params.workflow !== undefined;
      const hasBackground = params.background !== undefined;

      if (params.action && (hasSingle || hasParallel || hasChain || hasWorkflow || hasBackground)) {
        return toolResult("action=\"list\" cannot be combined with a delegation mode.", baseDetails("single", []), true);
      }

      if (params.action) {
        if (params.action !== "list") {
          return toolResult(`Unknown action: ${params.action}`, baseDetails("single", []), true);
        }
        const listApproval = await confirmProjectAgents(
          ctx,
          visibleAgents.filter((agent) => agent.source === "project").map((agent) => agent.name),
          discovery.agents,
          discovery.projectAgentsDir,
          trustedProjectRoot,
          projectRoot,
          signal,
        );
        if (!listApproval.allowed) {
          return toolResult(listApproval.reason ?? "Project-local agents were not approved.", baseDetails("single", []), true);
        }
        const lines = visibleAgents.map((agent) => {
          const configuredModel = agent.model ? ` [${agent.model}]` : " [parent model]";
          const tools = agent.tools?.length ? agent.tools.join(",") : "none";
          const capability = agent.capability ?? "unspecified";
          const delegation = agent.delegation ? "yes" : "no";
          const outputSchema = agent.outputSchema ? "yes" : "no";
          const allowedAgents = agent.allowedAgents?.join(",") || "any";
          const maxDelegationDepth = agent.maxDelegationDepth === undefined ? "global" : String(agent.maxDelegationDepth);
          return `${agent.name}: ${agent.description}${configuredModel} (${agent.source}; capability=${capability}; delegation=${delegation}; outputSchema=${outputSchema}; allowedAgents=${allowedAgents}; maxDelegationDepth=${maxDelegationDepth}; tools=${tools})`;
        });
        return toolResult(lines.length ? `Available agents:\n${lines.join("\n")}` : "No agents found.", baseDetails("single", [], "list"));
      }

      if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) + Number(hasWorkflow) + Number(hasBackground) !== 1) {
        return toolResult(
          `Invalid parameters. Provide exactly one mode: agent + task, tasks[], chain[], workflow, or background.\nAvailable agents: ${availableText(visibleAgents)}`,
          baseDetails(modeOf(params), []),
          true,
        );
      }
      if (hasSingle && !validSingle(params)) {
        return toolResult("Single mode requires both a non-blank agent and task.", baseDetails("single", []), true);
      }
      if (hasParallel && params.tasks!.length === 0) {
        return toolResult("Parallel mode requires at least one task.", baseDetails("parallel", []), true);
      }
      if (hasChain && params.chain!.length === 0) {
        return toolResult("Chain mode requires at least one step.", baseDetails("chain", []), true);
      }
      if (hasWorkflow && params.workflow!.steps.length === 0) {
        return toolResult("Workflow mode requires at least one step.", baseDetails("workflow", []), true);
      }
      if (hasBackground) {
        const background = params.background!;
        if (depth.depth > 0) {
          return toolResult("Background runs are only available from the top-level Pi session.", baseDetails("background", []), true);
        }
        if (background.action === "start") {
          if (!background.agent?.trim() || !background.task?.trim()) {
            return toolResult("Background start requires both a non-blank agent and task.", baseDetails("background", []), true);
          }
          if (background.runId) {
            return toolResult("Background start must not include runId.", baseDetails("background", []), true);
          }
          const backgroundAgent = discovery.agents.find((agent) => agent.name === background.agent!.trim());
          if (backgroundAgent?.delegation) {
            return toolResult("Background runs cannot use delegation-capable agents; start one child without nested delegation.", baseDetails("background", []), true);
          }
        } else {
          if (background.agent !== undefined || background.task !== undefined || params.model !== undefined || params.cwd !== undefined) {
            return toolResult(`Background ${background.action} accepts only runId.`, baseDetails("background", []), true);
          }
          if (!background.runId?.trim()) {
            if (background.action !== "status") {
              return toolResult(`Background ${background.action} requires runId.`, baseDetails("background", []), true);
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
      }
      if (!hasValidItems(params)) {
        return toolResult("Agent names and tasks must not be blank.", baseDetails(modeOf(params), []), true);
      }
      if (inheritedPolicy?.allowedAgents && requestedAgentNames(params).some((name) => !inheritedPolicy.allowedAgents!.includes(name))) {
        return toolResult(`Nested delegation is restricted to: ${inheritedPolicy.allowedAgents.join(", ") || "none"}.`, baseDetails(modeOf(params), []), true);
      }
      if (inheritedPolicy?.remainingDepth !== undefined && inheritedPolicy.remainingDepth <= 0) {
        return toolResult("Nested delegation depth policy does not permit another level.", baseDetails(modeOf(params), []), true);
      }
      if (hasBlankModel(params)) {
        return toolResult("Model overrides must not be blank.", baseDetails(modeOf(params), []), true);
      }
      if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
        return toolResult(`Too many parallel tasks (${params.tasks.length}). Maximum is ${MAX_PARALLEL_TASKS}.`, baseDetails("parallel", []), true);
      }
      if (params.chain && params.chain.length > MAX_CHAIN_STEPS) {
        return toolResult(`Too many chain steps (${params.chain.length}). Maximum is ${MAX_CHAIN_STEPS}.`, baseDetails("chain", []), true);
      }
      if (params.workflow && params.workflow.steps.length > MAX_WORKFLOW_STEPS) {
        return toolResult(`Too many workflow steps (${params.workflow.steps.length}). Maximum is ${MAX_WORKFLOW_STEPS}.`, baseDetails("workflow", []), true);
      }
      if (hasWorkflow) {
        const steps = params.workflow!.steps;
        const ids = new Set<string>();
        for (const step of steps) {
          if (ids.has(step.id)) {
            return toolResult(`Workflow node ids must be unique: "${step.id}".`, baseDetails("workflow", []), true);
          }
          ids.add(step.id);
        }
        const start = params.workflow!.start ?? steps[0]?.id;
        if (!start || !ids.has(start)) {
          return toolResult(`Workflow start node does not exist: "${start ?? ""}".`, baseDetails("workflow", []), true);
        }
        for (const step of steps) {
          for (const next of [step.onSuccess, step.onFailure]) {
            if (next !== undefined && !ids.has(next)) {
              return toolResult(`Workflow node "${step.id}" references missing node "${next}".`, baseDetails("workflow", []), true);
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
        return toolResult(`Tasks must be at most ${MAX_TASK_BYTES} bytes.`, baseDetails(modeOf(params), []), true);
      }

      if (!depth.valid || depth.depth >= MAX_DEPTH) {
        return toolResult(
          `Subagent depth limit reached or invalid ${DEPTH_ENV}; refusing to spawn (maximum depth ${MAX_DEPTH}).`,
          baseDetails(modeOf(params), []),
          true,
        );
      }

      if (!rootCwd) {
        return toolResult(`Working directory does not exist: ${requestedRoot}`, baseDetails(modeOf(params), []), true);
      }

      const projectAgentNames = new Set(requestedProjectAgents(requestedAgentNames(params), discovery.agents).map((agent) => agent.name));
      const taskLocations = [
        ...(hasSingle ? [{ agent: params.agent!, task: params.task!, cwd: undefined }] : []),
        ...(params.tasks ?? []),
        ...(params.chain ?? []),
        ...(params.workflow?.steps ?? []),
        ...(hasBackground && params.background!.action === "start" ? [{ agent: params.background!.agent!, task: params.background!.task!, cwd: undefined }] : []),
      ];
      const activeBackgroundMutationRoots = new Set(activeBackgroundRuns().filter((run) => run.mutating).map((run) => run.projectRoot));
      const parallelMutators = new Map<string, string[]>();
      for (const item of taskLocations) {
        const requestedCwd = cwdFor(rootCwd, item.cwd);
        const taskCwd = existingDirectory(requestedCwd);
        if (!taskCwd) {
          return toolResult(`Working directory does not exist: ${requestedCwd}`, baseDetails(modeOf(params), []), true);
        }
        if (projectAgentNames.has(item.agent.trim()) && !isWithinDirectory(trustedProjectRoot, taskCwd)) {
          return toolResult(
            `Project agent "${item.agent.trim()}" may only run within the trusted project cwd (project root): ${trustedProjectRoot}`,
            baseDetails(modeOf(params), []),
            true,
          );
        }
        const mutating = potentiallyMutating(discovery.agents.find((agent) => agent.name === item.agent.trim()));
        const conflictRoot = findNearestProjectRoot(taskCwd) ?? taskCwd;
        if (mutating && activeBackgroundMutationRoots.has(conflictRoot)) {
          return toolResult(
            `Background mutation rejected: a background run already owns project root ${conflictRoot}. Stop it or use a distinct project root.`,
            baseDetails(modeOf(params), []),
            true,
          );
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
            );
          }
        }
      }

      const projectApproval = await confirmProjectAgents(
        ctx,
        requestedAgentNames(params),
        discovery.agents,
        discovery.projectAgentsDir,
        trustedProjectRoot,
        projectRoot,
        signal,
      );
      if (!projectApproval.allowed) {
        return toolResult(projectApproval.reason ?? "Project-local agents were not approved.", baseDetails(modeOf(params), []), true);
      }

      let control: ControlContext;
      try {
        control = await inheritedControlState(depth, process.env[ROOT_ID_ENV] ?? "") ?? await createControlState(runId);
      } catch (error) {
        return toolResult(error instanceof Error ? error.message : String(error), baseDetails(modeOf(params), []), true);
      }
      detailRootRunId = control.rootRunId;
      detailDeadline = control.deadlineMs;
      const execution: ExecutionContext = {
        runId,
        parentRunId,
        reservationRunId: depth.depth > 0 ? process.env[RUN_ID_ENV] : undefined,
        rootRunId: control.rootRunId,
        depth: depth.depth,
        deadlineMs: control.deadlineMs,
        control,
        delegationPolicy: inheritedPolicy,
      };
      let yieldedReservation = false;
      let backgroundTransferred = false;
      try {
        if (execution.reservationRunId) {
          yieldedReservation = await releaseChild(control, execution.reservationRunId);
          if (!yieldedReservation) throw new Error("Nested subagent reservation is missing; refusing to run without an owned capacity slot.");
        }
        const parentModel = ctx.model;
        const supervisor: ChildSupervisor = new SubprocessChildSupervisor(discovery.agents, execution, parentModel, ctx.thinkingLevel);
        let updateFailure: string | undefined;
      const notify = (text: string, details: SubagentDetails) => {
        try {
          onUpdate?.({ content: [{ type: "text", text: truncateOutput(text, MAX_OUTPUT_BYTES) }], details: boundDetails(details) });
        } catch (error) {
          updateFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      };
      const emitSingle = (mode: SubagentDetails["mode"], results: AgentResult[], result: AgentResult, progress?: string) => {
        notify(progress ?? resultText(result), baseDetails(mode, results.map(copyResult)));
      };

      if (hasBackground) {
        const background = params.background!;
        if (background.action !== "start") {
          throw new Error(`Unsupported background action: ${background.action}`);
        }
        await Promise.all([...backgroundRuns.values()]
          .filter((run) => !backgroundActive(run) && !run.cleanedUp)
          .map((run) => cleanupBackgroundRun(run)));
        pruneBackgroundRuns(backgroundRuns);
        if (activeBackgroundRuns().length >= MAX_BACKGROUND_ACTIVE) {
          return toolResult(`Too many active background runs. Maximum is ${MAX_BACKGROUND_ACTIVE}.`, backgroundToolDetails("start"), true);
        }
        if (backgroundRuns.size >= MAX_BACKGROUND_RUNS) {
          return toolResult(`Too many retained background runs. Maximum is ${MAX_BACKGROUND_RUNS}. Retrieve or stop an existing run before starting another.`, backgroundToolDetails("start"), true);
        }
        const backgroundAgent = background.agent!.trim();
        const backgroundMutating = potentiallyMutating(discovery.agents.find((agent) => agent.name === backgroundAgent));
        const backgroundRun: BackgroundRun = {
          details: {
            runId: randomUUID(),
            agent: backgroundAgent,
            status: "starting",
            createdAt: Date.now(),
          },
          task: background.task!,
          cwd: rootCwd,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          projectRoot,
          mutating: backgroundMutating,
          control,
          controller: new AbortController(),
          cleanedUp: false,
        };
        backgroundRuns.set(backgroundRun.details.runId, backgroundRun);
        backgroundTransferred = true;
        const backgroundPromise = supervisor.run({
          name: backgroundRun.details.agent,
          task: backgroundRun.task,
          cwd: backgroundRun.cwd,
          modelOverride: params.model,
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
        }).finally(() => cleanupBackgroundRun(backgroundRun));
        backgroundRun.promise = backgroundPromise;
        return toolResult(`Started background run ${backgroundRun.details.runId} for ${backgroundRun.details.agent}.`, backgroundToolDetails("start", backgroundRun));
      }

      if (hasSingle) {
        const result = await supervisor.run({
          name: params.agent!.trim(),
          task: params.task!,
          cwd: rootCwd,
          modelOverride: params.model,
          signal,
          emit: (current, progress) => emitSingle("single", [current], current, progress),
        });
        return toolResult(resultText(result), baseDetails("single", [result]), failed(result));
      }

      if (hasWorkflow) {
        const workflow = params.workflow!;
        const steps = new Map(workflow.steps.map((step) => [step.id, step]));
        const results: AgentResult[] = [];
        let currentId = workflow.start ?? workflow.steps[0]!.id;
        let previous = "";
        for (let transition = 0; transition < MAX_WORKFLOW_TRANSITIONS; transition++) {
          const step = steps.get(currentId);
          if (!step) {
            return toolResult(`Workflow reached missing node "${currentId}".`, baseDetails("workflow", results), true);
          }
          const task = interpolatePrevious(step.task, previous, MAX_TASK_BYTES);
          const stepCwd = existingDirectory(cwdFor(rootCwd, step.cwd));
          if (!stepCwd) {
            const errorResult: AgentResult = {
              agent: step.agent.trim(),
              agentSource: "unknown",
              task: truncateOutput(task, MAX_DIAGNOSTIC_BYTES),
              runId: randomUUID(),
              parentRunId: execution.runId,
              rootRunId: execution.rootRunId,
              depth: execution.depth + 1,
              step: transition + 1,
              exitCode: 1,
              stopReason: "error",
              termination: "failed",
              errorMessage: truncateOutput(`Working directory does not exist: ${stepCwd}`, MAX_DIAGNOSTIC_BYTES),
              stderr: "",
              messages: [],
              usage: emptyUsage(),
            };
            results.push(errorResult);
            return toolResult(`Workflow stopped at ${step.id} (${step.agent}): ${resultText(errorResult)}`, baseDetails("workflow", results), true);
          }
          const result = await supervisor.run({
            name: step.agent.trim(),
            task,
            cwd: stepCwd,
            modelOverride: params.model ?? step.model,
            step: transition + 1,
            signal,
            emit: (current, progress) => emitSingle("workflow", [...results, current], current, progress),
          });
          results.push(result);
          const failedRun = failed(result);
          previous = truncateOutput(result.output || resultText(result), MAX_CHAIN_CONTEXT_BYTES);
          if (failedRun && terminalWorkflowFailure(result, signal)) {
            return toolResult(`Workflow stopped at ${step.id} (${step.agent}): ${resultText(result)}`, baseDetails("workflow", results), true);
          }
          const next = failedRun ? step.onFailure : step.onSuccess;
          if (!next) {
            if (failedRun) {
              return toolResult(`Workflow stopped at ${step.id} (${step.agent}): ${resultText(result)}`, baseDetails("workflow", results), true);
            }
            return toolResult(resultText(result), baseDetails("workflow", results));
          }
          currentId = next;
        }
        return toolResult(`Workflow exceeded the ${MAX_WORKFLOW_TRANSITIONS}-transition root budget.`, baseDetails("workflow", results), true);
      }

      if (hasChain) {
        const results: AgentResult[] = [];
        let previous = "";
        for (let index = 0; index < params.chain!.length; index++) {
          const step = params.chain![index]!;
          const task = interpolatePrevious(step.task, previous, MAX_TASK_BYTES);
          const stepCwd = existingDirectory(cwdFor(rootCwd, step.cwd));
          if (!stepCwd) {
            const errorResult: AgentResult = {
              agent: step.agent.trim(),
              agentSource: "unknown",
              task: truncateOutput(task, MAX_DIAGNOSTIC_BYTES),
              runId: randomUUID(),
              parentRunId: execution.runId,
              rootRunId: execution.rootRunId,
              depth: execution.depth + 1,
              step: index + 1,
              exitCode: 1,
              stopReason: "error",
              termination: "failed",
              errorMessage: truncateOutput(`Working directory does not exist: ${stepCwd}`, MAX_DIAGNOSTIC_BYTES),
              stderr: "",
              messages: [],
              usage: emptyUsage(),
            };
            results.push(errorResult);
            return toolResult(`Chain stopped at step ${index + 1} (${step.agent}): ${resultText(errorResult)}`, baseDetails("chain", results), true);
          }
          const result = await supervisor.run({
            name: step.agent.trim(),
            task,
            cwd: stepCwd,
            modelOverride: params.model ?? step.model,
            step: index + 1,
            signal,
            emit: (current, progress) => emitSingle("chain", [...results, current], current, progress),
          });
          results.push(result);
          if (failed(result)) {
            return toolResult(`Chain stopped at step ${index + 1} (${step.agent}): ${resultText(result)}`, baseDetails("chain", results), true);
          }
          previous = truncateOutput(result.output || getFinalOutput(result.messages), MAX_CHAIN_CONTEXT_BYTES);
        }
        const finalResult = results[results.length - 1];
        return toolResult(finalResult ? resultText(finalResult) : "(no output)", baseDetails("chain", results));
      }

      const placeholders: AgentResult[] = (params.tasks ?? []).map((task) => {
        const configuredAgent = discovery.agents.find((agent) => agent.name === task.agent.trim());
        return {
          agent: task.agent.trim(),
          agentSource: configuredAgent?.source ?? "unknown",
          task: truncateOutput(task.task, MAX_DIAGNOSTIC_BYTES),
          runId: randomUUID(),
          parentRunId: execution.runId,
          rootRunId: execution.rootRunId,
          depth: execution.depth + 1,
          exitCode: -1,
          stderr: "",
          messages: [],
          usage: emptyUsage(),
          model: configuredAgent
            ? resolveModel(configuredAgent, params.model ?? task.model, parentModel)
            : params.model ?? task.model ?? modelName(parentModel),
        };
      });
      const current = placeholders.map(copyResult);
      try {
        notify(`Parallel: 0/${current.length} done`, baseDetails("parallel", current));
      } catch {
        return toolResult(`Subagent update failed: ${updateFailure ?? "unknown update error"}`, baseDetails("parallel", current), true);
      }
      const requests = params.tasks!.map((task, index): ChildRunRequest => ({
        name: task.agent.trim(),
        task: task.task,
        cwd: existingDirectory(cwdFor(rootCwd, task.cwd)) ?? cwdFor(rootCwd, task.cwd),
        modelOverride: params.model ?? task.model,
        signal,
        emit: (result, progress) => {
          current[index] = copyResult(result);
          const done = current.filter((item) => item.exitCode !== -1).length;
          notify(progress ?? `Parallel: ${done}/${current.length} done`, baseDetails("parallel", current.map(copyResult)));
        },
      }));
      const results = await supervisor.runBatch(requests);
      const successCount = results.filter((result) => !failed(result)).length;
      const summary = results.map((result) => {
        const status = failed(result)
          ? `failed${result.termination ? ` (${result.termination})` : result.stopReason ? ` (${result.stopReason})` : ""}`
          : result.termination ?? "completed";
        return `### [${result.agent}] ${status}\n\n${truncateOutput(resultText(result), MAX_DIAGNOSTIC_BYTES)}`;
      }).join("\n\n---\n\n");
      return toolResult(`Parallel: ${successCount}/${results.length} succeeded\n\n${truncateOutput(summary, MAX_OUTPUT_BYTES)}`, baseDetails("parallel", results), successCount !== results.length);
      } finally {
        if (yieldedReservation && execution.reservationRunId) {
          await reserveChild(control, execution.reservationRunId, signal, false);
        }
        if (!backgroundTransferred && control.ownerDirectory) await fs.promises.rm(control.ownerDirectory, { recursive: true, force: true }).catch(() => {});
      }
    },

    renderCall(args, theme) {
      if (args.action === "list") return new Text(theme.fg("toolTitle", theme.bold("subagent list")), 0, 0);
      const scope = stripTerminalControls(args.agentScope ?? "user");
      const label = args.background?.action
        ? `background ${args.background.action}`
        : args.workflow?.steps?.length
          ? `workflow (${args.workflow.steps.length})`
          : args.chain?.length
          ? `chain (${args.chain.length})`
          : args.tasks?.length
            ? `parallel (${args.tasks.length})`
            : stripTerminalControls(args.agent ?? "...");
      let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", label)}${theme.fg("muted", ` [${scope}]`)}`;
      if (args.background?.action === "start") {
        text += `\n  ${theme.fg("accent", stripTerminalControls(args.background.agent ?? "..."))} ${theme.fg("dim", truncateChars(stripTerminalControls(args.background.task ?? ""), 80))}`;
      } else if (args.workflow?.steps?.length) {
        for (const step of args.workflow.steps.slice(0, 3)) text += `\n  ${theme.fg("accent", stripTerminalControls(step.id))} ${theme.fg("dim", `${stripTerminalControls(step.agent)}: ${truncateChars(stripTerminalControls(step.task.replaceAll("{previous}", "").trim()), 52)}`)}`;
      } else if (args.chain?.length) {
        for (const [index, step] of args.chain.slice(0, 3).entries()) text += `\n  ${index + 1}. ${theme.fg("accent", stripTerminalControls(step.agent))} ${theme.fg("dim", truncateChars(stripTerminalControls(step.task.replaceAll("{previous}", "").trim()), 60))}`;
      } else if (args.tasks?.length) {
        for (const task of args.tasks.slice(0, 3)) text += `\n  ${theme.fg("accent", stripTerminalControls(task.agent))} ${theme.fg("dim", truncateChars(stripTerminalControls(task.task), 60))}`;
      } else if (args.task) {
        text += `\n  ${theme.fg("dim", truncateChars(stripTerminalControls(args.task), 80))}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      // Agent discovery is metadata for the model, not a transcript to repeat
      // in the user's TUI. The tool content remains intact for the next model
      // turn; an empty component intentionally suppresses only the UI slot.
      if (details?.action === "list") return new Container();
      const fallback = result.content[0]?.type === "text" && typeof result.content[0].text === "string"
        ? stripTerminalControls(truncateOutput(result.content[0].text, MAX_OUTPUT_BYTES))
        : "(no output)";
      if (!details || !["single", "parallel", "chain", "workflow", "background"].includes(details.mode) || !Array.isArray(details.results) || details.results.length === 0 || !details.results.every(isRenderableAgentResult)) return new Text(fallback, 0, 0);

      const renderBudget = { remaining: MAX_OUTPUT_BYTES };
      const takeRender = (value: string): string => {
        if (renderBudget.remaining <= 0) return "[render output truncated]";
        const bounded = truncateOutput(stripTerminalControls(value), renderBudget.remaining);
        renderBudget.remaining = Math.max(0, renderBudget.remaining - Buffer.byteLength(bounded, "utf8"));
        return bounded;
      };
      const iconFor = (item: AgentResult) => item.exitCode === -1 ? theme.fg("warning", "⏳") : failed(item) ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const statusLine = (item: AgentResult): string => {
        const runtime = runtimeLabel(item);
        return `${iconFor(item)} ${theme.fg("accent", stripTerminalControls(item.agent))}${theme.fg("muted", ` (${stripTerminalControls(item.agentSource)})`)}${runtime ? theme.fg("dim", ` · ${runtime}`) : ""}`;
      };
      const renderOutput = (item: AgentResult, full: boolean) => {
        const output = resultText(item);
        if (item.exitCode === -1 && output === "(no output)") {
          return details.results.length === 1 ? takeRender(fallback) : takeRender("(running...)");
        }
        return takeRender(full ? output : output.split("\n").slice(0, 5).join("\n"));
      };
      const hasActive = details.results.some((item) => item.exitCode === -1);
      const headline = hasActive
        ? details.results.find((item) => item.exitCode === -1)!
        : details.mode === "workflow"
          ? details.results[details.results.length - 1]!
          : details.results.some(failed) ? details.results.find(failed)! : details.results[0]!;

      if (expanded) {
        const container = new Container();
        container.addChild(new Text(`${iconFor(headline)} ${theme.fg("toolTitle", theme.bold(details.mode))}`, 0, 0));
        for (const item of details.results) {
          container.addChild(new Spacer(1));
          const status = item.termination ?? item.stopReason;
          const runtime = runtimeLabel(item);
          container.addChild(new Text(`${iconFor(item)} ${theme.fg("accent", stripTerminalControls(item.agent))}${theme.fg("muted", ` (${stripTerminalControls(item.agentSource)})`)}${status ? theme.fg("dim", ` [${status}]`) : ""}${runtime ? theme.fg("dim", ` · ${runtime}`) : ""}`, 0, 0));
          container.addChild(new Text(theme.fg("dim", takeRender(truncateChars(item.task, 500))), 0, 0));
          const output = renderOutput(item, true);
          if (output && output !== "(no output)") container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
          else container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          container.addChild(new Text(theme.fg("dim", formatUsage(item.usage, item.model)), 0, 0));
        }
        if (details.results.length > 1) container.addChild(new Text(theme.fg("dim", `Total: ${formatUsage(aggregateUsage(details.results))}`), 0, 0));
        return container;
      }

      let text = `${iconFor(headline)} ${theme.fg("toolTitle", theme.bold(details.mode))}`;
      if (hasActive) {
        if (details.mode === "parallel") {
          if (details.results.length <= MAX_CONCURRENCY) {
            for (const item of details.results) text += `\n${statusLine(item)}`;
          } else {
            const active = details.results.filter((item) => item.exitCode === -1);
            const running = active.filter((item) => isFiniteNumber(item.startedAt)).length;
            const queued = active.length - running;
            const complete = details.results.length - active.length;
            const counts = [`${details.results.length} subagents`, `${running} running`];
            if (queued) counts.push(`${queued} queued`);
            if (complete) counts.push(`${complete} complete`);
            const startedAt = details.results
              .map((item) => item.startedAt)
              .filter(isFiniteNumber)
              .sort((left, right) => left - right)[0];
            const elapsed = formatDuration(startedAt);
            text += `\n${theme.fg("warning", "⏳")} ${theme.fg("accent", counts.join(" · "))}${elapsed ? theme.fg("dim", ` · ${elapsed} elapsed`) : ""}`;
          }
        } else if (details.mode === "single") {
          text += `\n${statusLine(headline)}`;
        } else {
          const current = details.results.find((item) => item.exitCode === -1) ?? headline;
          const completed = details.results.filter((item) => item.exitCode !== -1).length;
          const step = current.step ? theme.fg("dim", ` · step ${current.step}`) : "";
          const prior = completed ? theme.fg("dim", ` · ${completed} complete`) : "";
          text += `\n${statusLine(current)}${step}${prior}`;
        }
        return new Text(text, 0, 0);
      }
      for (const item of details.results) {
        text += `\n\n${statusLine(item)}`;
        text += `\n${theme.fg("toolOutput", truncateChars(renderOutput(item, false), 500))}`;
      }
      text += `\n${theme.fg("dim", formatUsage(aggregateUsage(details.results)))}`;
      return new Text(text, 0, 0);
    },
  });
}
