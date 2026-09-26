import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { StopReason } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { parseChildEvent, type ChildBootstrap, type ChildEvent } from "./child-protocol.ts";

import { MAX_PROTOCOL_LINE_BYTES, MAX_STDERR_BYTES } from "./limits.ts";
import type { AgentOutcome } from "./types.ts";
import { capStderr, truncateHeadTail } from "./bounds.ts";
import { processTimeoutMs } from "./limits.ts";
import { setTimeout as delay } from "node:timers/promises";
import { childEnvironment } from "./env.ts";

// Result headings already carry elapsed runtime; don't repeat the deadline in
// machine units in the cause.
const TIMED_OUT_MESSAGE = "Subagent timed out.";

export const activeChildren = new Set<ChildProcess>();

export interface PiInvocation {
  command: string;
  args: string[];
}

export function executable(pathname: string): boolean {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    // Directories carry the execute bit but cannot be spawned as runtimes.
    return fs.statSync(pathname).isFile();
  } catch {
    return false;
  }
}

export function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    if (executable(candidate)) return fs.realpathSync.native(candidate);
  }
  return undefined;
}

/**
 * Run the packaged SDK bootstrap with absolute runtime and SDK paths.
 * PI_SUBAGENT_RUNNER is an explicit protocol-runner override (also used by tests).
 */
export function getChildInvocation(): PiInvocation {
  if (process.env.PI_SUBAGENT_BIN || process.env.PI_BIN) {
    throw new Error("PI_SUBAGENT_BIN/PI_BIN CLI overrides are no longer supported; children use the installed Pi SDK. Protocol tests may set PI_SUBAGENT_RUNNER.");
  }
  const runtime = path.basename(process.execPath).toLowerCase();
  const command = /^node(\.exe)?$/.test(runtime) ? process.execPath : findOnPath("node");
  if (!command) throw new Error("Child SDK runner requires Node.js on PATH.");
  const sdk = path.join(getPackageDir(), "dist", "index.js");
  if (!fs.existsSync(sdk)) throw new Error("Child runner requires an installed Pi SDK (dist/index.js); standalone Pi binaries are not supported.");
  const runner = process.env.PI_SUBAGENT_RUNNER
    ? path.resolve(process.env.PI_SUBAGENT_RUNNER)
    : fileURLToPath(new URL("./child-bootstrap.mjs", import.meta.url));
  return { command: fs.realpathSync.native(command), args: [runner, sdk] };
}

export interface ProcessResult {
  exitCode: number;
  stopReason?: StopReason;
  outcome: AgentOutcome;
  errorMessage?: string;
  stderr: string;
  stdout?: string;
}

export function descendantPids(pid: number): number[] {
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
 * Keep the first descendant snapshot until the SIGKILL escalation. A process
 * can exit after SIGTERM while its descendants become reparented, so a
 * later `ps` snapshot rooted at the leader would otherwise miss them.
 */
export const terminatedProcessDescendants = new WeakMap<ChildProcess, Set<number>>();

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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

export function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
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

/**
 * Spawn a detached watchdog that holds the parent's end of a private pipe.
 *
 * The pipe closes however the parent dies, including SIGKILL, and the watchdog
 * then terminates the child's process group. That is the only way a hard parent
 * crash cannot leave a mutating child behind, since no exit handler runs on
 * SIGKILL. Windows needs a native job object for the same effect, so it keeps
 * the graceful-shutdown-only guarantee.
 */
export function spawnDeathWatchdog(child: ChildProcess): ChildProcess | undefined {
  if (process.platform === "win32" || !child.pid) return undefined;
  const script = [
    "cat >/dev/null",
    'kill -s TERM -- "-$1" 2>/dev/null',
    "i=0",
    'while kill -s 0 -- "-$1" 2>/dev/null && [ "$i" -lt 25 ]; do sleep 0.2; i=$((i+1)); done',
    'kill -s KILL -- "-$1" 2>/dev/null',
  ].join("; ");
  try {
    const watchdog = spawn("sh", ["-c", script, "sh", String(child.pid)], {
      stdio: ["pipe", "ignore", "ignore"],
      // Survive a parent that is killed together with its process group.
      detached: true,
    });
    watchdog.on("error", () => {});
    watchdog.stdin?.on("error", () => {});
    // Cleanup alone must never keep the parent's event loop alive.
    watchdog.unref();
    return watchdog;
  } catch {
    return undefined;
  }
}

/** Sweep only the detached root group after its leader exits. */
export async function sweepRootProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const tree = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      tree.once("error", () => resolve());
      tree.once("close", () => resolve());
    });
    await delay(100);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // No surviving group; importantly, do not signal a potentially reused
    // direct-child PID after the leader has already exited.
    return;
  }
  const groupExists = () => {
    try {
      process.kill(-child.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForGroupExit = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (groupExists() && Date.now() < deadline) await delay(25);
  };
  // Preserve the previous graceful-cleanup window before forcing the group.
  await waitForGroupExit(5000);
  if (!groupExists()) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForGroupExit(1000);
}

export interface PiProcessRequest {
  bootstrap: ChildBootstrap;
  cwd: string;
  childRunId: string;
  signal?: AbortSignal;
  onEvent: (event: ChildEvent) => void;
}

export async function runPiProcess(request: PiProcessRequest): Promise<ProcessResult> {
  const { bootstrap, cwd, childRunId, signal, onEvent } = request;
  if (signal?.aborted) return { exitCode: 1, stopReason: "aborted", outcome: "cancelled", errorMessage: "Subagent aborted.", stderr: "" };
  const timeoutMs = processTimeoutMs();

  const invocation = getChildInvocation();
  return new Promise((resolve) => {
    let settled = false;
    let finishing = false;
    let rootSweepPromise: Promise<void> | undefined;
    let aborted = false;
    let stderr = "";
    let stdout = "";
    let trailing = "";
    let discardingLine = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let processTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let eventError: string | undefined;
    let watchdog: ChildProcess | undefined;
    const decoder = new StringDecoder("utf8");
    let abortHandler: (() => void) | undefined;

    const finish = (result: ProcessResult) => {
      if (settled || finishing) return;
      finishing = true;
      // Release the death watchdog: the child is already exiting, and its pipe
      // must not stay open once this run is accounted for.
      watchdog?.stdin?.end();
      void (async () => {
        // A background run must not release mutation ownership while a
        // descendant from its detached root group can still be alive.
        if (rootSweepPromise) await rootSweepPromise;
        // A leader can close before the escalation timer fires while a
        // descendant ignores SIGTERM and does not hold an inherited pipe open.
        // Force the retained tree snapshot before dropping the timer.
        if (aborted || timedOut || eventError) terminateProcessTree(child, "SIGKILL");
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (processTimer) clearTimeout(processTimer);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        // Cancellation/deadline during the cleanup join is still authoritative.
        const termination = timedOut
          ? { outcome: "timed_out" as const, exitCode: 1, stopReason: "error" as const, errorMessage: TIMED_OUT_MESSAGE }
          : aborted || signal?.aborted
            ? { outcome: "cancelled" as const, exitCode: 1, stopReason: "aborted" as const, errorMessage: "Subagent aborted." } : {};
        resolve({ ...result, ...termination, stderr: truncateHeadTail(stderr, MAX_STDERR_BYTES), stdout: truncateHeadTail(stdout, MAX_STDERR_BYTES) });
      })();
    };

    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: childEnvironment(childRunId, cwd),
        shell: false,
        // A child gets its own process group; cleanup includes the commands it starts.
        detached: true,
        // The task travels on stdin, so no temporary prompt file can leak.
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      activeChildren.add(child);
      let rootGroupSwept = false;
      const sweepRoot = () => {
        if (rootGroupSwept) return;
        rootGroupSwept = true;
        rootSweepPromise = sweepRootProcessGroup(child);
      };
      // `close` waits for stdio streams; a descendant can keep an inherited
      // pipe open after the leader exits. Sweep on `exit` first so that child
      // cannot defer cleanup until the hard timeout.
      child.once("exit", sweepRoot);
      child.once("close", sweepRoot);
      watchdog = spawnDeathWatchdog(child);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({ exitCode: 1, stopReason: "error", outcome: "failed", errorMessage: message, stderr });
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
    const deliverLine = (line: string, oversized = false) => {
      if (settled || eventError) return;
      try {
        if (oversized) throw new Error("Oversized child protocol frame.");
        onEvent(parseChildEvent(line));
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

    // The child may exit before it drains the prompt; an EPIPE here is already
    // reflected by the close/exit handling below.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(bootstrap));

    const consumeProtocolText = (text: string) => {
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
            // A dedicated protocol pipe cannot legitimately contain oversized noise.
            deliverLine("", true);
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
          deliverLine(trailing + segment);
        } else {
          deliverLine("", true);
        }
        trailing = "";
        cursor = newline + 1;
      }
    };

    (child.stdio[3] as Readable).on("data", (chunk: Buffer | string) => {
      consumeProtocolText(decoder.write(chunk));
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = capStderr(stdout, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = capStderr(stderr, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      activeChildren.delete(child);
      const message = error instanceof Error ? error.message : String(error);
      if (timedOut) {
        finish({ exitCode: 1, stopReason: "error", outcome: "timed_out", errorMessage: TIMED_OUT_MESSAGE, stderr });
      } else if (aborted) {
        finish({ exitCode: 1, stopReason: "aborted", outcome: "cancelled", errorMessage: "Subagent aborted.", stderr });
      } else {
        finish({ exitCode: 1, stopReason: "error", outcome: "failed", errorMessage: eventError ? `Subagent event handling failed: ${eventError}` : message, stderr });
      }
    });
    child.on("close", (code) => {
      activeChildren.delete(child);
      const finalText = decoder.end();
      if (finalText && !discardingLine) consumeProtocolText(finalText);
      if (trailing.trim() && !discardingLine && Buffer.byteLength(trailing, "utf8") <= MAX_PROTOCOL_LINE_BYTES) {
        deliverLine(trailing);
      }
      if (timedOut) {
        finish({ exitCode: 1, stopReason: "error", outcome: "timed_out", errorMessage: TIMED_OUT_MESSAGE, stderr });
        return;
      }
      if (aborted || signal?.aborted) {
        finish({ exitCode: code ?? 1, stopReason: "aborted", outcome: "cancelled", errorMessage: "Subagent aborted.", stderr });
        return;
      }
      if (eventError) {
        finish({ exitCode: 1, stopReason: "error", outcome: "failed", errorMessage: `Subagent event handling failed: ${eventError}`, stderr });
        return;
      }
      const exitCode = code ?? 1;
      let errorMessage: string | undefined;
      if (exitCode !== 0) {
        const cleanStderr = stderr.trim();
        if (cleanStderr) {
          errorMessage = `Subagent exited with code ${exitCode}.\n${truncateHeadTail(cleanStderr, 2048)}`;
          if (/No API key|No models match pattern|API key.*not found/i.test(cleanStderr)) {
            errorMessage += `\n\nHint: Child env passes model refs and *_API_KEY/*_TOKEN credentials automatically. For non-credential variables, set PI_SUBAGENT_PASSTHROUGH_ENV with an exact name or glob and restart Pi. Auth in ~/.pi/agent/auth.json via /login needs no passthrough.`;
          }
        } else {
          errorMessage = `Subagent exited with code ${exitCode}.`;
        }
      }
      finish({ exitCode, stderr, stopReason: exitCode === 0 ? undefined : "error", outcome: exitCode === 0 ? "completed" : "failed", errorMessage });
    });

    if (signal?.aborted) stopForAbort();
  });
}
