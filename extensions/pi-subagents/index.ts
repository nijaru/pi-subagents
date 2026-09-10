import * as path from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { SessionChildren } from "./children.ts";
import { SubprocessChildSupervisor, failed, resultText } from "./supervisor.ts";
import { SubagentParamsSchema, selectTools, validateCommand } from "./params.ts";
import { DEFAULT_WAIT_MS, MAX_OUTPUT_BYTES, isChildProcess } from "./limits.ts";
import { existingDirectory } from "./locations.ts";
import { boundDetails, truncateOutput } from "./bounds.ts";
import type { ChildResult, SubagentDetails } from "./types.ts";
import { renderChildCall, renderChildResult, renderChildCompletion, runtimeLabel } from "./render.ts";

export { SubagentParamsSchema } from "./params.ts";
export type { SubagentParams } from "./params.ts";
export type { ChildResult, SubagentDetails, AgentTermination, UsageSummary } from "./types.ts";
export { MAX_CONCURRENCY } from "./limits.ts";

function summary(result: ChildResult): string {
  const status = result.exitCode === -1 ? "running" : result.termination ?? "failed";
  return `${result.id} [${status}]${runtimeLabel(result) ? ` · ${runtimeLabel(result)}` : ""}\n${truncateOutput(result.prompt, 256)}`;
}

function answer(command: SubagentDetails["command"], results: ChildResult[], text: string): AgentToolResult<SubagentDetails> {
  return { content: [{ type: "text", text: truncateOutput(text, MAX_OUTPUT_BYTES) }], details: boundDetails({ command, results }) };
}

function outcome(command: SubagentDetails["command"], result: ChildResult): AgentToolResult<SubagentDetails> {
  const text = `${summary(result)}\n\n${resultText(result)}`;
  // Pi translates thrown tool errors into model-visible error results. The
  // session registry still retains the typed result for status/inspection.
  if (failed(result)) throw new Error(truncateOutput(text));
  return answer(command, [result], text);
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-complete", renderChildCompletion);
  const createChildren = () => new SessionChildren(new SubprocessChildSupervisor(), (result) => {
    pi.sendMessage({
      customType: "subagent-complete",
      content: `Background child finished.\n${summary(result)}\n\n${truncateOutput(resultText(result), 8 * 1024)}\n\nUse subagent wait with this id for the retained result.`,
      display: true,
      details: boundDetails({ command: "wait", results: [result] }),
    }, { triggerTurn: true, deliverAs: "followUp" });
  });
  let children = createChildren();
  pi.on("session_shutdown", async () => { await children.close(); });
  pi.on("session_start", async () => {
    await children.close();
    children = createChildren();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate one self-contained task to a fresh child. run waits; spawn returns an id and reports completion later. status, wait and stop control session-scoped children. Defaults to available coding/research tools; tools can narrow access. No profiles, nested delegation, shared history, or persistent child sessions.",
    parameters: SubagentParamsSchema,
    executionMode: "sequential",
    promptSnippet: "Use run for a fresh-context result, or spawn for independent work alongside useful local work.",
    promptGuidelines: [
      "Give the child relevant evidence, scope, constraints, expected output and checks. Its conversation starts fresh; it does not receive parent history.",
      "Prefer direct work for routine or tightly coupled tasks. Do not duplicate delegated work. The parent owns integration and verification.",
      "Background children send completion notices. Wait only when their result blocks your next step. Cancelling wait does not stop the child; use stop.",
      "Use separate worktrees for concurrent writers, including parent-versus-child writers. Children are separate processes that share one working tree; the extension does not arbitrate write ownership.",
    ],
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!Check(SubagentParamsSchema, params)) throw new Error("Invalid subagent parameters. Use command: run/spawn with prompt, or status/wait/stop with id. Named agents, tasks[], chain, workflow and background objects are no longer supported.");
      validateCommand(params);
      if (isChildProcess()) throw new Error("Children are leaves; nested subagent calls are not supported.");
      // Capture the owner: an old foreground call must never read a new session's registry.
      const owner = children;
      if (params.command === "status") {
        const results = params.id ? [owner.snapshot(owner.get(params.id))] : owner.list();
        return answer("status", results, results.length ? results.map(summary).join("\n\n") : "No retained children.");
      }
      if (params.command === "stop") {
        const result = await owner.stop(params.id!);
        return answer("stop", [result], `${summary(result)}\n\n${resultText(result)}`);
      }
      if (params.command === "wait") {
        const result = await owner.wait(params.id!, params.timeoutMs ?? DEFAULT_WAIT_MS, signal);
        if (result.exitCode === -1) return answer("wait", [result], `${summary(result)}\nStill running; the wait budget expired. The child continues and will send a completion notice.`);
        return outcome("wait", result);
      }
      if (signal?.aborted) throw new Error("Child launch cancelled.");
      const tools = selectTools(params.tools, pi.getActiveTools());
      const cwd = existingDirectory(path.resolve(ctx.cwd || process.cwd(), params.cwd ?? "."));
      const background = params.command === "spawn";
      const run = owner.start({
        prompt: params.prompt!, tools, cwd, background,
        model: params.model?.trim() ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
        thinking: ctx.thinkingLevel,
        emit: background ? undefined : (result, progress) => onUpdate?.(answer("run", [{ ...result, exitCode: -1, termination: undefined, finishedAt: undefined }], progress)),
      });
      if (background) return answer("spawn", [owner.snapshot(run)], `Started child ${run.result.id}. It will report completion automatically. Continue non-overlapping work; use status, wait or stop with this id.`);
      const abort = () => run.controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try { return outcome("run", await run.promise); }
      finally { signal?.removeEventListener("abort", abort); }
    },
    renderCall: renderChildCall,
    renderResult: renderChildResult,
  });
}
