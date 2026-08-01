import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Message, Model, StopReason, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { findEnvKeys, getProviders } from "@earendil-works/pi-ai/compat";
import {
  CONFIG_DIR_NAME,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
  findNearestProjectRoot,
} from "./agents.ts";

export type { AgentCapability, AgentConfig, AgentDiscoveryResult, AgentScope } from "./agents.ts";
export { discoverAgents, findNearestProjectAgentsDir, findNearestProjectRoot, getBundledAgentsDir, loadAgentsFromDir } from "./agents.ts";

export const MAX_DEPTH = 3;
const MAX_PARALLEL_TASKS = 8;
/** Maximum live pi subprocesses across an entire recursive delegation tree. */
export const MAX_CONCURRENCY = 4;
/** Total child processes a root delegation may ever create. */
export const MAX_DESCENDANTS = 32;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_MESSAGES_PER_AGENT = 128;
const MAX_STDERR_BYTES = 50 * 1024;
/** Maximum protocol line retained or parsed from the child stream. */
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_TASK_BYTES = 100 * 1024;
const MAX_CHAIN_STEPS = 32;
const MAX_CHAIN_CONTEXT_BYTES = 50 * 1024;
const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
const PARENT_ID_ENV = "PI_SUBAGENT_PARENT_ID";
const ROOT_ID_ENV = "PI_SUBAGENT_ROOT_ID";
const CONTROL_ENV = "PI_SUBAGENT_CONTROL_FILE";
const DEADLINE_ENV = "PI_SUBAGENT_DEADLINE_MS";
const BUDGET_ENV = "PI_SUBAGENT_BUDGET_REMAINING";
const TIMEOUT_ENV = "PI_SUBAGENT_TIMEOUT_MS";
const PASSTHROUGH_ENV = "PI_SUBAGENT_PASSTHROUGH_ENV";
const SUBAGENT_BIN_ENV = "PI_SUBAGENT_BIN";
const PI_BIN_ENV = "PI_BIN";
const CONTROL_VERSION = 2;

// Keep the child useful for configured providers without copying arbitrary
// shell/session state (SSH sockets, cloud metadata, and unrelated secrets).
const SAFE_ENV_KEYS = new Set([
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
  "PWD", "OLDPWD", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM",
  "NO_COLOR", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "BUN_INSTALL",
  "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR",
  TIMEOUT_ENV, PASSTHROUGH_ENV, SUBAGENT_BIN_ENV, PI_BIN_ENV,
  "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENROUTER_BASE_URL",
  "AZURE_OPENAI_ENDPOINT", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_PROFILE",
  "AWS_REGION", "AWS_DEFAULT_REGION",
]);

// These are ambient model configuration values used by providers that do not
// expose their credentials through findEnvKeys(). They are not application
// secrets and are safe to pass alongside the standard provider API keys.
const AMBIENT_MODEL_ENV_KEYS = new Set([
  "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GCLOUD_PROJECT",
]);

const activeChildren = new Set<ChildProcess>();

interface ControlState {
  version: number;
  rootRunId: string;
  remaining: number;
  active: number;
  /** Reservation owners make slot release idempotent and prevent stale releases. */
  activeRunIds: string[];
  maxConcurrent: number;
  deadlineMs: number;
}

interface ControlContext {
  statePath: string;
  rootRunId: string;
  deadlineMs: number;
  ownerDirectory?: string;
}

interface ChildReservation {
  budgetRemaining: number;
}

export type AgentTermination = "completed" | "failed" | "cancelled" | "timed_out";

interface ExecutionContext {
  runId: string;
  parentRunId?: string;
  /** Reservation held by this nested process in its parent's control state. */
  reservationRunId?: string;
  rootRunId: string;
  depth: number;
  deadlineMs: number;
  control: ControlContext;
}

export interface UsageSummary extends Usage {
  turns: number;
}

export interface AgentResult {
  agent: string;
  agentSource: AgentConfig["source"] | "unknown";
  task: string;
  /** Final assistant text, kept separately from bounded diagnostic messages. */
  output?: string;
  runId: string;
  parentRunId?: string;
  rootRunId: string;
  depth: number;
  step?: number;
  exitCode: number;
  stopReason?: StopReason;
  /** Distinguishes ordinary failure, cancellation, and timeout across the API boundary. */
  termination?: AgentTermination;
  errorMessage?: string;
  stderr: string;
  messages: Message[];
  usage: UsageSummary;
  model?: string;
}

export interface SubagentDetails {
  /** Identifies a successful metadata-only action with no user-facing body. */
  action?: "list";
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  runId: string;
  parentRunId?: string;
  rootRunId: string;
  depth: number;
  deadlineMs: number;
  results: AgentResult[];
}

export type SubagentParams = Static<typeof SubagentParamsSchema>;

function emptyUsage(): UsageSummary {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 0,
  };
}

function addUsage(target: UsageSummary, usage: Usage): void {
  target.input += usage.input || 0;
  target.output += usage.output || 0;
  target.cacheRead += usage.cacheRead || 0;
  target.cacheWrite += usage.cacheWrite || 0;
  target.totalTokens += usage.totalTokens || 0;
  target.cost.input += usage.cost?.input || 0;
  target.cost.output += usage.cost?.output || 0;
  target.cost.cacheRead += usage.cost?.cacheRead || 0;
  target.cost.cacheWrite += usage.cost?.cacheWrite || 0;
  target.cost.total += usage.cost?.total || 0;
  if (usage.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h || 0) + usage.cacheWrite1h;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  const numericKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  if (!numericKeys.every((key) => isFiniteNumber(usage[key]))) return false;
  const cost = usage.cost;
  if (!cost || typeof cost !== "object") return false;
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => isFiniteNumber((cost as Record<string, unknown>)[key]))
    && (usage.cacheWrite1h === undefined || isFiniteNumber(usage.cacheWrite1h));
}

function isContentPart(value: unknown): value is { type: string; text?: unknown } {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  if (part.type === "text") return typeof part.text === "string";
  if (part.type === "thinking") return typeof part.thinking === "string";
  if (part.type === "image") return typeof part.data === "string" && typeof part.mimeType === "string";
  if (part.type === "toolCall") return typeof part.id === "string" && typeof part.name === "string" && !!part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments);
  return false;
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.role === "toolResult") {
    const content = candidate.content;
    const validContent = Array.isArray(content) && content.every((part) => {
      if (!part || typeof part !== "object") return false;
      const item = part as Record<string, unknown>;
      return (item.type === "text" && typeof item.text === "string")
        || (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string");
    });
    return validContent
      && typeof candidate.toolCallId === "string"
      && typeof candidate.toolName === "string"
      && typeof candidate.isError === "boolean";
  }
  const validContent = typeof candidate.content === "string"
    || (Array.isArray(candidate.content) && candidate.content.every(isContentPart));
  if (!validContent || (candidate.role !== "user" && candidate.role !== "assistant")) return false;
  return candidate.role !== "assistant" || candidate.usage === undefined || isUsage(candidate.usage);
}

function isStopReason(value: unknown): value is StopReason {
  return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

function isFinalMessage(value: unknown): value is Message {
  if (!isMessage(value)) return false;
  if (value.role !== "assistant") return true;
  return typeof value.model === "string" && isStopReason(value.stopReason) && isUsage(value.usage);
}

function textFromMessage(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => isContentPart(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function getFinalOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") {
      const text = textFromMessage(message);
      if (text) return text;
    }
  }
  return "";
}

/** Return a UTF-8 prefix without splitting a code point. */
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // A UTF-16 binary-search boundary can land between a surrogate pair even
  // though Buffer.byteLength reports a valid replacement sequence.
  if (low > 0 && low < value.length) {
    const last = value.charCodeAt(low - 1);
    if (last >= 0xd800 && last <= 0xdbff) low--;
  }
  return value.slice(0, low);
}

/**
 * Truncate output by bytes with a stable, bounded marker. This is deliberately
 * head truncation: the beginning of a subagent report contains its useful context.
 */
export function truncateOutput(value: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= maxBytes) return value;
  if (maxBytes <= 0) return "";

  const markerFor = (keptBytes: number) =>
    `\n\n[Output truncated: kept ${keptBytes} of ${totalBytes} bytes.]`;
  const minimalMarker = "[Output truncated]";
  if (Buffer.byteLength(minimalMarker, "utf8") > maxBytes) return utf8Prefix(value, maxBytes);

  let keptBytes = Math.min(totalBytes, maxBytes);
  for (let attempt = 0; attempt < 8; attempt++) {
    const marker = markerFor(keptBytes);
    const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
    const prefix = utf8Prefix(value, budget);
    const nextKept = Buffer.byteLength(prefix, "utf8");
    const finalMarker = markerFor(nextKept);
    if (nextKept === keptBytes && Buffer.byteLength(finalMarker, "utf8") <= maxBytes) return prefix + finalMarker;
    keptBytes = nextKept;
  }
  const marker = markerFor(0);
  if (Buffer.byteLength(marker, "utf8") <= maxBytes) {
    return utf8Prefix(value, maxBytes - Buffer.byteLength(marker, "utf8")) + marker;
  }
  if (Buffer.byteLength(minimalMarker, "utf8") <= maxBytes) return minimalMarker;
  return utf8Prefix(value, maxBytes);
}

/** Replace chain placeholders without materializing an unbounded expansion. */
export function interpolatePrevious(task: string, previous: string, maxBytes = MAX_TASK_BYTES): string {
  const marker = "{previous}";
  const chunks: string[] = [];
  let bytes = 0;
  let cursor = 0;
  while (cursor <= task.length && bytes < maxBytes) {
    const markerIndex = task.indexOf(marker, cursor);
    const literalEnd = markerIndex < 0 ? task.length : markerIndex;
    const literal = task.slice(cursor, literalEnd);
    const literalPrefix = utf8Prefix(literal, maxBytes - bytes);
    chunks.push(literalPrefix);
    bytes += Buffer.byteLength(literalPrefix, "utf8");
    if (literalPrefix.length < literal.length || markerIndex < 0 || bytes >= maxBytes) break;

    const previousPrefix = utf8Prefix(previous, maxBytes - bytes);
    chunks.push(previousPrefix);
    bytes += Buffer.byteLength(previousPrefix, "utf8");
    if (previousPrefix.length < previous.length || bytes >= maxBytes) break;
    cursor = markerIndex + marker.length;
  }
  return chunks.join("");
}

function capStderr(current: string, next: string): string {
  const remaining = MAX_STDERR_BYTES - Buffer.byteLength(current, "utf8");
  return remaining > 0 ? current + utf8Prefix(next, remaining) : current;
}

function boundedDiagnostic(value: string | undefined, maxBytes = MAX_DIAGNOSTIC_BYTES): string | undefined {
  return value === undefined ? undefined : truncateOutput(value, maxBytes);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Keep typed pi messages while bounding the data copied into tool details. */
function boundMessage(message: Message, maxBytes = MAX_MESSAGE_BYTES): Message {
  if (jsonBytes(message) <= maxBytes) return message;
  const copy = JSON.parse(JSON.stringify(message)) as Record<string, any>;
  if (typeof copy.content === "string") {
    copy.content = truncateOutput(copy.content, Math.max(0, maxBytes - 512));
  } else if (Array.isArray(copy.content)) {
    copy.content = copy.content.map((part: Record<string, any>) => {
      if (part.type === "text") return { ...part, text: truncateOutput(typeof part.text === "string" ? part.text : "", Math.max(0, maxBytes - 512)) };
      if (part.type === "thinking") return { ...part, thinking: truncateOutput(typeof part.thinking === "string" ? part.thinking : "", Math.max(0, maxBytes - 512)) };
      if (part.type === "image") return { ...part, data: truncateOutput(typeof part.data === "string" ? part.data : "", Math.max(0, maxBytes - 512)) };
      if (part.type === "toolCall") return { ...part, arguments: {} };
      return part;
    });
  }
  if (typeof copy.errorMessage === "string") copy.errorMessage = boundedDiagnostic(copy.errorMessage, 1024);
  if (jsonBytes(copy) <= maxBytes) return copy as Message;
  // Preserve a valid, small message shape when metadata (for example a large
  // provider field) is itself unexpectedly large.
  if (copy.role === "toolResult") {
    return { ...copy, content: [{ type: "text", text: "[tool result truncated]" }], toolCallId: String(copy.toolCallId ?? ""), toolName: String(copy.toolName ?? "tool"), isError: Boolean(copy.isError) } as Message;
  }
  return { ...copy, content: truncateOutput(textFromMessage(copy as Message), Math.max(0, maxBytes - 512)) } as Message;
}

function boundMessages(messages: Message[], maxBytes = MAX_OUTPUT_BYTES): Message[] {
  const bounded = messages.slice(-MAX_MESSAGES_PER_AGENT).map((message) => boundMessage(message));
  while (bounded.length > 0 && jsonBytes(bounded) > maxBytes) bounded.shift();
  if (bounded.length === 1 && jsonBytes(bounded) > maxBytes) return [boundMessage(bounded[0]!, Math.max(512, maxBytes - 32))];
  return bounded;
}

function minimalAgentResult(result: AgentResult): AgentResult {
  return {
    agent: truncateOutput(result.agent, 256),
    agentSource: result.agentSource,
    task: "",
    runId: result.runId,
    parentRunId: result.parentRunId,
    rootRunId: result.rootRunId,
    depth: result.depth,
    step: result.step,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    termination: result.termination,
    errorMessage: boundedDiagnostic(result.errorMessage, 512),
    stderr: "",
    messages: [],
    usage: result.usage,
    model: boundedDiagnostic(result.model, 256),
  };
}

function boundAgentResult(result: AgentResult, maxBytes: number): AgentResult {
  let bounded = minimalAgentResult(result);
  if (jsonBytes(bounded) >= maxBytes) return bounded;
  const candidates: Array<[keyof AgentResult, unknown]> = [
    ["output", result.output ? truncateOutput(result.output, Math.min(MAX_OUTPUT_BYTES, maxBytes)) : undefined],
    ["task", truncateOutput(result.task, Math.min(MAX_DIAGNOSTIC_BYTES, maxBytes))],
    ["stderr", truncateOutput(result.stderr, Math.min(MAX_DIAGNOSTIC_BYTES, maxBytes))],
    ["messages", boundMessages(result.messages, Math.min(MAX_MESSAGE_BYTES * 2, maxBytes))],
  ];
  for (const [key, value] of candidates) {
    const next = { ...bounded, [key]: value } as AgentResult;
    if (jsonBytes(next) <= maxBytes) bounded = next;
  }
  return bounded;
}

function boundDetails(details: SubagentDetails, maxBytes = MAX_OUTPUT_BYTES): SubagentDetails {
  const minimalResults = details.results.map(minimalAgentResult);
  const bounded: SubagentDetails = { ...details, results: minimalResults };
  const baseBytes = jsonBytes(bounded);
  if (baseBytes >= maxBytes || minimalResults.length === 0) return bounded;
  const perResult = Math.max(1, Math.floor((maxBytes - baseBytes) / minimalResults.length));
  bounded.results = details.results.map((result) => boundAgentResult(result, jsonBytes(minimalAgentResult(result)) + perResult));
  // The allocation above is deterministic. A final minimal fallback keeps
  // the aggregate bounded even if JSON overhead differs across runtimes.
  while (jsonBytes(bounded) > maxBytes && bounded.results.some((result, index) => jsonBytes(result) > jsonBytes(minimalResults[index]!))) {
    const index = bounded.results.findIndex((result, itemIndex) => jsonBytes(result) > jsonBytes(minimalResults[itemIndex]!));
    if (index < 0) break;
    bounded.results[index] = minimalResults[index]!;
  }
  return bounded;
}

function modelName(model: Model<any> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function resolveModel(agent: AgentConfig, override: string | undefined, parentModel: Model<any> | undefined): string | undefined {
  return override ?? agent.model ?? modelName(parentModel);
}

function effectiveTools(agent: AgentConfig): string[] {
  // An omitted allowlist is intentionally empty. In particular, it must not
  // fall through to pi's default all-tools behavior.
  const tools = [...(agent.tools ?? [])].filter((tool) => tool !== "subagent");
  if (agent.delegation) tools.push("subagent");
  return [...new Set(tools)];
}

function potentiallyMutating(agent: AgentConfig | undefined): boolean {
  // Missing metadata is conservative: a task may mutate the worktree.
  return agent?.capability !== "read";
}

export interface PiInvocation {
  command: string;
  args: string[];
}

function executable(pathname: string): boolean {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    if (executable(candidate)) return fs.realpathSync.native(candidate);
  }
  return undefined;
}

/**
 * Invoke the same pi CLI as the parent process. All returned commands are
 * absolute, avoiding cwd/PATH changes inside a delegated task.
 */
export function getPiInvocation(args: string[]): PiInvocation {
  const configured = process.env.PI_SUBAGENT_BIN ?? process.env.PI_BIN;
  if (configured) {
    const absolute = path.resolve(configured);
    if (executable(absolute)) return { command: fs.realpathSync.native(absolute), args };
  }

  const runtime = path.basename(process.execPath).toLowerCase();
  const genericRuntime = /^(node|bun|deno)(\.exe)?$/.test(runtime);
  const currentScript = process.argv[1] ? path.resolve(process.argv[1]) : undefined;

  if (!genericRuntime && executable(process.execPath)) {
    return { command: fs.realpathSync.native(process.execPath), args };
  }
  if (currentScript && fs.existsSync(currentScript) && /\.(?:mjs|cjs|js|ts)$/.test(currentScript)) {
    return { command: fs.realpathSync.native(process.execPath), args: [currentScript, ...args] };
  }

  const piPath = findOnPath("pi");
  if (piPath) return { command: piPath, args };
  throw new Error("Unable to resolve an absolute pi executable for subagent delegation.");
}

function configuredTimeoutMs(): number {
  const configured = Number(process.env[TIMEOUT_ENV]);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= MAX_PROCESS_TIMEOUT_MS
    ? configured
    : DEFAULT_PROCESS_TIMEOUT_MS;
}

function processTimeoutMs(deadlineMs?: number): number {
  const configured = configuredTimeoutMs();
  if (deadlineMs === undefined) return configured;
  return Math.max(1, Math.min(configured, deadlineMs - Date.now()));
}

function isControlId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isControlState(value: unknown): value is ControlState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return state.version === CONTROL_VERSION
    && isControlId(state.rootRunId)
    && Number.isSafeInteger(state.remaining) && (state.remaining as number) >= 0 && (state.remaining as number) <= MAX_DESCENDANTS
    && Number.isSafeInteger(state.active) && (state.active as number) >= 0
    && Array.isArray(state.activeRunIds)
    && state.activeRunIds.length === state.active
    && state.activeRunIds.every(isControlId)
    && new Set(state.activeRunIds).size === state.activeRunIds.length
    && Number.isSafeInteger(state.maxConcurrent) && (state.maxConcurrent as number) > 0 && (state.maxConcurrent as number) <= MAX_CONCURRENCY
    && (state.active as number) <= (state.maxConcurrent as number)
    && Number.isSafeInteger(state.deadlineMs) && (state.deadlineMs as number) > 0;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Subagent aborted.");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Subagent aborted."));
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function acquireControlLock(control: ControlContext, signal?: AbortSignal): Promise<string> {
  const lockPath = `${control.statePath}.lock`;
  const started = Date.now();
  while (true) {
    if (signal?.aborted) throw new Error("Subagent aborted.");
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      return lockPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 5_000) await fs.promises.rm(lockPath, { recursive: true, force: true });
      } catch {
        // The owner may have released the lock between stat and cleanup.
      }
      if (Date.now() - started > 10_000) throw new Error("Timed out acquiring subagent control state lock.");
      await delay(25, signal);
    }
  }
}

async function writeControlState(controlPath: string, state: ControlState): Promise<void> {
  // Readers intentionally do not take the writer lock: nested child startup can
  // happen concurrently with a sibling reservation. Publish a complete state
  // with rename so readers see either the old or the new JSON, never a truncate.
  const temporaryPath = `${controlPath}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporaryPath, controlPath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function withControlState<T>(control: ControlContext, update: (state: ControlState) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
  const lockPath = await acquireControlLock(control, signal);
  try {
    const raw = await fs.promises.readFile(control.statePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Subagent control state is not valid JSON.");
    }
    if (!isControlState(parsed) || parsed.rootRunId !== control.rootRunId) {
      throw new Error("Subagent control state is malformed or belongs to another root run.");
    }
    const result = await update(parsed);
    await writeControlState(control.statePath, parsed);
    return result;
  } finally {
    await fs.promises.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function createControlState(rootRunId: string): Promise<ControlContext> {
  const ownerDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagents-control-"));
  const statePath = path.join(ownerDirectory, "state.json");
  const deadlineMs = Date.now() + configuredTimeoutMs();
  const state: ControlState = {
    version: CONTROL_VERSION,
    rootRunId,
    remaining: MAX_DESCENDANTS,
    active: 0,
    activeRunIds: [],
    maxConcurrent: MAX_CONCURRENCY,
    deadlineMs,
  };
  await fs.promises.writeFile(statePath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  return { statePath, rootRunId, deadlineMs, ownerDirectory };
}

async function inheritedControlState(depth: DepthStatus, rootRunId: string): Promise<ControlContext | undefined> {
  const controlPath = process.env[CONTROL_ENV];
  const related = [process.env[RUN_ID_ENV], process.env[ROOT_ID_ENV], process.env[PARENT_ID_ENV], process.env[BUDGET_ENV], process.env[DEADLINE_ENV]];
  if (!controlPath) {
    if (depth.depth > 0 || related.some((value) => value !== undefined)) {
      throw new Error("Nested subagent controls are incomplete; refusing to spawn.");
    }
    return undefined;
  }
  if (!path.isAbsolute(controlPath) || !isControlId(process.env[ROOT_ID_ENV]) || !isControlId(process.env[RUN_ID_ENV]) || depth.depth === 0 && process.env[PARENT_ID_ENV] !== undefined && !isControlId(process.env[PARENT_ID_ENV])) {
    throw new Error("Nested subagent control environment is malformed.");
  }
  if (depth.depth > 0 && !isControlId(process.env[PARENT_ID_ENV])) {
    throw new Error("Nested subagent parent id is missing.");
  }
  if (process.env[BUDGET_ENV] !== undefined && !/^(?:0|[1-9]\d*)$/.test(process.env[BUDGET_ENV])) {
    throw new Error("Nested subagent budget is malformed.");
  }
  const stat = await fs.promises.lstat(controlPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Nested subagent control state must be a private regular file.");
  }
  const raw = await fs.promises.readFile(controlPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Nested subagent control state is not valid JSON.");
  }
  if (!isControlState(parsed) || parsed.rootRunId !== process.env[ROOT_ID_ENV]) {
    throw new Error("Nested subagent control state is malformed.");
  }
  if (process.env[DEADLINE_ENV] !== undefined && process.env[DEADLINE_ENV] !== String(parsed.deadlineMs)) {
    throw new Error("Nested subagent deadline does not match its control state.");
  }
  if (parsed.rootRunId !== rootRunId && rootRunId !== "") {
    throw new Error("Nested subagent root id is inconsistent.");
  }
  return { statePath: controlPath, rootRunId: parsed.rootRunId, deadlineMs: parsed.deadlineMs };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function passthroughPatternToRegExp(pattern: string): RegExp | undefined {
  // Allow exact names and glob patterns containing * and ?. Example: *_API_KEY, OPENAI_*, *TOKEN*
  if (!pattern) return undefined;
  if (!/^[A-Za-z0-9_*?]+$/.test(pattern) && pattern !== "*") return undefined;
  // Exact name fast path
  if (!pattern.includes("*") && !pattern.includes("?")) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern)) return undefined;
    return new RegExp(`^${escapeRegExp(pattern)}$`);
  }
  const escaped = pattern.split("").map((ch) => {
    if (ch === "*") return ".*";
    if (ch === "?") return ".";
    return escapeRegExp(ch);
  }).join("");
  try {
    return new RegExp(`^${escaped}$`);
  } catch {
    return undefined;
  }
}

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Match pi's JSONC support while preserving string literals. */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

function collectConfigEnvRefs(value: unknown, refs: Set<string>): void {
  if (typeof value === "string") {
    let index = 0;
    while (index < value.length) {
      const dollarIndex = value.indexOf("$", index);
      if (dollarIndex < 0) return;
      const next = value[dollarIndex + 1];
      if (next === "$" || next === "!") {
        index = dollarIndex + 2;
        continue;
      }
      if (next === "{") {
        const end = value.indexOf("}", dollarIndex + 2);
        if (end < 0) {
          index = dollarIndex + 1;
          continue;
        }
        const name = value.slice(dollarIndex + 2, end);
        if (ENV_VAR_NAME.test(name)) refs.add(name);
        index = end + 1;
        continue;
      }
      const match = value.slice(dollarIndex + 1).match(ENV_VAR_PREFIX);
      if (match) {
        refs.add(match[0]);
        index = dollarIndex + 1 + match[0].length;
      } else {
        index = dollarIndex + 1;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConfigEnvRefs(item, refs);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectConfigEnvRefs(item, refs);
  }
}

function collectModelEnvRefs(): Set<string> {
  const refs = new Set<string>();
  try {
    const agentDir = getAgentDir();
    const modelsPath = path.join(agentDir, "models.json");
    const raw = fs.readFileSync(modelsPath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    collectConfigEnvRefs(parsed, refs);
  } catch {
    // Best-effort; absence of models.json is not fatal
  }
  return refs;
}

function modelCredentialEnvKeys(): Set<string> {
  const keys = new Set(AMBIENT_MODEL_ENV_KEYS);
  const available = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  try {
    for (const provider of getProviders()) {
      for (const key of findEnvKeys(provider, available) ?? []) keys.add(key);
    }
  } catch {
    // A provider catalog failure must not prevent subagent execution.
  }
  return keys;
}

function childEnvironment(
  depth: number,
  control: ControlContext,
  parentRunId: string,
  childRunId: string,
  budgetRemaining: number,
  cwd: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Auto-include env vars referenced in ~/.pi/agent/models.json. This covers
  // provider keys, custom headers, and nested children using another configured
  // model without exposing unrelated environment variables.
  for (const ref of collectModelEnvRefs()) {
    const value = process.env[ref];
    if (value !== undefined) env[ref] = value;
  }
  // Inherit credential-shaped variables for configured model and tool
  // providers. Trusted subagents already run as the same user and need the
  // parent's Exa, Context7, GitHub, and similar credentials to be useful.
  for (const key of modelCredentialEnvKeys()) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key.endsWith("_API_KEY") || key.endsWith("_TOKEN"))) env[key] = value;
  }
  // Allow the user to explicitly opt in to additional non-credential
  // variables without making every ambient environment variable available to
  // a delegated bash-capable agent. Supports exact names and glob patterns.
  // Set "*" to pass all env (explicit insecure opt-in).
  const passthroughRaw = process.env[PASSTHROUGH_ENV] ?? "";
  const patterns = passthroughRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (patterns.length > 0) {
    const allParentKeys = Object.keys(process.env);
    for (const pat of patterns) {
      const re = passthroughPatternToRegExp(pat);
      if (!re) continue;
      for (const key of allParentKeys) {
        if (re.test(key)) {
          const value = process.env[key];
          if (value !== undefined) env[key] = value;
        }
      }
    }
  }
  env["PWD"] = cwd;
  env[DEPTH_ENV] = String(depth);
  env[RUN_ID_ENV] = childRunId;
  env[PARENT_ID_ENV] = parentRunId;
  env[ROOT_ID_ENV] = control.rootRunId;
  env[CONTROL_ENV] = control.statePath;
  env[DEADLINE_ENV] = String(control.deadlineMs);
  env[BUDGET_ENV] = String(budgetRemaining);
  if (process.env[TIMEOUT_ENV] !== undefined) env[TIMEOUT_ENV] = process.env[TIMEOUT_ENV];
  if (process.env[PASSTHROUGH_ENV] !== undefined) env[PASSTHROUGH_ENV] = process.env[PASSTHROUGH_ENV];
  if (process.env[SUBAGENT_BIN_ENV] !== undefined) env[SUBAGENT_BIN_ENV] = process.env[SUBAGENT_BIN_ENV];
  if (process.env[PI_BIN_ENV] !== undefined) env[PI_BIN_ENV] = process.env[PI_BIN_ENV];
  return env;
}

interface ReservationResult {
  reservation?: ChildReservation;
  reason?: string;
  termination?: AgentTermination;
  /** Capacity is temporarily unavailable; retry after another owner releases a slot. */
  wait?: boolean;
}

async function reserveChild(
  control: ControlContext,
  childRunId: string,
  signal?: AbortSignal,
  consumeBudget = true,
): Promise<ReservationResult> {
  while (true) {
    try {
      const result = await withControlState(control, (state): ReservationResult => {
        if (consumeBudget && Date.now() >= state.deadlineMs) {
          return { reason: "Root subagent deadline reached.", termination: "timed_out" };
        }
        if (consumeBudget && state.remaining <= 0) {
          return { reason: `Root descendant budget exhausted (maximum ${MAX_DESCENDANTS}).` };
        }
        if (state.activeRunIds.includes(childRunId)) {
          return { reason: `Subagent reservation already exists for ${childRunId}.` };
        }
        if (state.active >= state.maxConcurrent) return { wait: true };
        if (consumeBudget) state.remaining--;
        state.active++;
        state.activeRunIds.push(childRunId);
        return { reservation: { budgetRemaining: state.remaining } };
      }, signal);
      if (!result.wait) return result;
      if (signal?.aborted) return { reason: "Subagent aborted.", termination: "cancelled" };
      if (Date.now() >= control.deadlineMs) return { reason: "Root subagent deadline reached.", termination: "timed_out" };
      await delay(Math.min(25, Math.max(1, control.deadlineMs - Date.now())), signal);
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : String(error),
        termination: signal?.aborted ? "cancelled" : Date.now() >= control.deadlineMs ? "timed_out" : "failed",
      };
    }
  }
}

async function releaseChild(control: ControlContext, childRunId: string): Promise<boolean> {
  try {
    return await withControlState(control, (state) => {
      const index = state.activeRunIds.indexOf(childRunId);
      if (index < 0) return false;
      state.activeRunIds.splice(index, 1);
      state.active = state.activeRunIds.length;
      return true;
    });
  } catch {
    // The root may already be shutting down and removing its ephemeral state.
    return false;
  }
}

export interface DepthStatus {
  valid: boolean;
  depth: number;
}

/** Invalid depth values fail closed at the maximum rather than resetting to zero. */
export function readDepth(value?: string): DepthStatus {
  // An explicit undefined is useful to tests and callers that want to parse a
  // value without consulting ambient process state; no argument reads env.
  const raw = arguments.length === 0 ? process.env[DEPTH_ENV] : value;
  if (raw === undefined) return { valid: true, depth: 0 };
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) return { valid: false, depth: MAX_DEPTH };
  const depth = Number(raw);
  if (!Number.isSafeInteger(depth)) return { valid: false, depth: MAX_DEPTH };
  return { valid: true, depth };
}

export interface ParsedJsonEvent {
  kind: "message" | "messages" | "progress" | "error";
  message?: Message;
  messages?: Message[];
  /** Cumulative message carried by Pi's message_update event for stream accounting. */
  streamMessage?: Message;
  text?: string;
  errorMessage?: string;
}

/** Parse one JSON-mode line; malformed/non-event lines are safely ignored. */
export function parseJsonEventLine(line: string): ParsedJsonEvent | undefined {
  if (!line.trim()) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object") return undefined;
  const candidate = event as Record<string, unknown>;
  if (candidate.type === "message_end" && isFinalMessage(candidate.message)) {
    return { kind: "message", message: candidate.message };
  }
  if (candidate.type === "tool_execution_end") {
    const toolName = typeof candidate.toolName === "string" ? candidate.toolName : "tool";
    return { kind: "progress", text: `Finished ${truncateOutput(toolName, 256)}.` };
  }
  if (candidate.type === "agent_end" && Array.isArray(candidate.messages)) {
    const messages = candidate.messages.filter(isFinalMessage);
    return messages.length > 0 ? { kind: "messages", messages } : undefined;
  }
  if (candidate.type === "message_update" && isMessage(candidate.message)) {
    return { kind: "progress", text: textFromMessage(candidate.message), streamMessage: candidate.message };
  }
  if (candidate.type === "tool_execution_start" || candidate.type === "tool_execution_update") {
    const toolName = typeof candidate.toolName === "string" ? candidate.toolName : "tool";
    return { kind: "progress", text: `Running ${truncateOutput(toolName, 256)}...` };
  }
  if (candidate.type === "error") {
    const errorMessage = typeof candidate.errorMessage === "string"
      ? candidate.errorMessage
      : typeof candidate.message === "string" ? candidate.message : "Subagent process reported an error.";
    return { kind: "error", errorMessage };
  }
  return undefined;
}

interface ProcessResult {
  exitCode: number;
  stopReason?: StopReason;
  termination: AgentTermination;
  errorMessage?: string;
  stderr: string;
}

function descendantPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  const snapshot = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 1000 });
  if (snapshot.status !== 0 || typeof snapshot.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of snapshot.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(childPid) || !Number.isSafeInteger(parentPid)) continue;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(childPid);
    children.set(parentPid, siblings);
  }
  const result: number[] = [];
  const visit = (parentPid: number) => {
    for (const childPid of children.get(parentPid) ?? []) {
      visit(childPid);
      result.push(childPid);
    }
  };
  visit(pid);
  return result;
}

/**
 * Terminate a child and its descendants without killing an ancestor group.
 *
 * Keep the first descendant snapshot until the SIGKILL escalation. A nested
 * leader can exit after SIGTERM while its descendants become reparented, so a
 * later `ps` snapshot rooted at the leader would otherwise miss them.
 */
const terminatedProcessDescendants = new WeakMap<ChildProcess, Set<number>>();

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    const tracked = terminatedProcessDescendants.get(child) ?? new Set<number>();
    for (const pid of descendantPids(child.pid)) tracked.add(pid);
    if (signal === "SIGTERM") terminatedProcessDescendants.set(child, tracked);
    for (const pid of tracked) {
      try {
        process.kill(pid, signal);
      } catch {
        // The process may have exited between the snapshot and the signal.
      }
    }
    if (signal === "SIGKILL") terminatedProcessDescendants.delete(child);
  }
  terminateProcessGroup(child, signal);
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    if (child.pid) {
      // `ChildProcess.kill()` does not include descendants on Windows.
      const tree = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      tree.on("error", () => {});
      tree.unref();
    }
    return;
  }
  try {
    if (child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to the direct child. The process may have exited already.
  }
  try {
    child.kill(signal);
  } catch {
    // The close event will produce the final result.
  }
}

/** Sweep only the detached root group after its leader exits. */
function sweepRootProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    terminateProcessGroup(child, "SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // No surviving group; importantly, do not signal a potentially reused
    // direct-child PID after the leader has already exited.
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, 0);
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // The group exited during the grace period.
    }
  }, 5000);
  // Keep the host alive through the grace period so an unresponsive
  // descendant cannot outlive the delegation merely because the parent exits.
}

function addAssistantUsage(usage: UsageSummary, message: Message): void {
  if (message.role !== "assistant") return;
  usage.turns++;
  if (message.usage) addUsage(usage, message.usage);
}

function recordMessage(result: AgentResult, message: Message): void {
  result.messages.push(boundMessage(message));
  if (result.messages.length > MAX_MESSAGES_PER_AGENT) result.messages.shift();
  addAssistantUsage(result.usage, message);
  if (message.role !== "assistant") return;
  const output = textFromMessage(message);
  if (typeof message.model === "string" && message.model) result.model = truncateOutput(message.model, 256);
  if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse" || message.stopReason === "error" || message.stopReason === "aborted") {
    result.stopReason = message.stopReason;
  }
  // Only terminal assistant messages are authoritative output. Text attached
  // to a toolUse turn is progress, not a completed report.
  if (message.stopReason === "stop" || message.stopReason === "length") {
    result.termination = "completed";
    if (output) result.output = truncateOutput(output, MAX_OUTPUT_BYTES);
  } else if (message.stopReason === "aborted") {
    result.termination = "cancelled";
  } else if (message.stopReason === "error") {
    result.termination = "failed";
  }
  if (typeof message.errorMessage === "string" && message.errorMessage) result.errorMessage = boundedDiagnostic(message.errorMessage);
}

async function runPiProcess(
  args: string[],
  cwd: string,
  depth: number,
  control: ControlContext,
  parentRunId: string,
  childRunId: string,
  reservation: ChildReservation,
  signal: AbortSignal | undefined,
  onEvent: (event: ParsedJsonEvent) => void,
): Promise<ProcessResult> {
  if (signal?.aborted) return { exitCode: 1, stopReason: "aborted", termination: "cancelled", errorMessage: "Subagent aborted.", stderr: "" };
  const timeoutMs = processTimeoutMs(control.deadlineMs);
  if (control.deadlineMs <= Date.now()) return { exitCode: 1, stopReason: "error", termination: "timed_out", errorMessage: "Root subagent deadline reached.", stderr: "" };

  const invocation = getPiInvocation(args);
  return new Promise((resolve) => {
    let settled = false;
    let aborted = false;
    let stderr = "";
    let trailing = "";
    let discardingLine = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let processTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let eventError: string | undefined;
    const decoder = new StringDecoder("utf8");
    let abortHandler: (() => void) | undefined;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      // A nested leader can close before the escalation timer fires while a
      // descendant ignores SIGTERM and does not hold an inherited pipe open.
      // Force the retained tree snapshot before dropping the timer.
      if (aborted || timedOut || eventError) {
        terminateProcessTree(child, "SIGKILL");
      }
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (processTimer) clearTimeout(processTimer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      resolve({ ...result, stderr: truncateOutput(stderr) });
    };

    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: childEnvironment(depth + 1, control, parentRunId, childRunId, reservation.budgetRemaining, cwd),
        shell: false,
        // Keep nested children in the root child's process group. The root
        // child is detached from the host; descendants then die with that
        // group instead of becoming independent orphaned model callers.
        detached: depth === 0,
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChildren.add(child);
      let rootGroupSwept = false;
      const sweepRoot = () => {
        if (depth !== 0 || rootGroupSwept) return;
        rootGroupSwept = true;
        sweepRootProcessGroup(child);
      };
      // `close` waits for stdio streams; a descendant can keep an inherited
      // pipe open after the leader exits. Sweep on `exit` first so that child
      // cannot defer cleanup until the hard timeout.
      child.once("exit", sweepRoot);
      child.once("close", sweepRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({ exitCode: 1, stopReason: "error", termination: "failed", errorMessage: message, stderr });
      return;
    }

    const stopForAbort = () => {
      if (settled) return;
      aborted = true;
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) terminateProcessTree(child, "SIGKILL");
      }, 5000);
    };
    const stopForTimeout = () => {
      if (settled) return;
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) terminateProcessTree(child, "SIGKILL");
      }, 5000);
    };
    processTimer = setTimeout(stopForTimeout, timeoutMs);
    const deliverEvent = (event: ParsedJsonEvent) => {
      if (settled || eventError) return;
      try {
        onEvent(event);
      } catch (error) {
        eventError = error instanceof Error ? error.message : String(error);
        terminateProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) terminateProcessTree(child, "SIGKILL");
        }, 5000);
      }
    };
    abortHandler = stopForAbort;
    if (signal) signal.addEventListener("abort", abortHandler, { once: true });

    const consumeStdoutText = (text: string) => {
      let cursor = 0;
      while (cursor < text.length) {
        if (discardingLine) {
          const newline = text.indexOf("\n", cursor);
          if (newline < 0) return;
          discardingLine = false;
          cursor = newline + 1;
          continue;
        }

        const newline = text.indexOf("\n", cursor);
        if (newline < 0) {
          const segment = text.slice(cursor);
          if (Buffer.byteLength(trailing, "utf8") + Buffer.byteLength(segment, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
            // Drop the rest of an oversized unterminated line, but keep reading
            // until its newline so a later valid event can still complete.
            trailing = "";
            discardingLine = true;
          } else {
            trailing += segment;
          }
          return;
        }

        const segment = text.slice(cursor, newline);
        const lineBytes = Buffer.byteLength(trailing, "utf8") + Buffer.byteLength(segment, "utf8");
        if (lineBytes <= MAX_PROTOCOL_LINE_BYTES) {
          const event = parseJsonEventLine(trailing + segment);
          if (event) deliverEvent(event);
        }
        trailing = "";
        cursor = newline + 1;
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      consumeStdoutText(decoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = capStderr(stderr, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      activeChildren.delete(child);
      const message = error instanceof Error ? error.message : String(error);
      if (eventError) {
        finish({ exitCode: 1, stopReason: "error", termination: "failed", errorMessage: `Subagent event handling failed: ${eventError}`, stderr });
      } else if (timedOut) {
        finish({ exitCode: 1, stopReason: "error", termination: "timed_out", errorMessage: `Subagent timed out after ${timeoutMs} ms.`, stderr });
      } else if (aborted) {
        finish({ exitCode: 1, stopReason: "aborted", termination: "cancelled", errorMessage: "Subagent aborted.", stderr });
      } else {
        finish({ exitCode: 1, stopReason: "error", termination: "failed", errorMessage: message, stderr });
      }
    });
    child.on("close", (code) => {
      activeChildren.delete(child);
      const finalText = decoder.end();
      if (finalText && !discardingLine) consumeStdoutText(finalText);
      if (trailing.trim() && !discardingLine && Buffer.byteLength(trailing, "utf8") <= MAX_PROTOCOL_LINE_BYTES) {
        const event = parseJsonEventLine(trailing);
        if (event) deliverEvent(event);
      }
      if (eventError) {
        finish({ exitCode: 1, stopReason: "error", termination: "failed", errorMessage: `Subagent event handling failed: ${eventError}`, stderr });
        return;
      }
      if (timedOut) {
        finish({ exitCode: 1, stopReason: "error", termination: "timed_out", errorMessage: `Subagent timed out after ${timeoutMs} ms.`, stderr });
        return;
      }
      if (aborted || signal?.aborted) {
        finish({ exitCode: code ?? 1, stopReason: "aborted", termination: "cancelled", errorMessage: "Subagent aborted.", stderr });
        return;
      }
      const exitCode = code ?? 1;
      let errorMessage: string | undefined;
      if (exitCode !== 0) {
        const cleanStderr = stderr.trim();
        if (cleanStderr) {
          errorMessage = `Subagent exited with code ${exitCode}.\n${truncateOutput(cleanStderr, 2048)}`;
          if (/No API key|No models match pattern|API key.*not found/i.test(cleanStderr)) {
            errorMessage += `\n\nHint: Child env passes model refs and *_API_KEY/*_TOKEN credentials automatically. For non-credential variables, set PI_SUBAGENT_PASSTHROUGH_ENV with an exact name or glob and restart Pi. Auth in ~/.pi/agent/auth.json via /login needs no passthrough.`;
          }
        } else {
          errorMessage = `Subagent exited with code ${exitCode}.`;
        }
      }
      finish({ exitCode, stderr, stopReason: exitCode === 0 ? undefined : "error", termination: exitCode === 0 ? "completed" : "failed", errorMessage });
    });

    if (signal?.aborted) stopForAbort();
  });
}

async function runAgent(
  agents: AgentConfig[],
  name: string,
  task: string,
  cwd: string,
  execution: ExecutionContext,
  parentModel: Model<any> | undefined,
  modelOverride: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  emit: (result: AgentResult, progress?: string) => void,
): Promise<AgentResult> {
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
  let updateError: string | undefined;
  let eventFailure: string | undefined;
  const report = (progress: string, propagate = true) => {
    try {
      emit(result, progress);
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
      if (propagate) throw error;
    }
  };

  let tempDir: string | undefined;
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
    const args = ["--mode", "json", "-p", "--no-session"];
    if (result.model) args.push("--model", result.model);
    const tools = effectiveTools(agent);
    if (tools.length > 0) args.push("--tools", tools.join(","));
    else args.push("--no-tools");
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
    if (agent.systemPrompt.trim()) {
      const promptPath = path.join(tempDir, "system-prompt.md");
      await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
      args.push("--append-system-prompt", promptPath);
    }
    const taskPath = path.join(tempDir, "task.md");
    await fs.promises.writeFile(taskPath, `Task:\n${task}`, { encoding: "utf8", mode: 0o600 });
    args.push(`@${taskPath}`);

    const processResult = await runPiProcess(args, cwd, execution.depth, execution.control, execution.runId, result.runId, reservation, signal, (event) => {
      if (event.kind === "message" && event.message) {
        recordMessage(result, event.message);
        if (eventFailure) {
          result.stopReason = "error";
          result.errorMessage = eventFailure;
        }
        report(result.output || getFinalOutput(result.messages) || "Subagent is working...");
      } else if (event.kind === "messages" && event.messages && result.messages.length === 0) {
        for (const message of event.messages) recordMessage(result, message);
        report(result.output || getFinalOutput(result.messages) || "Subagent finished...");
      } else if (event.kind === "progress") {
        report(event.text || "Subagent is working...");
      } else if (event.kind === "error") {
        eventFailure = truncateOutput(event.errorMessage || "Subagent process reported an error.", MAX_DIAGNOSTIC_BYTES);
        result.stopReason = "error";
        result.errorMessage = eventFailure;
        report(eventFailure);
      }
    });

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

function failed(result: AgentResult): boolean {
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

function isRenderableUsage(value: unknown): value is UsageSummary {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  const cost = usage.cost;
  return ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "turns"].every((key) => isFiniteNumber(usage[key]))
    && !!cost && typeof cost === "object"
    && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => isFiniteNumber((cost as Record<string, unknown>)[key]));
}

function isRenderableAgentResult(value: unknown): value is AgentResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AgentResult>;
  return typeof result.agent === "string"
    && typeof result.agentSource === "string"
    && typeof result.task === "string"
    && (result.output === undefined || typeof result.output === "string")
    && typeof result.runId === "string"
    && typeof result.rootRunId === "string"
    && isFiniteNumber(result.depth)
    && isFiniteNumber(result.exitCode)
    && (result.termination === undefined || result.termination === "completed" || result.termination === "failed" || result.termination === "cancelled" || result.termination === "timed_out")
    && typeof result.stderr === "string"
    && Array.isArray(result.messages)
    && isRenderableUsage(result.usage);
}

function resultText(result: AgentResult): string {
  if (failed(result)) return result.errorMessage || result.stderr || result.output || getFinalOutput(result.messages) || "(no output)";
  return result.output || getFinalOutput(result.messages) || "(no output)";
}

function copyResult(result: AgentResult): AgentResult {
  return { ...result, messages: [...result.messages], usage: { ...result.usage, cost: { ...result.usage.cost } } };
}

async function mapWithConcurrency<T>(items: T[], fn: (item: T, index: number) => Promise<AgentResult>): Promise<AgentResult[]> {
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

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatUsage(usage: UsageSummary, model?: string): string {
  const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  if (model) parts.push(stripTerminalControls(model));
  return parts.join(" ");
}

function aggregateUsage(results: AgentResult[]): UsageSummary {
  const total = emptyUsage();
  for (const result of results) {
    total.turns += result.usage.turns;
    addUsage(total, result.usage);
  }
  return total;
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

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke", minLength: 1, maxLength: 256 }),
  task: Type.String({ description: "Task to delegate", minLength: 1, maxLength: MAX_TASK_BYTES }),
  model: Type.Optional(Type.String({ description: "Optional model override for this task" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
}, { additionalProperties: false });

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke", minLength: 1, maxLength: 256 }),
  task: Type.String({ description: "Task, with optional {previous} for the preceding output", minLength: 1, maxLength: MAX_TASK_BYTES }),
  model: Type.Optional(Type.String({ description: "Optional model override for this step" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this step" })),
}, { additionalProperties: false });

const SubagentParamsSchema = Type.Object({
  action: Type.Optional(StringEnum(["list"] as const, { description: "List available agents" })),
  agent: Type.Optional(Type.String({ description: "Agent name for single mode", minLength: 1, maxLength: 256 })),
  task: Type.Optional(Type.String({ description: "Task for single mode", minLength: 1, maxLength: MAX_TASK_BYTES })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks (maximum 8)", maxItems: MAX_PARALLEL_TASKS })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential steps using {previous}", maxItems: MAX_CHAIN_STEPS })),
  agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { description: "Agent scope; bundled agents are always included" })),
  model: Type.Optional(Type.String({ description: "Model override, provider/model-id; applies to every mode" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the delegation" })),
}, { additionalProperties: false });

function requestedAgentNames(params: SubagentParams): string[] {
  const names = new Set<string>();
  if (params.agent) names.add(params.agent.trim());
  for (const task of params.tasks ?? []) names.add(task.agent.trim());
  for (const step of params.chain ?? []) names.add(step.agent.trim());
  return [...names];
}

function modeOf(params: SubagentParams): SubagentDetails["mode"] {
  if (params.chain !== undefined) return "chain";
  if (params.tasks !== undefined) return "parallel";
  return "single";
}

function validSingle(params: SubagentParams): boolean {
  return typeof params.agent === "string" && params.agent.trim().length > 0 && typeof params.task === "string" && params.task.trim().length > 0;
}

function hasValidItems(params: SubagentParams): boolean {
  return (params.tasks ?? []).every((item) => item.agent.trim().length > 0 && item.task.trim().length > 0)
    && (params.chain ?? []).every((item) => item.agent.trim().length > 0 && item.task.trim().length > 0);
}

function hasBlankModel(params: SubagentParams): boolean {
  return [
    params.model,
    ...(params.tasks ?? []).map((item) => item.model),
    ...(params.chain ?? []).map((item) => item.model),
  ].some((model) => model !== undefined && model.trim().length === 0);
}

function availableText(agents: AgentConfig[]): string {
  return truncateOutput(agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none", MAX_DIAGNOSTIC_BYTES);
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

function waitForChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      child.removeListener("close", done);
      child.removeListener("error", done);
      resolve();
    };
    child.once("close", done);
    child.once("error", done);
    if (child.exitCode !== null || child.signalCode !== null) setTimeout(done, 0);
  });
}

function waitForChildren(children: ChildProcess[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    Promise.all(children.map((child) => waitForChild(child))).then(done);
  });
}

export default function (pi: ExtensionAPI) {
  // A detached process group is used so cancellation cannot kill the parent
  // pi process. Reap groups when the extension/session is shut down as well.
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", async () => {
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
      "Delegate to specialized agents using exactly one mode: single (agent + task), parallel (tasks), or sequential chain (chain with {previous}).",
      `Bundled agents are always available. User agents come from ${path.join(getAgentDir(), "agents")}; project agents come from ${CONFIG_DIR_NAME}/agents and require pi trust plus interactive confirmation.`,
      "All delegation runs in an isolated subprocess. A top-level model override applies to every mode; otherwise the parent model is inherited.",
      "The only action is list. Model-visible output and partial updates share one deterministic 50KB cap per tool call.",
    ].join(" "),
    parameters: SubagentParamsSchema,
    // The tool owns its own parallel mode and rejects unsafe same-project-root writes.
    // Serialize sibling top-level calls so two separate tool calls cannot
    // bypass that per-call mutation guard.
    executionMode: "sequential",
    promptSnippet: "Delegate work to an isolated named subagent (single, parallel, or chain).",
    promptGuidelines: [
      "Call subagent in parallel only for independent tasks; potentially-mutating tasks sharing a project root are rejected.",
      "Call subagent in a chain when a later agent needs the previous agent's report.",
    ],

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runId = randomUUID();
      const parentRunId = process.env[RUN_ID_ENV];
      const inheritedRootRunId = process.env[ROOT_ID_ENV] ?? runId;
      const depth = readDepth();
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
      const baseDetails = (mode: SubagentDetails["mode"], results: AgentResult[], action?: SubagentDetails["action"]): SubagentDetails => boundDetails({
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
      const hasSingleFields = params.agent !== undefined || params.task !== undefined;
      const hasSingle = hasSingleFields;
      const hasParallel = params.tasks !== undefined;
      const hasChain = params.chain !== undefined;

      if (params.action && (hasSingle || hasParallel || hasChain)) {
        return toolResult("action=\"list\" cannot be combined with a delegation mode.", baseDetails("single", []), true);
      }

      if (params.action) {
        if (params.action !== "list") {
          return toolResult(`Unknown action: ${params.action}`, baseDetails("single", []), true);
        }
        const listApproval = await confirmProjectAgents(
          ctx,
          discovery.agents.filter((agent) => agent.source === "project").map((agent) => agent.name),
          discovery.agents,
          discovery.projectAgentsDir,
          trustedProjectRoot,
          projectRoot,
          signal,
        );
        if (!listApproval.allowed) {
          return toolResult(listApproval.reason ?? "Project-local agents were not approved.", baseDetails("single", []), true);
        }
        const lines = discovery.agents.map((agent) => {
          const configuredModel = agent.model ? ` [${agent.model}]` : " [parent model]";
          const tools = agent.tools?.length ? agent.tools.join(",") : "none";
          const capability = agent.capability ?? "unspecified";
          const delegation = agent.delegation ? "yes" : "no";
          return `${agent.name}: ${agent.description}${configuredModel} (${agent.source}; capability=${capability}; delegation=${delegation}; tools=${tools})`;
        });
        return toolResult(lines.length ? `Available agents:\n${lines.join("\n")}` : "No agents found.", baseDetails("single", [], "list"));
      }

      if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
        return toolResult(
          `Invalid parameters. Provide exactly one mode: agent + task, tasks[], or chain[].\nAvailable agents: ${availableText(discovery.agents)}`,
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
      if (!hasValidItems(params)) {
        return toolResult("Agent names and tasks must not be blank.", baseDetails(hasChain ? "chain" : "parallel", []), true);
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
      const texts = [params.task, ...(params.tasks ?? []).map((item) => item.task), ...(params.chain ?? []).map((item) => item.task)];
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
        ...(params.tasks ?? []),
        ...(params.chain ?? []),
      ];
      const parallelMutators = new Map<string, string[]>();
      for (const item of taskLocations) {
        const requestedCwd = cwdFor(rootCwd, item.cwd);
        const taskCwd = existingDirectory(requestedCwd);
        if (!taskCwd) {
          return toolResult(`Working directory does not exist: ${requestedCwd}`, baseDetails(modeOf(params), []), true);
        }
        if (projectAgentNames.has(item.agent.trim()) && !isWithinDirectory(trustedProjectRoot, taskCwd)) {
          return toolResult(
            `Project agent "${item.agent.trim()}" may only run within the trusted project root: ${trustedProjectRoot}`,
            baseDetails(modeOf(params), []),
            true,
          );
        }
        if (hasParallel && potentiallyMutating(discovery.agents.find((agent) => agent.name === item.agent.trim()))) {
          // Distinct subdirectories of one repository still share files and
          // Git state. Reject concurrent mutators at the nearest project root,
          // falling back to the canonical cwd outside recognized projects.
          const conflictRoot = findNearestProjectRoot(taskCwd) ?? taskCwd;
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
      };
      let yieldedReservation = false;
      try {
        if (execution.reservationRunId) {
          yieldedReservation = await releaseChild(control, execution.reservationRunId);
          if (!yieldedReservation) throw new Error("Nested subagent reservation is missing; refusing to run without an owned capacity slot.");
        }
        const parentModel = ctx.model;
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

      if (hasSingle) {
        const result = await runAgent(
          discovery.agents,
          params.agent!.trim(),
          params.task!,
          rootCwd,
          execution,
          parentModel,
          params.model,
          undefined,
          signal,
          (current, progress) => emitSingle("single", [current], current, progress),
        );
        return toolResult(resultText(result), baseDetails("single", [result]), failed(result));
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
          const result = await runAgent(
            discovery.agents,
            step.agent.trim(),
            task,
            stepCwd,
            execution,
            parentModel,
            params.model ?? step.model,
            index + 1,
            signal,
            (current, progress) => emitSingle("chain", [...results, current], current, progress),
          );
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
      const results = await mapWithConcurrency(params.tasks!, async (task, index) => runAgent(
        discovery.agents,
        task.agent.trim(),
        task.task,
        existingDirectory(cwdFor(rootCwd, task.cwd)) ?? cwdFor(rootCwd, task.cwd),
        execution,
        parentModel,
        params.model ?? task.model,
        undefined,
        signal,
        (result, progress) => {
          current[index] = copyResult(result);
          const done = current.filter((item) => item.exitCode !== -1).length;
          notify(progress ?? `Parallel: ${done}/${current.length} done`, baseDetails("parallel", current.map(copyResult)));
        },
      ));
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
        if (control.ownerDirectory) await fs.promises.rm(control.ownerDirectory, { recursive: true, force: true }).catch(() => {});
      }
    },

    renderCall(args, theme) {
      if (args.action === "list") return new Text(theme.fg("toolTitle", theme.bold("subagent list")), 0, 0);
      const scope = stripTerminalControls(args.agentScope ?? "user");
      const label = args.chain?.length
        ? `chain (${args.chain.length})`
        : args.tasks?.length
          ? `parallel (${args.tasks.length})`
          : stripTerminalControls(args.agent ?? "...");
      let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", label)}${theme.fg("muted", ` [${scope}]`)}`;
      if (args.chain?.length) {
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
      if (!details || !["single", "parallel", "chain"].includes(details.mode) || !Array.isArray(details.results) || details.results.length === 0 || !details.results.every(isRenderableAgentResult)) return new Text(fallback, 0, 0);

      const renderBudget = { remaining: MAX_OUTPUT_BYTES };
      const takeRender = (value: string): string => {
        if (renderBudget.remaining <= 0) return "[render output truncated]";
        const bounded = truncateOutput(stripTerminalControls(value), renderBudget.remaining);
        renderBudget.remaining = Math.max(0, renderBudget.remaining - Buffer.byteLength(bounded, "utf8"));
        return bounded;
      };
      const iconFor = (item: AgentResult) => item.exitCode === -1 ? theme.fg("warning", "⏳") : failed(item) ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const renderOutput = (item: AgentResult, full: boolean) => {
        const output = resultText(item);
        if (item.exitCode === -1 && output === "(no output)") {
          return details.results.length === 1 ? takeRender(fallback) : takeRender("(running...)");
        }
        return takeRender(full ? output : output.split("\n").slice(0, 5).join("\n"));
      };

      if (expanded) {
        const container = new Container();
        container.addChild(new Text(`${iconFor(details.results.some(failed) ? details.results.find(failed)! : details.results[0]!)} ${theme.fg("toolTitle", theme.bold(details.mode))}`, 0, 0));
        for (const item of details.results) {
          container.addChild(new Spacer(1));
          const status = item.termination ?? item.stopReason;
          container.addChild(new Text(`${iconFor(item)} ${theme.fg("accent", stripTerminalControls(item.agent))}${theme.fg("muted", ` (${stripTerminalControls(item.agentSource)})`)}${status ? theme.fg("dim", ` [${status}]`) : ""}`, 0, 0));
          container.addChild(new Text(theme.fg("dim", takeRender(truncateChars(item.task, 500))), 0, 0));
          const output = renderOutput(item, true);
          if (output && output !== "(no output)") container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
          else container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          container.addChild(new Text(theme.fg("dim", formatUsage(item.usage, item.model)), 0, 0));
        }
        if (details.results.length > 1) container.addChild(new Text(theme.fg("dim", `Total: ${formatUsage(aggregateUsage(details.results))}`), 0, 0));
        return container;
      }

      let text = `${iconFor(details.results.some(failed) ? details.results.find(failed)! : details.results[0]!)} ${theme.fg("toolTitle", theme.bold(details.mode))}`;
      for (const item of details.results) {
        text += `\n\n${iconFor(item)} ${theme.fg("accent", stripTerminalControls(item.agent))}${theme.fg("muted", ` (${stripTerminalControls(item.agentSource)})`)}`;
        text += `\n${theme.fg("toolOutput", truncateChars(renderOutput(item, false), 500))}`;
      }
      text += `\n${theme.fg("dim", formatUsage(aggregateUsage(details.results)))}`;
      return new Text(text, 0, 0);
    },
  });
}

/** Keep untrusted agent text from emitting terminal control sequences in the TUI. */
export function stripTerminalControls(value: string): string {
  return value
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001BP[\s\S]*?(?:\u0007|\u001B\\)/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function truncateChars(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export { SubagentParamsSchema };
