import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel, StopReason, Usage } from "@earendil-works/pi-ai";
import { boundedDiagnostic, truncateHeadTail, truncateOutput } from "./bounds.ts";
import { childEnvironment } from "./env.ts";
import {
  MAX_OUTPUT_BYTES,
  MAX_PROTOCOL_LINE_BYTES,
  MAX_STDERR_BYTES,
  RUNNING_PROGRESS_TEXT,
  processTimeoutMs,
  startupTimeoutMs,
} from "./limits.ts";
import { timeoutSummary, withCredentialHint } from "./reports.ts";
import { spawnDeathWatchdog, sweepRootProcessGroup, terminateProcessTree } from "./process-tree.ts";
import { addUsage, emptyUsage, textFromMessage, type ChildResult } from "./types.ts";
import { PROBE_COMMAND, PROBE_CUSTOM_TYPE, PROBE_TIMEOUT_ENV, PROBE_TOKEN_ENV, PROBE_TOOLS_ENV, type ProbeReport } from "./probe-protocol.ts";

export interface ChildTask {
  readonly id: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly strictThinking?: boolean;
  /** Persist the child Pi session under the agent directory for later inspection. */
  readonly persist?: boolean;
  /** Existing session file to continue instead of starting fresh. */
  readonly resume?: string;
  /** Trust project-local resources in the child. Off by default. */
  readonly trustProject?: boolean;
  /** Tools that must remain unreachable through nested/codemode calls. */
  readonly excludeTools?: readonly string[];
  /** Per-task execution deadline, starting when Pi accepts the prompt. */
  readonly executionTimeoutMs?: number;
  /** Per-task startup deadline for the RPC process and get_state. */
  readonly startupTimeoutMs?: number;
}

/** Execution data never includes session identity, lifecycle, or delivery state. */
export type ChildExecutionData = Pick<ChildResult,
  "startedAt" | "taskFinishedAt" | "phase" | "model" | "thinking" | "usage" | "output" | "outputTruncation" | "stdout" | "stderr" | "errorMessage" | "sessionFile"
>;

/** A running child can accept steering without exposing its process. */
export interface ChildControl {
  steer(message: string): Promise<void>;
}

export interface ChildRunRequest {
  readonly task: ChildTask;
  readonly signal: AbortSignal;
  /** Detached snapshots; progress text is optional for metadata-only updates. */
  readonly onUpdate?: (data: ChildExecutionData, progress?: string) => void;
  /** Called once the child has accepted the task and can accept steering. */
  readonly onControl?: (control: ChildControl) => void;
}

/** Execution facts only. The session registry owns lifecycle and notification. */
export interface ChildExecutionOutcome {
  outcome: "completed" | "incomplete" | "failed" | "cancelled" | "timed_out";
  exitCode: number;
  stopReason?: StopReason;
  errorMessage?: string;
  errorKind?: "startup" | "provider" | "protocol" | "deadline" | "cancelled" | "unknown";
  timeoutPhase?: "startup" | "execution";
}
export interface ChildExecutionResult extends ChildExecutionData, ChildExecutionOutcome {}

export interface ChildSupervisor {
  /** Owns execution data and resolves only after process-tree cleanup. */
  run(request: ChildRunRequest): Promise<ChildExecutionResult>;
}

interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: any;
  error?: string;
}

type RpcRecord = Record<string, any> & { type?: string };

const COMMAND_TIMEOUT_MS = 30_000;
const TERMINAL_EXIT_GRACE_MS = 3_000;
const KILL_GRACE_MS = 3_000;
const FORCE_SETTLE_MS = 16_000;
const TASK_ENVELOPE = "Task:\n\n";
const STEER_ENVELOPE = "Steering instruction:\n\n";
const AGENT_END_PREFIX = '{"type":"agent_end"';

export function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      if (fs.statSync(candidate).isFile() && (fs.accessSync(candidate, fs.constants.X_OK), true)) {
        return fs.realpathSync.native(candidate);
      }
    } catch {
      // Keep searching.
    }
  }
  return undefined;
}

function getNodeRuntime(): string {
  const basename = path.basename(process.execPath).toLowerCase();
  if (/^node(\.exe)?$/.test(basename)) return process.execPath;
  const node = findOnPath(process.platform === "win32" ? "node.exe" : "node");
  if (!node) throw new Error("Child RPC host requires Node.js on PATH.");
  return node;
}

function getCliPath(): string {
  const override = process.env.PI_SUBAGENT_CLI;
  if (override) return path.resolve(override);
  const cli = path.join(getPackageDir(), "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error("Child RPC host requires an installed Pi CLI (dist/cli.js).");
  return cli;
}

function sessionPathFor(id: string): string {
  const root = process.env.PI_SUBAGENT_SESSION_DIR
    ? path.resolve(process.env.PI_SUBAGENT_SESSION_DIR)
    : path.join(getAgentDir(), "subagents", "sessions");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return path.join(root, `${id}.jsonl`);
}

interface Invocation {
  command: string;
  args: string[];
  sessionFile?: string;
  probe: boolean;
}

/** Read only the session header so a resume cannot silently change workspaces. */
function sessionCwd(sessionFile: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(sessionFile, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.toString("utf8", 0, length).split("\n", 1)[0] ?? "";
    const header = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? header.cwd : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function canonicalDir(directory: string): string {
  try { return fs.realpathSync.native(directory); } catch { return path.resolve(directory); }
}

export function getRpcInvocation(task: ChildTask): Invocation {
  const cli = getCliPath();
  const command = getNodeRuntime();
  const args = [cli, "--mode", "rpc"];
  const useProbe = !process.env.PI_SUBAGENT_CLI || process.env.PI_SUBAGENT_FORCE_PROBE === "1";
  if (useProbe) args.push("--extension", fileURLToPath(new URL("./probe-extension.ts", import.meta.url)));
  let sessionFile: string | undefined;
  if (task.resume !== undefined) {
    sessionFile = path.resolve(task.resume);
    if (!fs.existsSync(sessionFile)) throw new Error(`Child session to resume does not exist: ${sessionFile}`);
    const savedCwd = sessionCwd(sessionFile);
    if (!savedCwd) throw new Error(`Cannot verify the workspace of session ${sessionFile}.`);
    if (canonicalDir(savedCwd) !== canonicalDir(task.cwd)) {
      throw new Error(`Session workspace ${savedCwd} does not match requested cwd ${task.cwd}; resume in its original directory or start a new session.`);
    }
    args.push("--session", sessionFile);
  } else if (task.persist) {
    sessionFile = sessionPathFor(task.id);
    args.push("--session", sessionFile);
  } else {
    args.push("--no-session");
  }
  args.push("--name", task.id);
  if (task.tools.length) args.push("--tools", task.tools.join(","));
  else args.push("--no-tools");
  if (task.excludeTools?.length) args.push("--exclude-tools", task.excludeTools.join(","));
  if (task.model) args.push("--model", task.model);
  if (task.thinking) args.push("--thinking", task.thinking);
  if (task.trustProject) args.push("--approve");
  return { command, args, sessionFile, probe: useProbe };
}

function classify(
  lastAssistant: any,
  output: string | undefined,
  options: {
    terminated: boolean;
    timedOut: boolean;
    aborted: boolean;
    timeoutPhase: "startup" | "execution";
    deadlineMs: number;
    elapsedMs: number;
    processFailure?: string;
    startupFailure?: boolean;
  },
): ChildExecutionOutcome {
  if (options.timedOut) {
    return {
      outcome: "timed_out", exitCode: 1, stopReason: "error", errorKind: "deadline",
      timeoutPhase: options.timeoutPhase,
      errorMessage: timeoutSummary(options.elapsedMs, options.deadlineMs, options.timeoutPhase),
    };
  }
  if (options.aborted) {
    return {
      outcome: "cancelled", exitCode: 1, stopReason: "aborted", errorKind: "cancelled",
      errorMessage: "Subagent cancelled.",
    };
  }
  if (options.processFailure) {
    return {
      outcome: "failed", exitCode: 1, stopReason: "error", errorKind: options.startupFailure ? "startup" : "protocol",
      errorMessage: withCredentialHint(options.processFailure),
    };
  }
  if (!options.terminated) {
    return {
      outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "protocol",
      errorMessage: withCredentialHint("Subagent RPC process exited before agent_settled."),
    };
  }
  const stopReason = lastAssistant?.stopReason as StopReason | undefined;
  const errorMessage = boundedDiagnostic(lastAssistant?.errorMessage);
  if (stopReason === "error") {
    return {
      outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "provider",
      errorMessage: withCredentialHint(errorMessage || "Child provider returned an error."),
    };
  }
  if (stopReason === "length") {
    return {
      outcome: "incomplete", exitCode: 1, stopReason: "length", errorKind: "provider",
      errorMessage: "Child reached the model output limit; response is incomplete.",
    };
  }
  if (stopReason === "aborted") {
    return {
      outcome: "cancelled", exitCode: 1, stopReason: "aborted", errorKind: "cancelled",
      errorMessage: errorMessage || "Child aborted.",
    };
  }
  if (stopReason === "stop" && output) {
    return { outcome: "completed", exitCode: 0, stopReason: "stop" };
  }
  return {
    outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "protocol",
    errorMessage: withCredentialHint(errorMessage
      || "Child produced no terminal assistant output; a final response is required."),
  };
}

/** Remaining command budget, never below one second to avoid a zero timer. */
export function startupRemainingMs(startedAt: number, budgetMs: number, now = Date.now()): number {
  return Math.max(1_000, budgetMs - Math.max(0, now - startedAt));
}

function onceExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (exited: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    // Close the check/listener race: an exit can happen between the initial
    // exitCode check and attaching the listener.
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

/**
 * One Pi CLI process in RPC mode per child. The public JSONL protocol is the
 * only child contract: no SDK bootstrap, no jiti, and no private Pi internals.
 */
export class RpcChildSupervisor implements ChildSupervisor {
  async run({ task, signal, onUpdate, onControl }: ChildRunRequest): Promise<ChildExecutionResult> {
    const startupBudgetMs = task.startupTimeoutMs ?? startupTimeoutMs();
    const data: ChildExecutionData = {
      phase: "starting", startedAt: Date.now(), stderr: "", usage: emptyUsage(),
    };
    const snapshot = (): ChildExecutionData => ({
      ...data,
      usage: { ...data.usage, cost: { ...data.usage.cost } },
      outputTruncation: data.outputTruncation ? { ...data.outputTruncation } : undefined,
    });
    const publish = (progress?: string) => {
      try { onUpdate?.(snapshot(), progress); } catch { /* Presentation is best effort. */ }
    };

    if (signal.aborted) {
      return {
        ...snapshot(), outcome: "cancelled", exitCode: 1, stopReason: "aborted",
        errorKind: "cancelled", errorMessage: "Subagent cancelled before launch.",
      };
    }

    let invocation: Invocation;
    try {
      invocation = getRpcInvocation(task);
    } catch (error) {
      return {
        ...snapshot(), outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "startup",
        errorMessage: boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child launch failed.",
      };
    }
    data.sessionFile = invocation.sessionFile;
    const probeToken = randomUUID();
    publish(RUNNING_PROGRESS_TEXT);

    return await new Promise<ChildExecutionResult>((resolve) => {
      let child: ChildProcess;
      let watchdog: ChildProcess | undefined;
      let settled = false;
      let finishing = false;
      let terminal = false;
      let ready = false;
      let startupExpired = false;
      let timedOut = false;
      let aborted = false;
      let timeoutPhase: "startup" | "execution" = "startup";
      let deadlineMs = startupBudgetMs;
      let executionStartedAt: number | undefined;
      let taskFinishedAt: number | undefined;
      let processFailure: string | undefined;
      let stderr = "";
      let trailing = "";
      let lastAssistant: any;
      let streamingText = "";
      let currentAssistantOpen = false;
      let discarding = false;
      let previewing = true;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      let executionTimer: ReturnType<typeof setTimeout> | undefined;
      let lastPublish = 0;
      let abortHandler: (() => void) | undefined;
      let watchdogSetup: Promise<ChildProcess | undefined> | undefined;
      const decoder = new StringDecoder("utf8");
      const pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      const probe = Promise.withResolvers<ProbeReport>();
      let probeSettled = false;
      const resolveProbe = (report: ProbeReport) => {
        if (probeSettled) return;
        probeSettled = true;
        probe.resolve(report);
      };
      let nextRequest = 0;

      const clearTimers = () => {
        if (startupTimer) clearTimeout(startupTimer);
        if (executionTimer) clearTimeout(executionTimer);
        if (forceTimer) clearTimeout(forceTimer);
        startupTimer = executionTimer = forceTimer = undefined;
      };

      const write = (record: RpcRecord): boolean => {
        if (!child?.stdin?.writable || child.stdin.destroyed) return false;
        try {
          child.stdin.write(`${JSON.stringify(record)}\n`);
          return true;
        } catch {
          return false;
        }
      };

      const send = (record: RpcRecord, timeoutMs = COMMAND_TIMEOUT_MS): Promise<RpcResponse> => {
        const id = record.id ?? `subagent-${++nextRequest}`;
        const command = { ...record, id };
        if (!write(command)) return Promise.reject(new Error("Child RPC stdin is not writable."));
        return new Promise((resolveCommand, rejectCommand) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCommand(new Error(`Timed out waiting for child RPC ${record.type}.`));
          }, timeoutMs);
          timer.unref?.();
          pending.set(id, {
            timer,
            resolve: (response) => { clearTimeout(timer); resolveCommand(response); },
            reject: (error) => { clearTimeout(timer); rejectCommand(error); },
          });
        });
      };

      const rejectPending = (error: Error) => {
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        pending.clear();
      };

      const settle = (result: ChildExecutionResult) => {
        if (settled) return;
        settled = true;
        finishing = true;
        clearTimers();
        if (!probeSettled) {
          probeSettled = true;
          probe.resolve({ token: probeToken, tools: [], requested: [...task.tools], error: "Child execution ended." });
        }
        watchdog?.stdin?.end();
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        rejectPending(new Error("Child execution ended."));
        resolve({
          ...result,
          ...(taskFinishedAt === undefined ? {} : { taskFinishedAt }),
          stderr: truncateHeadTail(stderr, MAX_STDERR_BYTES),
        });
      };

      const resultFor = (wasTerminated: boolean): ChildExecutionResult => {
        const settledText = lastAssistant ? textFromMessage(lastAssistant) : "";
        const currentText = currentAssistantOpen ? streamingText : "";
        const original = currentText || settledText || streamingText;
        const output = truncateOutput(original, MAX_OUTPUT_BYTES);
        const outputTruncation = output !== original ? {
          truncated: true,
          originalBytes: Buffer.byteLength(original, "utf8"),
          retainedBytes: Buffer.byteLength(output, "utf8"),
        } : undefined;
        const outcome = classify(lastAssistant, output, {
          terminated: wasTerminated && terminal,
          timedOut, aborted, timeoutPhase, deadlineMs, startupFailure: !ready,
          elapsedMs: (taskFinishedAt ?? Date.now()) - (timeoutPhase === "execution" && executionStartedAt !== undefined ? executionStartedAt : data.startedAt!),
          processFailure,
        });
        return {
          ...snapshot(),
          ...(output ? { output } : {}),
          ...(outputTruncation ? { outputTruncation } : {}),
          ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
          ...outcome,
        };
      };

      const cleanup = async () => {
        if (finishing) return;
        finishing = true;
        clearTimers();
        if (!child) {
          settle(resultFor(true));
          return;
        }
        const orderly = terminal && !timedOut && !aborted && !processFailure;
        if (orderly) {
          // EOF is Pi's orderly shutdown path. Keep the parent-death watchdog
          // armed until the leader has exited so async session_shutdown hooks
          // are not interrupted by an early SIGTERM.
          try { child.stdin?.end(); } catch { /* already closed */ }
          const exited = await onceExit(child, TERMINAL_EXIT_GRACE_MS);
          if (!exited) {
            terminateProcessTree(child, "SIGTERM");
            if (!(await onceExit(child, KILL_GRACE_MS))) {
              terminateProcessTree(child, "SIGKILL");
              await onceExit(child, 1_000);
            }
          }
        } else {
          // Timeout, cancellation, or a failed child: stop the tree promptly.
          terminateProcessTree(child, "SIGTERM");
          try { child.stdin?.end(); } catch { /* already closed */ }
          if (!(await onceExit(child, KILL_GRACE_MS))) {
            terminateProcessTree(child, "SIGKILL");
            await onceExit(child, 1_000);
          }
        }
        if (!orderly) {
          // The leader can exit after SIGTERM while a descendant that ignored
          // it remains in a different process group. Re-apply SIGKILL to the
          // descendant snapshot captured by terminateProcessTree().
          terminateProcessTree(child, "SIGKILL");
        }
        // A completed leader can leave shell descendants in its detached group.
        // Sweep them before releasing the admission slot; the sweep has its own
        // bounded SIGTERM/SIGKILL escalation. The watchdog remains armed until
        // this point, so a parent crash during cleanup still kills the group.
        await sweepRootProcessGroup(child);
        watchdog?.stdin?.end();
        try {
          settle(resultFor(true));
        } catch {
          settle({ ...snapshot(), outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "protocol",
            errorMessage: "Subagent cleanup could not produce a result." });
        }
      };

      const finish = () => {
        if (finishing) return;
        taskFinishedAt ??= Date.now();
        // Bound cleanup even when a descendant keeps inherited stdio open.
        forceTimer = setTimeout(() => {
          try { terminateProcessTree(child, "SIGKILL"); } catch { /* already gone */ }
          try { settle(resultFor(terminal)); } catch {
            settle({ ...snapshot(), outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "protocol",
              errorMessage: "Subagent cleanup could not produce a result." });
          }
        }, FORCE_SETTLE_MS);
        forceTimer.unref?.();
        void cleanup();
      };

      const fail = (message: string) => {
        if (processFailure || finishing) return;
        processFailure = boundedDiagnostic(message) ?? "Child RPC failed.";
        finish();
      };

      const startExecutionClock = () => {
        if (executionTimer) return;
        if (startupTimer) clearTimeout(startupTimer);
        startupTimer = undefined;
        executionStartedAt = Date.now();
        timeoutPhase = "execution";
        deadlineMs = task.executionTimeoutMs ?? processTimeoutMs();
        executionTimer = setTimeout(() => {
          if (finishing || terminal) return;
          timedOut = true;
          taskFinishedAt ??= Date.now();
          void send({ type: "abort" }).catch(() => {});
          finish();
        }, deadlineMs);
        executionTimer.unref?.();
      };

      const handleEvent = (event: RpcRecord) => {
        if (event.type === "extension_ui_request") {
          // Dialog methods block the child until answered. A headless parent
          // cancels them; fire-and-forget UI notifications are ignored.
          if (["select", "confirm", "input", "editor"].includes(event.method)) {
            write({ type: "extension_ui_response", id: event.id, cancelled: true });
          }
          return;
        }
        if (event.type === "extension_error") {
          // Pi reports handler failures as non-fatal extension errors and can
          // continue the run. Keep the diagnostic, but do not abort a task
          // merely because an unrelated extension hook threw.
          const detail = `Child extension error (${event.event ?? "unknown"}): ${event.error ?? "unknown"}`;
          stderr += `${stderr ? "\n" : ""}${detail}`;
          if (stderr.length > MAX_STDERR_BYTES * 2) stderr = stderr.slice(-MAX_STDERR_BYTES * 2);
          return;
        }
        if (event.type === "message_start" && event.message?.role === "assistant") {
          streamingText = "";
          currentAssistantOpen = true;
          return;
        }
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          currentAssistantOpen = true;
          streamingText = truncateOutput(streamingText + (event.assistantMessageEvent.delta ?? ""), MAX_OUTPUT_BYTES * 2);
          const now = Date.now();
          if (now - lastPublish >= 500) {
            lastPublish = now;
            data.output = truncateOutput(streamingText, MAX_OUTPUT_BYTES);
            publish();
          }
          return;
        }
        if (event.type === "entry_appended" && event.entry?.type === "custom" && event.entry.customType === PROBE_CUSTOM_TYPE) {
          const parsed = event.entry.data;
          if (parsed && typeof parsed === "object" && parsed.token === probeToken
            && Array.isArray(parsed.tools) && Array.isArray(parsed.requested)) {
            resolveProbe(parsed as ProbeReport);
          } else {
            resolveProbe({ token: probeToken, tools: [], requested: [...task.tools], error: "Child probe returned malformed readiness." });
          }
          return;
        }
        if (event.type === "message_end") {
          const message = event.message;
          if (message?.role === "assistant") {
            currentAssistantOpen = false;
            lastAssistant = message;
            streamingText = textFromMessage(message);
            data.output = truncateOutput(streamingText, MAX_OUTPUT_BYTES);
            data.usage.turns++;
            if (message.usage) addUsage(data.usage, message.usage as Usage);
            data.errorMessage = boundedDiagnostic(message.errorMessage);
            publish();
          } else if (message?.role === "toolResult" && message.usage) {
            addUsage(data.usage, message.usage as Usage);
          }
          return;
        }
        if (event.type === "compaction_end" && event.result?.usage) {
          addUsage(data.usage, event.result.usage as Usage);
          return;
        }
        if (event.type === "tool_execution_start") {
          publish(`Running ${truncateOutput(String(event.toolName ?? "tool"), 256)}...`);
          return;
        }
        if (event.type === "agent_settled") {
          terminal = true;
          taskFinishedAt ??= Date.now();
          if (event.aborted) aborted = true;
          finish();
        }
      };

      const handleLine = (line: string) => {
        let record: RpcRecord;
        try { record = JSON.parse(line); } catch {
          processFailure = "Child RPC emitted malformed JSON.";
          finish();
          return;
        }
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          processFailure = "Child RPC emitted a non-object record.";
          finish();
          return;
        }
        if (record.type === "response") {
          const response = record as RpcResponse;
          if (response.id && pending.has(response.id)) {
            const request = pending.get(response.id)!;
            pending.delete(response.id);
            request.resolve(response);
          }
          return;
        }
        try { handleEvent(record); } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      };

      const consume = (text: string) => {
        let cursor = 0;
        while (cursor < text.length && !finishing) {
          const newline = text.indexOf("\n", cursor);
          const end = newline < 0 ? text.length : newline;
          const segment = text.slice(cursor, end);
          cursor = newline < 0 ? text.length : newline + 1;
          if (discarding) {
            if (newline >= 0) { discarding = false; previewing = true; }
            continue;
          }
          trailing += segment;
          if (previewing) {
            if (trailing.length >= AGENT_END_PREFIX.length) {
              if (trailing.startsWith(AGENT_END_PREFIX)) {
                // agent_end repeats the whole run history and is not used by
                // the host. Discard it without imposing the per-record cap.
                if (newline < 0) {
                  discarding = true;
                  trailing = "";
                  return;
                }
                trailing = "";
                previewing = true;
                continue;
              }
              previewing = false;
            } else if (newline < 0) {
              return;
            }
          }
          if (newline < 0) {
            if (Buffer.byteLength(trailing) > MAX_PROTOCOL_LINE_BYTES) {
              fail("Child RPC emitted an oversized protocol record.");
              trailing = "";
            }
            return;
          }
          if (Buffer.byteLength(trailing) > MAX_PROTOCOL_LINE_BYTES) {
            fail("Child RPC emitted an oversized protocol record.");
            trailing = "";
            return;
          }
          handleLine(trailing);
          trailing = "";
          previewing = true;
        }
      };

      abortHandler = () => {
        if (finishing || timedOut) return;
        aborted = true;
        taskFinishedAt ??= Date.now();
        void send({ type: "abort" }).catch(() => {});
        finish();
      };
      signal.addEventListener("abort", abortHandler, { once: true });

      try {
        const childEnv = childEnvironment(task.id, task.cwd);
        if (invocation.probe) {
          childEnv[PROBE_TOKEN_ENV] = probeToken;
          childEnv[PROBE_TOOLS_ENV] = JSON.stringify(task.tools);
          childEnv[PROBE_TIMEOUT_ENV] = String(Math.max(1_000, Math.min(10_000, Math.floor(startupRemainingMs(data.startedAt ?? Date.now(), startupBudgetMs) * 0.6))));
        }
        child = spawn(invocation.command, invocation.args, {
          cwd: task.cwd,
          env: childEnv,
          shell: false,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        settle({
          ...snapshot(), outcome: "failed", exitCode: 1, stopReason: "error", errorKind: "startup",
          errorMessage: boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child RPC spawn failed.",
        });
        return;
      }

      startupTimer = setTimeout(() => {
        if (finishing || ready) return;
        startupExpired = true;
        timedOut = true;
        taskFinishedAt ??= Date.now();
        finish();
      }, Math.max(1, deadlineMs - (Date.now() - (data.startedAt ?? Date.now()))));
      startupTimer.unref?.();

      child.once("exit", (code, exitSignal) => {
        if (finishing) {
          taskFinishedAt ??= Date.now();
          return;
        }
        taskFinishedAt ??= Date.now();
        if (!terminal) {
          processFailure = `Child RPC exited before completion (code=${code ?? "null"} signal=${exitSignal ?? "null"}).`;
          finish();
        }
      });
      child.once("error", (error) => fail(`Child RPC process error: ${error.message}`));
      child.stdin?.on("error", () => {});
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > MAX_STDERR_BYTES * 2) stderr = stderr.slice(-MAX_STDERR_BYTES * 2);
      });
      (child.stdout as NodeJS.ReadableStream).on("data", (chunk: Buffer | string) => {
        if (!finishing) consume(decoder.write(chunk));
      });

      watchdogSetup = spawnDeathWatchdog(child, invocation.command).then((process) => {
        watchdog = process;
        watchdog?.once("exit", () => {
          if (!finishing && !terminal) fail("Child RPC watchdog exited unexpectedly.");
        });
        if (finishing || terminal) watchdog?.stdin?.end();
        return process;
      }).catch((error) => {
        fail(`Child RPC watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });

      void (async () => {
        await watchdogSetup;
        if (finishing || signal.aborted) return;
        try {
          const stateResponse = await send({ type: "get_state" }, startupRemainingMs(data.startedAt ?? Date.now(), startupBudgetMs));
          if (!stateResponse.success) throw new Error(stateResponse.error || "Child get_state failed.");
          const state = stateResponse.data ?? {};
          if (!state.model) throw new Error("Child has no selected model.");
          const effectiveModel = `${state.model.provider}/${state.model.id}`;
          if (task.model && effectiveModel !== task.model) {
            throw new Error(`Child model ${effectiveModel} does not match requested ${task.model}.`);
          }
          if (task.strictThinking && state.thinkingLevel !== task.thinking) {
            throw new Error(`Child thinking ${state.thinkingLevel} does not match requested ${task.thinking}.`);
          }
          if (invocation.probe) {
            const remaining = startupRemainingMs(data.startedAt ?? Date.now(), startupBudgetMs);
            const probeTimer = setTimeout(() => resolveProbe({
              token: probeToken, tools: [], requested: [...task.tools], error: "Child probe timed out.",
            }), remaining);
            probeTimer.unref?.();
            try {
              // Preflight the command before sending it. An unknown slash prompt
              // starts a model turn in RPC; a failed probe extension must not do
              // that as a side effect.
              const commandsResponse = await send({ type: "get_commands" }, remaining);
              const commands = commandsResponse.success ? commandsResponse.data?.commands : undefined;
              if (!Array.isArray(commands) || !commands.some((command) => command?.name === PROBE_COMMAND && command?.source === "extension")) {
                throw new Error("Child probe extension is unavailable.");
              }
              const probeResponse = await send({ type: "prompt", message: `/${PROBE_COMMAND}` }, remaining);
              if (!probeResponse.success) throw new Error(probeResponse.error || "Child probe command failed.");
              if (probeResponse.data?.disposition !== "handled") throw new Error("Child probe command was not handled.");
              const report = await probe.promise;
              if (report.error) throw new Error(report.error);
              const active = report.tools;
              const missing = task.tools.filter((tool) => !active.includes(tool));
              if (missing.length) throw new Error(`Requested child tools are unavailable: ${missing.join(", ")}`);
              if (active.length !== task.tools.length) throw new Error("Child tool selection did not match request.");
            } finally {
              clearTimeout(probeTimer);
            }
          }
          data.model = effectiveModel;
          data.thinking = state.thinkingLevel;
          ready = true;
          data.phase = "running";
          publish();
          // Execution starts when the task is submitted, not after spawn or
          // after an arbitrary first model response.
          startExecutionClock();

          const promptResponse = await send({ type: "prompt", message: TASK_ENVELOPE + task.prompt });
          if (!promptResponse.success) throw new Error(promptResponse.error || "Child rejected the prompt.");
          const disposition = promptResponse.data?.disposition;
          if (disposition === "handled") throw new Error("Child handled the prompt without starting a task.");
          onControl?.({
            async steer(message: string) {
              if (finishing || terminal) throw new Error("Child is no longer running.");
              const response = await send({ type: "steer", message: STEER_ENVELOPE + message });
              if (!response.success) throw new Error(response.error || "Child rejected steering.");
              if (response.data?.disposition === "handled") throw new Error("Child handled steering without queuing it.");
            },
          });
        } catch (error) {
          // A command timeout before readiness is the startup deadline, not
          // a protocol failure. The startup timer and this race are independent.
          if (!ready && !aborted && !timedOut && (startupExpired || /Timed out waiting for child RPC get_state/.test(error instanceof Error ? error.message : String(error)))) {
            timedOut = true;
            taskFinishedAt ??= Date.now();
          } else if (!aborted && !timedOut) {
            fail(error instanceof Error ? error.message : String(error));
          }
          finish();
        }
      })();
    });
  }
}
