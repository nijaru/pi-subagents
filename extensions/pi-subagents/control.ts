import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";

import { BUDGET_ENV, CONTROL_ENV, CONTROL_LOCK_STALE_MS, CONTROL_LOCK_WAIT_MS, CONTROL_VERSION, DEADLINE_ENV, DEFAULT_PROCESS_TIMEOUT_MS, DELEGATION_POLICY_ENV, DELEGATION_POLICY_FILE_ENV, DEPTH_ENV, MAX_CONCURRENCY, MAX_DELEGATION_POLICY_BYTES, MAX_DEPTH, MAX_DESCENDANTS, MAX_PROCESS_TIMEOUT_MS, PARENT_ID_ENV, ROOT_ID_ENV, RUN_ID_ENV, TIMEOUT_ENV } from "./limits.ts";
import type { AgentTermination } from "./types.ts";

export interface ControlState {
  version: number;
  rootRunId: string;
  remaining: number;
  active: number;
  /** Active child reservations; nested callers yield a slot while waiting. */
  activeRunIds: string[];
  maxConcurrent: number;
  deadlineMs: number;
}

export interface ControlContext {
  statePath: string;
  rootRunId: string;
  deadlineMs: number;
  ownerDirectory?: string;
}

export interface ChildReservation {
  budgetRemaining: number;
}

export interface DelegationPolicy {
  allowedAgents?: string[];
  remainingDepth?: number;
}

export function configuredTimeoutMs(): number {
  const configured = Number(process.env[TIMEOUT_ENV]);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= MAX_PROCESS_TIMEOUT_MS
    ? configured
    : DEFAULT_PROCESS_TIMEOUT_MS;
}

export function processTimeoutMs(deadlineMs?: number): number {
  const configured = configuredTimeoutMs();
  if (deadlineMs === undefined) return configured;
  return Math.max(1, Math.min(configured, deadlineMs - Date.now()));
}

export function isControlId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isControlState(value: unknown): value is ControlState {
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

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
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

export interface ControlLockOwner {
  pid: number;
  startedAt: number;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the process exists but is not signalable by this process.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform === "win32") return true;
  // A reparented child can remain a zombie until its new parent reaps it;
  // kill(pid, 0) still succeeds for that interval, but it cannot own a lock.
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
  return !(status.status === 0 && typeof status.stdout === "string" && /^\s*Z/.test(status.stdout));
}

export async function removeStaleControlLock(lockPath: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs <= CONTROL_LOCK_STALE_MS) return;
    let ownerAlive = false;
    try {
      const raw = await fs.promises.readFile(path.join(lockPath, "owner"), "utf8");
      const owner = JSON.parse(raw) as Partial<ControlLockOwner>;
      ownerAlive = Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && processIsAlive(owner.pid as number);
    } catch {
      // Locks from an interrupted acquisition may have no owner marker. They
      // are recoverable once stale, while a fresh marker-less lock is retained
      // by the age check above.
    }
    if (ownerAlive) return;

    // Rename before removing. A releaser or another waiter can race with this
    // check, but neither can be confused with the quarantined lock path.
    const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      await fs.promises.rename(lockPath, quarantinePath);
    } catch {
      return;
    }
    await fs.promises.rm(quarantinePath, { recursive: true, force: true });
  } catch {
    // The owner may have released the lock between stat and cleanup.
  }
}

export async function acquireControlLock(control: ControlContext, signal?: AbortSignal): Promise<string> {
  const lockPath = `${control.statePath}.lock`;
  const started = Date.now();
  const waitDeadline = Math.min(started + CONTROL_LOCK_WAIT_MS, control.deadlineMs);
  while (true) {
    if (signal?.aborted) throw new Error("Subagent aborted.");
    if (Date.now() >= waitDeadline) throw new Error("Timed out acquiring subagent control state lock.");
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.promises.writeFile(
          path.join(lockPath, "owner"),
          JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies ControlLockOwner),
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (error) {
        await fs.promises.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return lockPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      await removeStaleControlLock(lockPath);
      const remaining = waitDeadline - Date.now();
      if (remaining <= 0) throw new Error("Timed out acquiring subagent control state lock.");
      await delay(Math.min(25, remaining), signal);
    }
  }
}

export async function writeControlState(controlPath: string, state: ControlState): Promise<void> {
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

export async function withControlState<T>(control: ControlContext, update: (state: ControlState) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
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

export async function createControlState(rootRunId: string): Promise<ControlContext> {
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

export async function inheritedControlState(depth: DepthStatus, rootRunId: string): Promise<ControlContext | undefined> {
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

export function readDelegationPolicy(): { policy?: DelegationPolicy; error?: string } {
  const policyFile = process.env[DELEGATION_POLICY_FILE_ENV];
  let raw = process.env[DELEGATION_POLICY_ENV];
  if (policyFile !== undefined) {
    if (!path.isAbsolute(policyFile)) return { error: "Nested delegation policy file path is malformed." };
    try {
      const stat = fs.lstatSync(policyFile);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        return { error: "Nested delegation policy file must be a private regular file." };
      }
      raw = fs.readFileSync(policyFile, "utf8");
    } catch {
      return { error: "Nested delegation policy file could not be read." };
    }
  }
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw, "utf8") > MAX_DELEGATION_POLICY_BYTES) return { error: "Nested delegation policy is too large." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Nested delegation policy is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Nested delegation policy is malformed." };
  const value = parsed as Record<string, unknown>;
  const allowedAgents = value.allowedAgents;
  if (allowedAgents !== undefined && (!Array.isArray(allowedAgents)
    || allowedAgents.length > 256
    || allowedAgents.some((name) => typeof name !== "string" || !name.trim() || Buffer.byteLength(name, "utf8") > 256))) {
    return { error: "Nested delegation allowedAgents is malformed." };
  }
  const remainingDepth = value.remainingDepth;
  if (remainingDepth !== undefined && (!Number.isSafeInteger(remainingDepth) || (remainingDepth as number) < 0 || (remainingDepth as number) > MAX_DEPTH)) {
    return { error: "Nested delegation depth policy is malformed." };
  }
  const policy: DelegationPolicy = {
    allowedAgents: allowedAgents === undefined ? undefined : [...new Set((allowedAgents as string[]).map((name) => name.trim()))],
    remainingDepth: remainingDepth as number | undefined,
  };
  return policy.allowedAgents === undefined && policy.remainingDepth === undefined ? { error: "Nested delegation policy is empty." } : { policy };
}

export function childDelegationPolicy(parent: DelegationPolicy | undefined, agent: AgentConfig): DelegationPolicy | undefined {
  const parentAllowed = parent?.allowedAgents;
  const ownAllowed = agent.allowedAgents;
  const allowedAgents = parentAllowed === undefined
    ? ownAllowed
    : ownAllowed === undefined
      ? parentAllowed
      : ownAllowed.filter((name) => parentAllowed.includes(name));
  const parentRemaining = parent?.remainingDepth;
  const decremented = parentRemaining === undefined ? undefined : Math.max(0, parentRemaining - 1);
  const remainingDepth = agent.maxDelegationDepth === undefined
    ? decremented
    : decremented === undefined ? agent.maxDelegationDepth : Math.min(agent.maxDelegationDepth, decremented);
  if (allowedAgents === undefined && remainingDepth === undefined) return undefined;
  return { allowedAgents, remainingDepth };
}

export interface ReservationResult {
  reservation?: ChildReservation;
  reason?: string;
  termination?: AgentTermination;
  /** Capacity is temporarily unavailable; retry after another owner releases a slot. */
  wait?: boolean;
}

export async function reserveChild(
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

export async function releaseChild(control: ControlContext, childRunId: string): Promise<boolean> {
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
