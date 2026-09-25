import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { SessionChildren } from "./children.ts";
import { SubprocessChildSupervisor } from "./supervisor.ts";
import { SubagentParamsSchema, resolveCwd, selectTools, validateCommand } from "./params.ts";
import { DEFAULT_WAIT_MS, MAX_OUTPUT_BYTES, MAX_RETAINED_RUNS, foregroundBudgetMs, isChildProcess } from "./limits.ts";
import { boundDetails, truncateOutput } from "./bounds.ts";
import { addUsage, failed, isRunning } from "./types.ts";
import type { ChildResult, SubagentDetails } from "./types.ts";
import { renderChildCall, renderChildResult, renderChildCompletion } from "./render.ts";
import { CompletionDelivery } from "./delivery.ts";
import { childSummary as summary, childReports } from "./reports.ts";

export { SubagentParamsSchema } from "./params.ts";
export type { SubagentParams } from "./params.ts";
export type { ChildResult, SubagentDetails, AgentOutcome, ChildState, UsageSummary } from "./types.ts";
export { MAX_CONCURRENCY } from "./limits.ts";

function answer(command: SubagentDetails["command"], results: ChildResult[], text: string, waitExpired?: boolean): AgentToolResult<SubagentDetails> {
  return { content: [{ type: "text", text: truncateOutput(text, MAX_OUTPUT_BYTES) }], details: boundDetails({ command, results, ...(waitExpired === undefined ? {} : { waitExpired }) }) };
}

type PendingErrorDetails = Map<string, SubagentDetails>;

function outcome(toolCallId: string, command: "run" | "wait", results: ChildResult[], errors: PendingErrorDetails): AgentToolResult<SubagentDetails> {
  const waitExpired = command === "wait" ? results.every(isRunning) : undefined;
  const preamble = command === "wait"
    ? `wait_expired: ${waitExpired}\n${waitExpired ? "Wait budget expired; children continue." : "Returned ready reports; any running children continue."} Wait again only on remaining ids when their results block progress.\n\n`
    : "";
  // The model authored run prompts; keep them only where the call lacks them.
  const text = preamble + childReports(results, { includePrompt: command !== "run" });
  // Pi translates thrown tool errors into model-visible error results. Throwing
  // preserves native tool-error semantics, but Pi drops details on that path.
  // Register them so the tool_result hook can reattach them for rendering.
  if (results.some(failed)) {
    if (errors.size >= MAX_RETAINED_RUNS) errors.delete(errors.keys().next().value!);
    errors.set(toolCallId, boundDetails({ command, results, ...(waitExpired === undefined ? {} : { waitExpired }) }));
    throw new Error(truncateOutput(text));
  }
  return answer(command, results, text, waitExpired);
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-complete", renderChildCompletion);
  const createRuntime = () => {
    let delivery: CompletionDelivery;
    const children = new SessionChildren(new SubprocessChildSupervisor(), () => delivery.refreshStatus());
    delivery = new CompletionDelivery(children);
    return { children, delivery, errorDetails: new Map() as PendingErrorDetails };
  };
  let runtime = createRuntime();
  // Use the host's usage channel, including for thrown tool errors. Charging
  // snapshots or notices would duplicate costs on repeated wait/status calls.
  pi.on("tool_result", (event) => {
    runtime.delivery.refreshStatus();
    const usage = runtime.children.takePendingUsage();
    const details = runtime.errorDetails.get(event.toolCallId);
    if (details) runtime.errorDetails.delete(event.toolCallId);
    if (!usage && !details) return;
    if (usage && event.usage) addUsage(usage, event.usage);
    return { ...(usage ? { usage } : {}), ...(details ? { details } : {}) };
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
  pi.on("agent_start", (_event, ctx) => runtime.delivery.started(ctx));
  pi.on("agent_end", (event, ctx) => runtime.delivery.ended(event, ctx));
  pi.on("turn_start", (_event, ctx) => { runtime.delivery.reconcile(ctx); });
  pi.on("turn_end", (event, ctx) => runtime.delivery.boundary(event, ctx));
  pi.on("agent_before_settle", (event, ctx) => runtime.delivery.boundary(event, ctx));
  pi.on("agent_settled", (_event, ctx) => runtime.delivery.settled(ctx));

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate one self-contained task to a fresh child. run joins within a foreground budget, then lets the child finish as background work; spawn returns an id immediately and reports completion later. status, wait and stop control session-scoped children. Defaults to available coding/research tools; tools can narrow access. No profiles, nested delegation, shared history, or persistent child sessions.",
    parameters: SubagentParamsSchema,
    executionMode: "parallel",
    promptSnippet: "Use run for a fresh-context result, or spawn for independent work alongside useful local work.",
    promptGuidelines: [
      "Give subagent children relevant evidence, scope, constraints, expected output and checks. Their conversations start fresh without parent history.",
      "Prefer direct work over subagent for routine or tightly coupled tasks. Do not duplicate delegated work; the parent owns integration and verification.",
      "Spawn independent subagent tasks before waiting. Background results arrive at active-turn boundaries, never by waking idle parents. Use subagent wait with ids when blocked; it wakes when any finishes. Do not poll or wait again on reports already received. Cancelling wait leaves children running; stop cancels them.",
      "subagent run joins within a bounded foreground budget; if it expires the child keeps working and reports completion like spawn, so never relaunch it as a duplicate.",
      "Give concurrent subagent writers separate worktrees, including parent-versus-child writers. Child processes share the selected working tree; subagent does not arbitrate write ownership.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!Check(SubagentParamsSchema, params)) {
        const error = Errors(SubagentParamsSchema, params)[0]!;
        throw new Error(`Invalid subagent parameters: ${error.instancePath || "/"} ${error.message} (${truncateOutput(JSON.stringify(error.params), 512)}).`);
      }
      validateCommand(params);
      if (isChildProcess()) throw new Error("Children are leaves; nested subagent calls are not supported.");
      // Capture the owner: an old foreground call must never read a new session's registry.
      const owner = runtime.children;
      const errorDetails = runtime.errorDetails;
      runtime.delivery.bind(ctx);
      if (params.command === "status") {
        const results = params.id ? [owner.snapshot(owner.get(params.id))] : owner.list();
        return answer("status", results, results.length ? results.map((result) => summary(result)).join("\n\n") : "No retained children.");
      }
      if (params.command === "stop") {
        const result = await owner.stop(params.id!);
        return answer("stop", [result], childReports([result]));
      }
      if (params.command === "wait") {
        const results = await owner.wait(params.ids!, params.timeoutMs ?? DEFAULT_WAIT_MS, signal);
        return outcome(toolCallId, "wait", results, errorDetails);
      }
      if (signal?.aborted) throw new Error("Child launch cancelled.");
      const tools = selectTools(params.tools, pi.getActiveTools());
      const cwd = resolveCwd(ctx.cwd || process.cwd(), params.cwd);
      const foreground = params.command === "run";
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const model = params.model?.trim() ?? parentModel;
      // A different model uses its own Pi defaults, not a potentially expensive or unsupported parent effort.
      const thinking = params.thinking ?? (model === parentModel ? ctx.thinkingLevel : undefined);
      // A completed join reads the result; only unread results are eligible
      // for automatic delivery at an active parent boundary; never wake an idle parent.
      const run = owner.start({
        prompt: params.prompt!, tools, cwd, notify: true,
        model, thinking, strictThinking: params.thinking !== undefined,
        emit: foreground ? (result, progress) => onUpdate?.(answer("run", [{ ...result, state: { status: "running" } }], progress)) : undefined,
      });
      if (!foreground) return answer("spawn", [owner.snapshot(run)], `Started child ${run.result.id}. Completion will be delivered at an active-turn boundary; idle parents are not woken. Continue non-overlapping work; use wait when its result blocks finishing your task, or status/stop with this id.`);
      const abort = () => run.controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const budget = foregroundBudgetMs();
        const result = (await owner.wait([run.result.id], budget))[0]!;
        if (isRunning(result)) {
          return answer("run", [result], `${summary(result)}\nStill running after ${Math.round(budget / 1000)}s; it continues as background work. Completion is delivered at an active-turn boundary, not by waking an idle parent. Use wait when its result blocks finishing your task, or status/stop with this id.`);
        }
        return outcome(toolCallId, "run", [result], errorDetails);
      } finally { signal?.removeEventListener("abort", abort); }
    },
    renderCall: renderChildCall,
    renderResult: renderChildResult,
  });
}
