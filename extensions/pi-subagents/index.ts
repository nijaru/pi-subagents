import * as path from "node:path";
import { canonicalSession } from "./launch.ts";
import type { AgentToolResult, ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { SessionChildren } from "./children.ts";
import { RpcChildSupervisor } from "./supervisor.ts";
import { SubagentParamsSchema, excludedChildTools, resolveCwd, selectTools, validateCommand } from "./params.ts";
import { DEFAULT_WAIT_MS, RUNNING_PROGRESS_TEXT, RUNTIME_UPDATE_INTERVAL_MS, foregroundBudgetMs, isChildProcess } from "./limits.ts";
import { truncateOutput } from "./bounds.ts";
import { childResponse as answer } from "./response.ts";
import { addUsage, isRunning } from "./types.ts";
import { SubagentDetailsSchema } from "./result-schema.ts";
import type { ChildResult, SubagentDetails } from "./types.ts";
import { childListText, renderChildCall, renderChildResult, renderChildNotice } from "./render.ts";
import { CompletionDelivery } from "./delivery.ts";
import { childStatus as summary, childStatuses, childReports, formatElapsed } from "./reports.ts";

export { SubagentParamsSchema } from "./params.ts";
export type { SubagentParams } from "./params.ts";
export type { ChildResult, ChildActivity, SubagentDetails, AgentOutcome, ChildState, UsageSummary } from "./types.ts";
export { MAX_CONCURRENCY } from "./limits.ts";

function inboxNotice(results: ChildResult[]): string {
  const items = results.slice(0, 8).map((result) =>
    `${result.handle ?? result.id.slice(0, 8)} ${result.state.status === "terminal" ? result.state.outcome : "running"}`
  ).join(", ");
  const more = results.length > 8 ? ` and ${results.length - 8} more` : "";
  return `[subagent] ${results.length} unread child result${results.length === 1 ? "" : "s"}: ${items}${more}. Call subagent wait to read ${results.length === 1 ? "it" : "them"}.`;
}

function outcome(command: "run" | "wait", results: ChildResult[]): AgentToolResult<SubagentDetails> {
  const waitExpired = command === "wait" ? results.every(isRunning) : undefined;
  const remaining = command === "wait" ? results.filter(isRunning).length : 0;
  const preamble = remaining > 0
    ? `${waitExpired ? "Wait budget expired; children continue." : "Returned ready reports; remaining children continue."} Wait again only on remaining ids when their results block progress.\n\n`
    : "";
  // The model authored run prompts; keep them only where the call lacks them.
  return answer(command, results, (view) => preamble + childReports(view, { includePrompt: command !== "run" }), waitExpired);
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-ready", renderChildNotice);
  const createRuntime = () => {
    let delivery: CompletionDelivery;
    const children = new SessionChildren(new RpcChildSupervisor(), () => delivery.refreshStatus());
    delivery = new CompletionDelivery(children);
    return { children, delivery };
  };
  let runtime = createRuntime();
  // Use the host's usage channel, including for failed tool results. Charging
  // snapshots or notices would duplicate costs on repeated wait/status calls.
  pi.on("tool_result", (event): ToolResultEventResult | undefined => {
    runtime.delivery.refreshStatus();
    const usage = runtime.children.takePendingUsage();
    // Nested/codemode results only reach the calling tool, never the model.
    const inbox = event.parentToolCallId !== undefined || event.toolName === "subagent" ? [] : runtime.delivery.inbox();
    if (!usage && inbox.length === 0) return;
    const result: ToolResultEventResult = {};
    if (usage) {
      if (event.usage) addUsage(usage, event.usage);
      result.usage = usage;
    }
    if (inbox.length > 0) {
      // Advertise unread reports without spending a model turn. The child's full
      // report remains available through wait.
      result.content = [...(Array.isArray(event.content) ? event.content : []), { type: "text", text: inboxNotice(inbox) }];
      if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
    }
    return result;
  });
  pi.on("session_shutdown", async () => {
    runtime.delivery.close();
    await runtime.children.close();
  });
  pi.on("session_start", async (_event, ctx) => {
    runtime.delivery.close();
    await runtime.children.close();
    runtime = createRuntime();
    runtime.delivery.bind(ctx);
  });
  // agent_start also fires for retries/boundary continuations. Rearm notices
  // only for a new external run, or a dropped notice can cause a restart loop.
  pi.on("before_agent_start", (_event, ctx) => runtime.delivery.started(ctx));
  pi.on("agent_end", (event, ctx) => runtime.delivery.ended(event, ctx));
  pi.on("turn_start", () => runtime.delivery.turnStarted());
  pi.on("turn_end", (event, ctx) => runtime.delivery.boundary(event, ctx));
  pi.on("agent_before_settle", (event, ctx) => runtime.delivery.boundary(event, ctx));
  pi.on("agent_settled", (_event, ctx) => runtime.delivery.settled(ctx));

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a self-contained task to a fresh Pi child. run/spawn require prompt; optional label identifies the task. run joins briefly, then returns a running handle if unfinished; spawn returns immediately. wait with ids retrieves reports when any selected child finishes. status inspects without collecting; stop cancels; steer queues instructions into active work. Defaults to read/search/web tools; request mutation tools explicitly. Children are leaves. Conversations are saved by default; persist:false opts out. resume continues a stopped conversation with a new handle. Inspect state.outcome and cleanup independently: a completed task with unconfirmed cleanup must not be rerun just because the tool reports an error.",
    parameters: SubagentParamsSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    outputSchema: SubagentDetailsSchema,
    executionMode: "parallel",
    promptSnippet: "Use run for a fresh-context result, spawn for independent work alongside useful local work, and steer to redirect a running child.",
    promptGuidelines: [
      "Give subagent tasks relevant evidence, scope, constraints, expected output and checks. Prefer direct work for routine or tightly coupled tasks; the parent owns integration and verification. Use short labels to distinguish parallel tasks; control children by handles, not labels.",
      "Request subagent mutation tools explicitly. Concurrent writers, including parent and child, need separate worktrees; tool allowlists and subprocesses are not sandboxes.",
      "Spawn independent subagent tasks before waiting. Use subagent wait with handles when blocked; it wakes when any selected child finishes. Completion notices announce handles, not reports: collect them with wait. Do not poll or relaunch when a join expires.",
      "Cancelling subagent wait leaves children running; stop cancels them. Use steer for active work and resume for a stopped conversation with a new handle. Handle resume defaults to the original cwd; tools/model/effort/trust use normal launch rules.",
      "Subagent execution deadlines are off unless executionTimeoutMs or PI_SUBAGENT_TIMEOUT_MS is set. Startup and join/wait budgets are separate. On failure or timeout, inspect output, timing and saved history before recovery; silence or deadline expiry is not a cause diagnosis. Resume is not rollback or permission to replay mutations.",
      "Read subagent state.outcome independently of cleanup.status. Unconfirmed cleanup remains a tool error and reserves resources, even if the task completed; reconcile process/workspace state rather than rerunning completed work. Successful output lists completed answers newest-first; earlier answers may add findings but may be superseded by corrections.",
      "Subagent sessions are saved locally by default and may contain sensitive prompts/tool results; persist:false opts out. Completion notices never wake an idle parent.",
    ],
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!Check(SubagentParamsSchema, params)) {
        const error = Errors(SubagentParamsSchema, params)[0]!;
        throw new Error(`Invalid subagent parameters: ${error.instancePath || "/"} ${error.message} (${truncateOutput(JSON.stringify(error.params), 512)}).`);
      }
      validateCommand(params);
      if (isChildProcess()) throw new Error("Children are leaves; nested subagent calls are not supported.");
      // Capture the owner: an old foreground call must never read a new session's registry.
      const owner = runtime.children;
      runtime.delivery.bind(ctx);
      if (params.command === "status") {
        const results = params.id ? [owner.get(params.id)] : owner.list();
        return answer("status", results, childStatuses);
      }
      if (params.command === "stop") {
        const result = await owner.stop(params.id);
        return answer("stop", [result], childReports);
      }
      if (params.command === "steer") {
        const result = await owner.steer(params.id, params.message, signal);
        return answer("steer", [result], ([view]) => `Steering queued for ${view!.handle ?? view!.id}.`);
      }
      if (params.command === "wait") {
        const results = await owner.wait(params.ids, params.timeoutMs ?? DEFAULT_WAIT_MS, signal);
        return outcome("wait", results);
      }
      if (signal?.aborted) throw new Error("Child launch cancelled.");
      const activeTools = pi.getActiveTools();
      const callableTools = ctx.tools.map((tool) => tool.name);
      const tools = selectTools(params.tools, activeTools, callableTools);
      const allToolNames = pi.getAllTools().map((tool) => tool.name);
      const excludeTools = excludedChildTools(tools, [...new Set([...activeTools, ...callableTools, ...allToolNames])]);
      const retained = params.resume !== undefined && /^sa-\d+$/.test(params.resume) ? owner.resumeTarget(params.resume) : undefined;
      const cwd = resolveCwd(ctx.cwd || process.cwd(), params.cwd ?? retained?.cwd);
      const resume = retained?.sessionFile ?? (params.resume === undefined ? undefined : path.resolve(ctx.cwd, params.resume));
      const parentSession = ctx.sessionManager.getSessionFile();
      if (resume && parentSession && canonicalSession(resume) === canonicalSession(parentSession)) {
        throw new Error("Cannot resume the active parent session as a child.");
      }
      const foreground = params.command === "run";
      let presenting = foreground;
      const present = (result: ChildResult, progress: string) => {
        if (!presenting || !onUpdate || owner.isClosed) return;
        try { onUpdate(answer("run", [{ ...result, state: { status: "running" } }], () => progress)); }
        catch { presenting = false; }
      };
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const model = params.model?.trim() ?? parentModel;
      // A different model uses its own Pi defaults, not a potentially expensive or unsupported parent effort.
      const thinking = params.thinking ?? (model === parentModel ? ctx.thinkingLevel : undefined);
      // A completed join reads the result; only unread results are eligible
      // for automatic delivery at an active parent boundary; never wake an idle parent.
      const run = owner.start({
        prompt: params.prompt, label: params.label?.trim(), tools, cwd,
        model, thinking, strictThinking: params.thinking !== undefined,
        executionTimeoutMs: params.executionTimeoutMs,
        startupTimeoutMs: params.startupTimeoutMs,
        persist: params.persist,
        resume,
        trustProject: params.trustProject,
        excludeTools,
        emit: foreground && onUpdate ? present : undefined,
      });
      if (!foreground) {
        const snapshot = owner.get(run.id);
        return answer("spawn", [snapshot], ([view]) => `Started child ${view!.handle}${view!.label ? ` (${view!.label})` : ""}. Completion is announced at an active boundary or on a later tool result; idle parents are not woken. Continue non-overlapping work; use wait when its result blocks finishing your task, or status/stop with this handle.${view!.sessionFile ? `\nSession: ${view!.sessionFile}` : ""}`);
      }
      // Presentation stops at the foreground join, even when execution continues.
      const timer = onUpdate ? setInterval(() => {
        if (presenting && !owner.isClosed) present(owner.get(run.id), RUNNING_PROGRESS_TEXT);
      }, RUNTIME_UPDATE_INTERVAL_MS) : undefined;
      try {
        const budget = params.joinTimeoutMs ?? foregroundBudgetMs();
        const result = await owner.join(run.id, budget, signal);
        if (isRunning(result)) {
          return answer("run", [result], ([view]) => `${summary(view!)}\nStill running after ${formatElapsed(budget)}; it continues as background work. Completion is announced at an active boundary or on a later tool result; idle parents are not woken. Use wait when its result blocks finishing your task, or status/stop with this handle.`);
        }
        return outcome("run", [result]);
      } finally {
        presenting = false;
        if (timer) clearInterval(timer);
      }
    },
    renderCall: renderChildCall,
    renderResult: renderChildResult,
  });

  pi.registerCommand("subagents", {
    description: "List retained child agents, or clear completed read handles",
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action === "clear") {
        const removed = runtime.children.pruneCollected();
        ctx.ui.notify(`Cleared ${removed} read child handle${removed === 1 ? "" : "s"}.`, "info");
        return;
      }
      if (action !== "") {
        ctx.ui.notify("Usage: /subagents [clear]", "info");
        return;
      }
      const results = runtime.children.list();
      const unread = runtime.children.unread().length;
      const header = results.length === 0 ? "No retained child agents." : `${results.length} retained${unread ? ` · ${unread} unread` : ""}`;
      ctx.ui.notify(`${header}\n${childListText(results)}`.trim(), "info");
    },
  });
}
