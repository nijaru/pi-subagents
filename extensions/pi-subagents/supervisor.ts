import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AssistantMessage, ModelThinkingLevel, StopReason } from "@earendil-works/pi-ai";
import { boundedDiagnostic, truncateOutput, utf8Prefix } from "./bounds.ts";
import { childEnvironment } from "./env.ts";
import { MAX_OUTPUT_BYTES, RUNNING_PROGRESS_TEXT, processTimeoutMs, startupTimeoutMs } from "./limits.ts";
import { timeoutSummary, withCredentialHint } from "./reports.ts";
import { cleanupChild, hasExited, spawnDeathWatchdog } from "./process-tree.ts";
import { addUsage, emptyUsage, isUsage, textFromMessage, type ChildResult } from "./types.ts";
import { PROBE_COMMAND, PROBE_CUSTOM_TYPE, PROBE_DEADLINE_ENV, PROBE_TOKEN_ENV, PROBE_TOOLS_ENV, type ProbeReport } from "./probe-protocol.ts";
import { acquireSession, getRpcInvocation } from "./launch.ts";
import { ChildRpc, type ChildEvent } from "./rpc.ts";

export interface ChildTask {
  readonly id: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly strictThinking?: boolean;
  readonly persist?: boolean;
  readonly resume?: string;
  readonly trustProject?: boolean;
  readonly excludeTools?: readonly string[];
  readonly executionTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

/** Execution facts; the session registry owns handles, admission and delivery. */
export type ChildExecutionData = Pick<ChildResult,
  "startedAt" | "taskFinishedAt" | "phase" | "model" | "thinking" | "usage" | "output" | "outputTruncation" | "stdout" | "stderr" | "errorMessage" | "sessionFile"
>;
export interface ChildControl { steer(message: string, signal?: AbortSignal): Promise<void>; }
export interface ChildRunRequest {
  readonly task: ChildTask;
  readonly signal: AbortSignal;
  readonly onUpdate?: (data: ChildExecutionData, progress?: string) => void;
  readonly onControl?: (control: ChildControl) => void;
}
export interface ChildExecutionOutcome {
  outcome: "completed" | "incomplete" | "failed" | "cancelled" | "timed_out";
  exitCode: number;
  stopReason?: StopReason;
  errorMessage?: string;
  errorKind?: "startup" | "provider" | "protocol" | "deadline" | "cancelled" | "cleanup" | "unknown";
  timeoutPhase?: "startup" | "execution";
}
export interface ChildExecutionResult extends ChildExecutionData, ChildExecutionOutcome {}
export interface ChildSupervisor { run(request: ChildRunRequest): Promise<ChildExecutionResult>; }

type Phase = "starting" | "running" | "stopping" | "settled";
type End = { kind: "settled" } | { kind: "cancelled" }
  | { kind: "deadline"; phase: "startup" | "execution"; budget: number; elapsed: number }
  | { kind: "failure"; message: string; startup: boolean };

function classify(end: End, assistant: AssistantMessage | undefined, output: string | undefined): ChildExecutionOutcome {
  if (end.kind === "deadline") return {
    outcome: "timed_out", exitCode: 1, stopReason: "error", errorKind: "deadline", timeoutPhase: end.phase,
    errorMessage: timeoutSummary(end.elapsed, end.budget, end.phase),
  };
  if (end.kind === "cancelled") return {
    outcome: "cancelled", exitCode: 1, stopReason: "aborted", errorKind: "cancelled", errorMessage: "Subagent cancelled.",
  };
  if (end.kind === "failure") return {
    outcome: "failed", exitCode: 1, stopReason: "error", errorKind: end.startup ? "startup" : "protocol",
    errorMessage: withCredentialHint(end.message),
  };
  const errorMessage = boundedDiagnostic(assistant?.errorMessage);
  switch (assistant?.stopReason) {
    case "error": return { outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "provider", errorMessage: withCredentialHint(errorMessage || "Child provider returned an error.") };
    case "length": return { outcome: "incomplete", exitCode: 1, stopReason: "length", errorKind: "provider", errorMessage: "Child reached the model output limit; response is incomplete." };
    case "aborted": return { outcome: "cancelled", exitCode: 1, stopReason: "aborted", errorKind: "cancelled", errorMessage: errorMessage || "Child aborted." };
    case "stop": if (output) return { outcome: "completed", exitCode: 0, stopReason: "stop" };
  }
  return { outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "protocol", errorMessage: errorMessage || "Child produced no terminal assistant output; a final response is required." };
}

/** All startup operations share this deadline; no additional readiness ceiling. */
export function startupRemainingMs(startedAt: number, budgetMs: number, now = Date.now()): number {
  return Math.max(1, budgetMs - Math.max(0, now - startedAt));
}

async function drainBeforeExit(rpc: ChildRpc): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([rpc.drained, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One real Pi RPC process per task, with one startup/run/cleanup lifecycle. */
export class RpcChildSupervisor implements ChildSupervisor {
  async run({ task, signal, onUpdate, onControl }: ChildRunRequest): Promise<ChildExecutionResult> {
    const startedAt = Date.now();
    const startupBudget = task.startupTimeoutMs ?? startupTimeoutMs();
    const data: ChildExecutionData = { phase: "starting", startedAt, stderr: "", usage: emptyUsage() };
    const snapshot = (): ChildExecutionData => ({ ...data, usage: { ...data.usage, cost: { ...data.usage.cost } }, outputTruncation: data.outputTruncation ? { ...data.outputTruncation } : undefined });
    const publish = (progress?: string) => { try { onUpdate?.(snapshot(), progress); } catch { /* Presentation is best effort. */ } };
    let phase: Phase = "starting";
    let releaseSession: (() => void) | undefined;
    let child: ChildProcess;
    let invocation: ReturnType<typeof getRpcInvocation>;
    let probeToken: string | undefined;
    try {
      if (signal.aborted) return { ...snapshot(), ...classify({ kind: "cancelled" }, undefined, undefined) };
      invocation = getRpcInvocation(task);
      data.sessionFile = invocation.sessionFile;
      if (invocation.sessionFile) releaseSession = acquireSession(invocation.sessionFile, task.id);
      const env = childEnvironment(task.id, task.cwd);
      if (invocation.probe) {
        env[PROBE_TOKEN_ENV] = randomUUID();
        env[PROBE_TOOLS_ENV] = JSON.stringify(task.tools);
        // An absolute shared deadline avoids another relative probe clock.
        env[PROBE_DEADLINE_ENV] = String(startedAt + startupBudget);
      }
      child = spawn(invocation.command, invocation.args, { cwd: task.cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      probeToken = env[PROBE_TOKEN_ENV];
    } catch (error) {
      releaseSession?.();
      return { ...snapshot(), ...classify({ kind: "failure", startup: true, message: String(error instanceof Error ? error.message : error) }, undefined, undefined) };
    }

    const ended = Promise.withResolvers<End>();
    const probe = Promise.withResolvers<ProbeReport | undefined>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ChildProcess | undefined;
    let assistant: AssistantMessage | undefined;
    let streaming = "";
    let streamingBytes = 0;
    let assistantOpen = false;
    let lastPublish = 0;
    let rpc: ChildRpc;
    const stop = (reason: End) => {
      if (phase === "stopping" || phase === "settled") return;
      phase = "stopping";
      data.phase = "stopping";
      data.taskFinishedAt = Date.now();
      if (timer) clearTimeout(timer);
      rpc.close();
      probe.resolve(undefined);
      publish();
      ended.resolve(reason);
    };
    const fail = (error: Error) => stop({ kind: "failure", startup: phase === "starting", message: boundedDiagnostic(error.message) ?? "Child RPC failed." });
    const armDeadline = (which: "startup" | "execution", start: number, budget: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => stop({ kind: "deadline", phase: which, budget, elapsed: Date.now() - start }), Math.max(1, start + budget - Date.now()));
      timer.unref?.();
    };
    const updateOutput = () => {
      const text = assistantOpen ? streaming : assistant ? textFromMessage(assistant) : streaming;
      const bytes = assistantOpen ? streamingBytes : Buffer.byteLength(text);
      data.output = truncateOutput(text, MAX_OUTPUT_BYTES, bytes);
      data.outputTruncation = bytes > Buffer.byteLength(data.output) ? {
        truncated: true, originalBytes: bytes, retainedBytes: Buffer.byteLength(data.output),
      } : undefined;
    };
    const event = (event: ChildEvent) => {
      if (phase === "stopping" || phase === "settled") return;
      switch (event.type) {
        case "extension_ui_request":
          if (["select", "confirm", "input", "editor"].includes(event.method)) rpc.respond({ type: "extension_ui_response", id: event.id, cancelled: true });
          break;
        case "extension_error":
          rpc.diagnostic(`\nChild extension error (${event.event ?? "unknown"}): ${event.error ?? "unknown"}`);
          break;
        case "message_start":
          if (event.message?.role === "assistant") { streaming = ""; streamingBytes = 0; assistantOpen = true; }
          break;
        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") {
            const delta = event.assistantMessageEvent.delta;
            if (typeof delta !== "string") throw new Error("Child RPC emitted a malformed text delta.");
            assistantOpen = true;
            streamingBytes += Buffer.byteLength(delta);
            streaming = utf8Prefix(streaming + delta, MAX_OUTPUT_BYTES * 2);
            if (Date.now() - lastPublish >= 500) { lastPublish = Date.now(); updateOutput(); publish(); }
          }
          break;
        case "entry_appended":
          if (event.entry?.type === "custom" && event.entry.customType === PROBE_CUSTOM_TYPE) {
            const report = event.entry.data as Partial<ProbeReport> | undefined;
            if (report?.token !== probeToken || !Array.isArray(report?.tools) || !report.tools.every((name) => typeof name === "string")) {
              throw new Error("Child probe returned malformed readiness.");
            }
            probe.resolve(report as ProbeReport);
          }
          break;
        case "message_end":
          if (event.message?.role === "assistant") {
            assistantOpen = false;
            assistant = event.message;
            data.usage.turns++;
            if (isUsage(assistant.usage)) addUsage(data.usage, assistant.usage);
            data.errorMessage = boundedDiagnostic(assistant.errorMessage);
            updateOutput();
            publish();
          } else if (event.message?.role === "toolResult" && isUsage(event.message.usage)) addUsage(data.usage, event.message.usage);
          break;
        case "compaction_end":
          if (isUsage(event.result?.usage)) addUsage(data.usage, event.result.usage);
          break;
        case "tool_execution_start": publish(`Running ${truncateOutput(String(event.toolName), 256)}...`); break;
        case "agent_settled": stop(event.aborted ? { kind: "cancelled" } : { kind: "settled" }); break;
      }
    };
    rpc = new ChildRpc(child, event, fail);
    const abort = () => stop({ kind: "cancelled" });
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => fail(new Error(`Child RPC process error: ${error.message}`)));
    child.once("exit", (code, exitSignal) => {
      // exit is not stdout exhaustion. Let buffered final records settle first,
      // but do not hang on a descendant that inherited stdout.
      void drainBeforeExit(rpc).then(() => {
        if (phase !== "stopping" && phase !== "settled") fail(new Error(`Child RPC exited before completion (code=${code ?? "null"} signal=${exitSignal ?? "null"}).`));
      });
    });
    armDeadline("startup", startedAt, startupBudget);
    if (signal.aborted) abort();
    publish(RUNNING_PROGRESS_TEXT);
    const watchdogSetup = spawnDeathWatchdog(child, invocation.command).then((process) => {
      watchdog = process;
      if (phase === "stopping" || phase === "settled") watchdog?.stdin?.end();
      watchdog?.once("exit", () => {
        if (phase !== "stopping" && phase !== "settled") fail(new Error("Child RPC watchdog exited unexpectedly."));
      });
    }).catch((error) => fail(new Error(`Child RPC watchdog failed: ${error instanceof Error ? error.message : error}`)));

    const initialize = async () => {
      await watchdogSetup;
      if (phase !== "starting") return;
      const remaining = () => startupRemainingMs(startedAt, startupBudget);
      const state = (await rpc.request({ type: "get_state" }, remaining())).data;
      if (!state?.model) throw new Error("Child has no selected model.");
      const model = `${state.model.provider}/${state.model.id}`;
      if (task.model && model !== task.model) throw new Error(`Child model ${model} does not match requested ${task.model}.`);
      if (task.strictThinking && state.thinkingLevel !== task.thinking) throw new Error(`Child thinking ${state.thinkingLevel} does not match requested ${task.thinking}.`);
      if (invocation.probe) {
        const commands = (await rpc.request({ type: "get_commands" }, remaining())).data?.commands;
        if (!Array.isArray(commands) || !commands.some((command) => command.name === PROBE_COMMAND && command.source === "extension")) throw new Error("Child probe extension is unavailable.");
        const response = await rpc.request({ type: "prompt", message: `/${PROBE_COMMAND}` }, remaining());
        if (response.data?.disposition !== "handled") throw new Error("Child probe command was not handled.");
        const report = await probe.promise;
        if (phase !== "starting") return;
        if (!report) throw new Error("Child probe ended without readiness.");
        const missing = task.tools.filter((tool) => !report.tools.includes(tool));
        if (missing.length) throw new Error(`Requested child tools are unavailable: ${missing.join(", ")}`);
        if (new Set(report.tools).size !== task.tools.length || report.tools.length !== task.tools.length) throw new Error("Child tool selection did not match request.");
      }
      if (phase !== "starting") return;
      data.model = model;
      data.thinking = state.thinkingLevel;
      data.phase = "running";
      phase = "running";
      armDeadline("execution", Date.now(), task.executionTimeoutMs ?? processTimeoutMs());
      publish();
      const response = await rpc.request({ type: "prompt", message: `Task:\n\n${task.prompt}` });
      if (response.data?.disposition !== "started") throw new Error("Child did not start the submitted task.");
      if (phase !== "running") return;
      onControl?.({ async steer(message, signal) {
        if (phase !== "running") throw new Error("Child is no longer running.");
        const response = await rpc.request({ type: "steer", message: `Steering instruction:\n\n${message}` }, 30_000, signal);
        if (response.data?.disposition !== "queued") throw new Error("Child handled steering without queuing it.");
      } });
    };
    void initialize().catch((error) => {
      if (phase !== "starting" && phase !== "running") return;
      if (phase === "starting" && Date.now() >= startedAt + startupBudget) {
        stop({ kind: "deadline", phase: "startup", budget: startupBudget, elapsed: Date.now() - startedAt });
      } else fail(error instanceof Error ? error : new Error(String(error)));
    });

    const end = await ended.promise;
    signal.removeEventListener("abort", abort);
    updateOutput();
    const cleanup = await cleanupChild(child, watchdog, end.kind === "settled");
    await watchdogSetup;
    data.stderr = rpc.diagnostics;
    if (cleanup.leaderExited) releaseSession?.();
    // Unconfirmed cleanup retains the lock; a later launch must never write a
    // session that an old child might still own.
    phase = "settled";
    const outcome = classify(end, assistant, data.output);
    if (cleanup.error) {
      outcome.outcome = "failed";
      outcome.exitCode = 1;
      outcome.errorKind = "cleanup";
      outcome.errorMessage = [outcome.errorMessage, cleanup.error, !hasExited(child) && data.sessionFile ? "Session ownership lock retained." : undefined].filter(Boolean).join("\n");
    }
    return { ...snapshot(), ...outcome };
  }
}
