import type { AgentToolResult, ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { SessionChildren } from "./children.ts";
import { SubprocessChildSupervisor } from "./supervisor.ts";
import { SubagentParamsSchema, resolveCwd, selectTools, validateCommand } from "./params.ts";
import { DEFAULT_WAIT_MS, MAX_OUTPUT_BYTES, RUNNING_PROGRESS_TEXT, RUNTIME_UPDATE_INTERVAL_MS, foregroundBudgetMs, isChildProcess } from "./limits.ts";
import { boundDetails, truncateOutput } from "./bounds.ts";
import { addUsage, failed, isRunning } from "./types.ts";
import { SubagentDetailsSchema } from "./result-schema.ts";
import type { ChildResult, SubagentDetails } from "./types.ts";
import { renderChildCall, renderChildResult, renderChildCompletion } from "./render.ts";
import { CompletionDelivery } from "./delivery.ts";
import { childStatus as summary, childReports, formatElapsed } from "./reports.ts";

export { SubagentParamsSchema } from "./params.ts";
export type { SubagentParams } from "./params.ts";
export type { ChildResult, SubagentDetails, AgentOutcome, ChildState, UsageSummary } from "./types.ts";
export { MAX_CONCURRENCY } from "./limits.ts";

function answer(command: SubagentDetails["command"], results: ChildResult[], text: string, waitExpired?: boolean): AgentToolResult<SubagentDetails> {
  const details = boundDetails({ command, results, ...(waitExpired === undefined ? {} : { waitExpired }) });
  return { content: [{ type: "text", text: truncateOutput(text, MAX_OUTPUT_BYTES) }], details, structuredContent: details };
}

function inboxNotice(results: ChildResult[]): string {
  const items = results.slice(0, 8).map((result) =>
    `${result.handle ?? result.id.slice(0, 8)} ${result.state.status === "terminal" ? result.state.outcome : "running"}`
  ).join(", ");
  const more = results.length > 8 ? ` and ${results.length - 8} more` : "";
  return `[subagent] ${results.length} unread child result${results.length === 1 ? "" : "s"}: ${items}${more}. Call subagent wait to read ${results.length === 1 ? "it" : "them"}.`;
}

function childListText(results: ChildResult[]): string {
  const ordered = [...results].sort((left, right) => {
    const running = Number(right.state.status === "running") - Number(left.state.status === "running");
    return running || (left.startedAt ?? 0) - (right.startedAt ?? 0);
  });
  return ordered.map((result) => {
    const status = result.state.status === "running"
      ? `${result.phase ?? "starting"}${result.startedAt ? ` · ${Math.max(0, Math.round((Date.now() - result.startedAt) / 1000))}s` : ""}`
      : result.state.outcome;
    const handle = result.handle ?? result.id.slice(0, 8);
    return `${handle} [${status}] · ${result.notify ?? "inbox"} · ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"} · ${result.cwd}`;
  }).join("\n");
}

function outcome(command: "run" | "wait", results: ChildResult[]): AgentToolResult<SubagentDetails> {
  const waitExpired = command === "wait" ? results.every(isRunning) : undefined;
  const preamble = command === "wait"
    ? `wait_expired: ${waitExpired}\n${waitExpired ? "Wait budget expired; children continue." : "Returned ready reports; any running children continue."} Wait again only on remaining ids when their results block progress.\n\n`
    : "";
  // The model authored run prompts; keep them only where the call lacks them.
  const text = preamble + childReports(results, { includePrompt: command !== "run" });
  return { ...answer(command, results, text, waitExpired), isError: results.some(failed) };
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-complete", renderChildCompletion);
  const createRuntime = () => {
    let delivery: CompletionDelivery;
    const children = new SessionChildren(new SubprocessChildSupervisor(), () => delivery.refreshStatus());
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
    const inbox = event.parentToolCallId !== undefined || event.toolName === "subagent" ? [] : runtime.children.pendingInbox();
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
  pi.on("agent_start", (_event, ctx) => runtime.delivery.started(ctx));
  pi.on("agent_end", (event, ctx) => runtime.delivery.ended(event, ctx));
  pi.on("turn_start", (_event, ctx) => { runtime.children.resetInboxNotices(); runtime.delivery.reconcile(ctx); });
  pi.on("message_end", (event, ctx) => runtime.delivery.responded(event, ctx));
  pi.on("turn_end", (event, ctx) => runtime.delivery.boundary(event, ctx));
  pi.on("agent_before_settle", (event, ctx) => runtime.delivery.boundary(event, ctx));
  pi.on("agent_settled", (_event, ctx) => runtime.delivery.settled(ctx));

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate one self-contained task to a fresh child. run joins within a join budget, then lets the child finish as background work; spawn returns a handle immediately. status, wait and stop control session-scoped children. Defaults to read/search/web tools; request bash, edit, or write explicitly for mutating work. No profiles, nested delegation, shared history, or persistent child sessions.",
    parameters: SubagentParamsSchema,
    outputSchema: SubagentDetailsSchema,
    executionMode: "parallel",
    promptSnippet: "Use run for a fresh-context result, or spawn for independent work alongside useful local work.",
    promptGuidelines: [
      "Give subagent children relevant evidence, scope, constraints, expected output and checks. Their conversations start fresh without parent history.",
      "Children default to read/search/web tools. Request bash, edit, or write explicitly only when the task needs mutations, and give concurrent writers separate worktrees.",
      "Completion defaults to an inbox: the next tool result advertises unread handles, and subagent wait reads the reports. Use notify: \"turn\" only when the child must resume the parent immediately. Short sa-N handles are valid in wait/status/stop calls.",
      "Prefer direct work over subagent for routine or tightly coupled tasks. Do not duplicate delegated work; the parent owns integration and verification.",
      "Spawn independent subagent tasks before waiting. Inbox results are advertised on the next tool result and never wake an idle parent; notify: \"turn\" opts into an active-boundary continuation. Use subagent wait with ids when blocked; it wakes when any finishes. Do not poll or wait again on reports already received. Cancelling wait leaves children running; stop cancels them.",
      "subagent run joins within a join budget; if it expires the child keeps working and reports completion like spawn, so never relaunch it as a duplicate.",
      "Bound task execution with executionTimeoutMs (default 30m, at most 2h), separate from startupTimeoutMs, run's joinTimeoutMs, and wait's timeoutMs. A timed-out result keeps partial output and states elapsed runtime and the deadline, so split the task or raise the deadline instead of relaunching it unchanged.",
      "Give concurrent subagent writers separate worktrees, including parent-versus-child writers. Child processes share the selected working tree; subagent does not arbitrate write ownership.",
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
        const results = params.id ? [owner.snapshot(owner.get(params.id))] : owner.list();
        return answer("status", results, results.length ? results.map((result) => summary(result)).join("\n\n") : "No retained children.");
      }
      if (params.command === "stop") {
        const result = await owner.stop(params.id!);
        return answer("stop", [result], childReports([result]));
      }
      if (params.command === "wait") {
        const results = await owner.wait(params.ids!, params.timeoutMs ?? DEFAULT_WAIT_MS, signal);
        return outcome("wait", results);
      }
      if (signal?.aborted) throw new Error("Child launch cancelled.");
      const tools = selectTools(params.tools, pi.getActiveTools(), ctx.tools.map((tool) => tool.name));
      const cwd = resolveCwd(ctx.cwd || process.cwd(), params.cwd);
      const foreground = params.command === "run";
      let presenting = foreground;
      const present = (result: ChildResult, progress: string) => {
        if (!presenting || !onUpdate || owner.isClosed) return;
        try { onUpdate(answer("run", [{ ...result, state: { status: "running" } }], progress)); }
        catch { presenting = false; }
      };
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const model = params.model?.trim() ?? parentModel;
      // A different model uses its own Pi defaults, not a potentially expensive or unsupported parent effort.
      const thinking = params.thinking ?? (model === parentModel ? ctx.thinkingLevel : undefined);
      // A completed join reads the result; only unread results are eligible
      // for automatic delivery at an active parent boundary; never wake an idle parent.
      const run = owner.start({
        prompt: params.prompt!, tools, cwd,
        model, thinking, strictThinking: params.thinking !== undefined,
        executionTimeoutMs: params.executionTimeoutMs,
        startupTimeoutMs: params.startupTimeoutMs,
        notify: params.notify,
        emit: foreground && onUpdate ? present : undefined,
      });
      if (!foreground) return answer("spawn", [owner.snapshot(run)], `Started child ${run.handle}. Completion is delivered to the inbox${run.notify === "turn" ? " and requests one parent turn" : ""}; idle parents are not woken. Continue non-overlapping work; use wait when its result blocks finishing your task, or status/stop with this handle.`);
      // Presentation stops at the foreground join, even when execution continues.
      const timer = onUpdate ? setInterval(() => {
        if (presenting && !owner.isClosed) present(owner.snapshot(run), RUNNING_PROGRESS_TEXT);
      }, RUNTIME_UPDATE_INTERVAL_MS) : undefined;
      const abort = () => run.controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const budget = params.joinTimeoutMs ?? foregroundBudgetMs();
        const result = (await owner.wait([run.result.id], budget))[0]!;
        if (isRunning(result)) {
          return answer("run", [result], `${summary(result)}\nStill running after ${formatElapsed(budget)}; it continues as background work. ${run.notify === "turn" ? "Completion requests one active-boundary turn; idle parents are not woken." : "Completion is advertised in the inbox on the next tool result; idle parents are not woken."} Use wait when its result blocks finishing your task, or status/stop with this handle.`);
        }
        return outcome("run", [result]);
      } finally {
        presenting = false;
        if (timer) clearInterval(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
    renderCall: renderChildCall,
    renderResult: renderChildResult,
  });

  if (typeof pi.registerCommand === "function") pi.registerCommand("subagents", {
    description: "List retained child agents, or clear completed read handles",
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action === "clear" || action === "prune") {
        const removed = runtime.children.pruneDelivered();
        ctx.ui.notify(`Cleared ${removed} read child handle${removed === 1 ? "" : "s"}.`, "info");
        return;
      }
      if (action !== "" && action !== "status") {
        ctx.ui.notify("Usage: /subagents [clear]", "info");
        return;
      }
      const results = runtime.children.list();
      const unread = runtime.children.unreadCompletionCount();
      const header = results.length === 0 ? "No retained child agents." : `${results.length} retained · ${unread} unread`;
      ctx.ui.notify(`${header}\n${childListText(results)}`.trim(), "info");
    },
  });
}
