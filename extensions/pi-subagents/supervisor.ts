import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";

import { MAX_CONCURRENCY, MAX_DIAGNOSTIC_BYTES, MAX_STDERR_BYTES, RUNNING_PROGRESS_TEXT, RUNTIME_UPDATE_INTERVAL_MS } from "./limits.ts";
import { emptyUsage, getFinalOutput, textFromMessage } from "./types.ts";
import type { AgentResult } from "./types.ts";
import { boundedDiagnostic, structuredOutputPrompt, truncateOutput, validateStructuredOutput } from "./bounds.ts";
import { childDelegationPolicy, releaseChild, reserveChild } from "./control.ts";
import type { ChildReservation, ControlContext, DelegationPolicy } from "./control.ts";
import { recordMessage, runPiProcess } from "./subprocess.ts";

export interface ExecutionContext {
  runId: string;
  parentRunId?: string;
  /** Reservation held by this nested process in its parent's control state. */
  reservationRunId?: string;
  rootRunId: string;
  depth: number;
  deadlineMs: number;
  control: ControlContext;
  delegationPolicy?: DelegationPolicy;
}

export interface ChildRunRequest {
  name: string;
  task: string;
  cwd: string;
  modelOverride?: string;
  step?: number;
  signal?: AbortSignal;
  emit: (result: AgentResult, progress?: string) => void;
}

/**
 * Internal child execution boundary. Public modes and future workflow modes
 * must use this path so they share subprocess lifecycle and root budgets.
 */
export interface ChildSupervisor {
  run(request: ChildRunRequest): Promise<AgentResult>;
  runBatch(requests: ChildRunRequest[]): Promise<AgentResult[]>;
}

export function modelName(model: Model<any> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export function resolveModel(agent: AgentConfig, override: string | undefined, parentModel: Model<any> | undefined): string | undefined {
  return override ?? agent.model ?? modelName(parentModel);
}

export function effectiveTools(agent: AgentConfig): string[] {
  // An omitted allowlist is intentionally empty. In particular, it must not
  // fall through to pi's default all-tools behavior.
  const tools = [...(agent.tools ?? [])].filter((tool) => tool !== "subagent");
  if (agent.delegation) tools.push("subagent");
  return [...new Set(tools)];
}

export function potentiallyMutating(agent: AgentConfig | undefined): boolean {
  // Missing metadata is conservative: a task may mutate the worktree.
  return agent?.capability !== "read";
}

export class SubprocessChildSupervisor implements ChildSupervisor {
  constructor(
    private readonly agents: AgentConfig[],
    private readonly execution: ExecutionContext,
    private readonly parentModel: Model<any> | undefined,
    private readonly parentThinkingLevel: string | undefined,
  ) {}

  /**
   * Own the full child lifecycle: admission, prompt-file setup, process
   * execution, result reporting, and release. Future workflow modes must call
   * this boundary rather than creating a second scheduler or bypassing the
   * root-wide control state.
   */
  async run(request: ChildRunRequest): Promise<AgentResult> {
    const { name, task, cwd, modelOverride, step, signal, emit } = request;
    const { agents, execution, parentModel } = this;
    const agent = agents.find((candidate) => candidate.name === name);
    if (!agent) {
      return {
        agent: name,
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
        errorMessage: truncateOutput(`Unknown agent: "${name}". Available agents: ${agents.map((item) => item.name).join(", ") || "none"}.`, MAX_DIAGNOSTIC_BYTES),
        stderr: "",
        messages: [],
        usage: emptyUsage(),
      };
    }

    const result: AgentResult = {
      agent: name,
      agentSource: agent.source,
      task: truncateOutput(task, MAX_DIAGNOSTIC_BYTES),
      runId: randomUUID(),
      parentRunId: execution.runId,
      rootRunId: execution.rootRunId,
      depth: execution.depth + 1,
      step,
      exitCode: -1,
      stderr: "",
      messages: [],
      usage: emptyUsage(),
      model: resolveModel(agent, modelOverride, parentModel),
    };
    const childPolicy = childDelegationPolicy(execution.delegationPolicy, agent);
    let updateError: string | undefined;
    let eventFailure: string | undefined;
    let terminalOutput: string | undefined;
    let runtimeTimer: ReturnType<typeof setInterval> | undefined;
    const report = (progress: string, propagate = true) => {
      if (result.exitCode !== -1 && result.startedAt !== undefined && result.finishedAt === undefined) {
        result.finishedAt = Date.now();
      }
      try {
        emit(result, progress);
      } catch (error) {
        updateError = error instanceof Error ? error.message : String(error);
        if (propagate) throw error;
      }
    };

    let tempDir: string | undefined;
    let delegationPolicyPath: string | undefined;
    let reservation: ChildReservation | undefined;
    try {
      report(`Starting ${name}...`);
      const reservationResult = await reserveChild(execution.control, result.runId, signal);
      if (!reservationResult.reservation) {
        result.exitCode = 1;
        result.termination = reservationResult.termination ?? (signal?.aborted ? "cancelled" : "failed");
        result.stopReason = result.termination === "cancelled" ? "aborted" : "error";
        result.errorMessage = truncateOutput(reservationResult.reason ?? "Subagent child budget unavailable.", MAX_DIAGNOSTIC_BYTES);
        report(result.errorMessage, false);
        return result;
      }
      reservation = reservationResult.reservation;
      result.startedAt = Date.now();
      report(RUNNING_PROGRESS_TEXT);
      runtimeTimer = setInterval(() => {
        try {
          emit(result, RUNNING_PROGRESS_TEXT);
        } catch {
          // Runtime display updates are best effort and must not fail the child.
        }
      }, RUNTIME_UPDATE_INTERVAL_MS);
      const args = ["--mode", "json", "-p", "--no-session"];
      if (result.model) args.push("--model", result.model);
      // Explicit agent frontmatter wins, then the parent's session level. Pi
      // maps generic levels per model and drops them for non-reasoning models,
      // so inheritance is safe across a model override.
      const thinking = agent.thinking ?? this.parentThinkingLevel;
      if (thinking) args.push("--thinking", thinking);
      const tools = effectiveTools(agent);
      if (tools.length > 0) args.push("--tools", tools.join(","));
      else args.push("--no-tools");
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
      const systemPrompt = [
        agent.systemPrompt.trim(),
        agent.outputSchema ? structuredOutputPrompt(agent.outputSchema) : "",
      ].filter(Boolean).join("\n\n");
      if (systemPrompt) {
        const promptPath = path.join(tempDir, "system-prompt.md");
        await fs.promises.writeFile(promptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });
        args.push("--append-system-prompt", promptPath);
      }
      const taskPath = path.join(tempDir, "task.md");
      await fs.promises.writeFile(taskPath, `Task:\n${task}`, { encoding: "utf8", mode: 0o600 });
      args.push(`@${taskPath}`);
      if (childPolicy) {
        delegationPolicyPath = path.join(tempDir, "delegation-policy.json");
        await fs.promises.writeFile(delegationPolicyPath, JSON.stringify(childPolicy), { encoding: "utf8", mode: 0o600 });
      }

      const processResult = await runPiProcess(args, cwd, execution.depth, execution.control, execution.runId, result.runId, reservation, signal, (event) => {
        if (event.kind === "message" && event.message) {
          if (event.message.role === "assistant" && (event.message.stopReason === "stop" || event.message.stopReason === "length")) {
            terminalOutput = textFromMessage(event.message);
          }
          recordMessage(result, event.message);
          if (eventFailure) {
            result.stopReason = "error";
            result.errorMessage = eventFailure;
          }
          report(result.output || getFinalOutput(result.messages) || "Subagent is working...");
        } else if (event.kind === "messages" && event.messages && result.messages.length === 0) {
          for (const message of event.messages) {
            if (message.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "length")) {
              terminalOutput = textFromMessage(message);
            }
            recordMessage(result, message);
          }
          report(result.output || getFinalOutput(result.messages) || "Subagent finished...");
        } else if (event.kind === "progress") {
          report(event.text || "Subagent is working...");
        } else if (event.kind === "error") {
          eventFailure = truncateOutput(event.errorMessage || "Subagent process reported an error.", MAX_DIAGNOSTIC_BYTES);
          result.stopReason = "error";
          result.errorMessage = eventFailure;
          report(eventFailure);
        }
      }, delegationPolicyPath);

      const messageTermination = result.termination;
      result.exitCode = processResult.exitCode;
      result.termination = processResult.termination;
      // A protocol-level error/abort must not be hidden by a zero exit code.
      if (messageTermination === "failed" || messageTermination === "cancelled") result.termination = messageTermination;
      result.stopReason = processResult.stopReason ?? result.stopReason ?? (processResult.exitCode === 0 ? "stop" : "error");
      result.errorMessage = boundedDiagnostic(processResult.errorMessage ?? result.errorMessage);
      result.stderr = truncateOutput(processResult.stderr, MAX_STDERR_BYTES);
      if (eventFailure) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.termination = "failed";
        result.errorMessage = eventFailure;
      } else if (updateError) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.termination = "failed";
        result.errorMessage = truncateOutput(`Subagent update failed: ${updateError}`, MAX_DIAGNOSTIC_BYTES);
      } else if (processResult.termination === "completed" && result.termination !== "completed") {
        result.exitCode = 1;
        result.stopReason = "error";
        result.termination = "failed";
        result.errorMessage ??= "Subagent produced no assistant output; a terminal response is required.";
      } else if (processResult.termination === "completed" && !result.output) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.termination = "failed";
        result.errorMessage ??= "Subagent produced no assistant output; a terminal response is required.";
      }
      if (agent.outputSchema && result.termination === "completed" && result.output) {
        const structured = validateStructuredOutput(agent.outputSchema, terminalOutput ?? result.output);
        if (structured.error) {
          result.exitCode = 1;
          result.stopReason = "error";
          result.termination = "failed";
          result.errorMessage = truncateOutput(structured.error, MAX_DIAGNOSTIC_BYTES);
        } else {
          result.structuredOutput = structured.value;
        }
      }
      if (result.stopReason === "error" && !result.errorMessage) result.errorMessage = "Subagent failed.";
      report(result.output || result.errorMessage || "(no output)", false);
      if (updateError && result.exitCode === 0) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.termination = "failed";
        result.errorMessage = truncateOutput(`Subagent update failed: ${updateError}`, MAX_DIAGNOSTIC_BYTES);
      }
      return result;
    } catch (error) {
      result.exitCode = 1;
      result.termination = signal?.aborted ? "cancelled" : execution.deadlineMs <= Date.now() ? "timed_out" : "failed";
      result.stopReason = result.termination === "cancelled" ? "aborted" : "error";
      result.errorMessage = boundedDiagnostic(error instanceof Error ? error.message : String(error), MAX_DIAGNOSTIC_BYTES) ?? "Subagent failed.";
      result.stderr = result.errorMessage;
      report(result.errorMessage, false);
      return result;
    } finally {
      if (runtimeTimer) clearInterval(runtimeTimer);
      if (result.startedAt !== undefined && result.finishedAt === undefined) result.finishedAt = Date.now();
      if (tempDir) {
        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; the prompt contains no secrets beyond the agent definition.
        }
      }
      if (reservation) await releaseChild(execution.control, result.runId);
    }
  }

  /** Run an explicit bounded batch through the same root-wide supervisor. */
  runBatch(requests: ChildRunRequest[]): Promise<AgentResult[]> {
    return mapWithConcurrency(requests, (request) => this.run(request));
  }
}

export function failed(result: AgentResult): boolean {
  // -1 is the live placeholder used by parallel progress updates.
  return result.exitCode !== -1 && (
    result.exitCode !== 0
    || result.stopReason === "error"
    || result.stopReason === "aborted"
    || result.termination === "failed"
    || result.termination === "cancelled"
    || result.termination === "timed_out"
  );
}

export function resultText(result: AgentResult): string {
  if (failed(result)) return result.errorMessage || result.stderr || result.output || getFinalOutput(result.messages) || "(no output)";
  return result.output || getFinalOutput(result.messages) || "(no output)";
}

export function copyResult(result: AgentResult): AgentResult {
  const structuredOutput = result.structuredOutput === undefined
    ? undefined
    : JSON.parse(JSON.stringify(result.structuredOutput));
  return { ...result, structuredOutput, messages: [...result.messages], usage: { ...result.usage, cost: { ...result.usage.cost } } };
}

export async function mapWithConcurrency<T>(items: T[], fn: (item: T, index: number) => Promise<AgentResult>): Promise<AgentResult[]> {
  const results: AgentResult[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, worker));
  return results;
}
