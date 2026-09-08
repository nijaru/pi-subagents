import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.ts";
import { discoverAgents, findNearestProjectRoot } from "./agents.ts";

import { DEADLINE_ENV, MAX_CONCURRENCY, MAX_OUTPUT_BYTES, ROOT_ID_ENV, RUN_ID_ENV } from "./limits.ts";
import { isFiniteNumber } from "./types.ts";
import type { AgentResult, SubagentDetails } from "./types.ts";
import { boundDetails, truncateOutput } from "./bounds.ts";
import { createControlState, inheritedControlState, readDelegationPolicy, readDepth, releaseChild, reserveChild } from "./control.ts";
import type { ControlContext } from "./control.ts";
import { activeChildren, terminateProcessTree, waitForChildren } from "./subprocess.ts";
import { SubprocessChildSupervisor, copyResult, failed, resultText } from "./supervisor.ts";
import type { ChildSupervisor, ExecutionContext } from "./supervisor.ts";
import { aggregateUsage, formatDuration, formatUsage, isRenderableAgentResult, runtimeLabel, stripTerminalControls, truncateChars } from "./render.ts";
import { backgroundActive } from "./background.ts";
import type { BackgroundRun } from "./background.ts";
import { SubagentParamsSchema, availableText, modeOf, requestedAgentNames, validSingle } from "./params.ts";
import type { ModeEnv } from "./modes.ts";
import { checkTaskLocations, confirmProjectAgents, cwdFor, existingDirectory, handleBackgroundQuery, runChainMode, runListAction, runParallelMode, runSingleMode, runWorkflowMode, startBackgroundRun, toolResult, validateDelegationRequest } from "./modes.ts";

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
      const hasSingle = params.agent !== undefined || params.task !== undefined;
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
        return runListAction({ ctx, signal, visibleAgents, discovery, trustedProjectRoot, projectRoot, baseDetails });
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
      // Status/result/stop observe the registry without spawning and return
      // before spawn-guard validation. Background starts validate below and
      // run after control acquisition like every other mode.
      if (hasBackground && params.background!.action !== "start") {
        return handleBackgroundQuery(params, depth, backgroundRuns, baseDetails);
      }
      validateDelegationRequest({ params, depth, inheritedPolicy, discovery, baseDetails });

      const verifiedRootCwd = checkTaskLocations({ params, requestedRoot, rootCwd, discovery, trustedProjectRoot, backgroundRuns, baseDetails });

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
      try {
        if (execution.reservationRunId) {
          yieldedReservation = await releaseChild(control, execution.reservationRunId);
          if (!yieldedReservation) throw new Error("Nested subagent reservation is missing; refusing to run without an owned capacity slot.");
        }
        const parentModel = ctx.model;
        const supervisor: ChildSupervisor = new SubprocessChildSupervisor(discovery.agents, execution, parentModel, ctx.thinkingLevel);
        const notify = (text: string, details: SubagentDetails) => {
          onUpdate?.({ content: [{ type: "text", text: truncateOutput(text, MAX_OUTPUT_BYTES) }], details: boundDetails(details) });
        };
        const emitSingle = (mode: SubagentDetails["mode"], results: AgentResult[], result: AgentResult, progress?: string) => {
          notify(progress ?? resultText(result), baseDetails(mode, results.map(copyResult)));
        };
        const env: ModeEnv = {
          params,
          signal,
          rootCwd: verifiedRootCwd,
          agentScope,
          discovery,
          projectRoot,
          parentModel,
          control,
          execution,
          supervisor,
          backgroundRuns,
          cleanupBackgroundRun,
          baseDetails,
          notify,
          emitSingle,
        };
        if (hasBackground) return await startBackgroundRun(env);
        if (hasSingle) return await runSingleMode(env);
        if (hasWorkflow) return await runWorkflowMode(env);
        if (hasChain) return await runChainMode(env);
        return await runParallelMode(env);
      } finally {
        if (yieldedReservation && execution.reservationRunId) {
          await reserveChild(control, execution.reservationRunId, signal, false);
        }
        // A started background run owns the control directory from here and
        // cleans it up on completion, stop, or session shutdown.
        const transferred = [...backgroundRuns.values()].some((run) => run.control === control);
        if (!transferred && control.ownerDirectory) await fs.promises.rm(control.ownerDirectory, { recursive: true, force: true }).catch(() => {});
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
