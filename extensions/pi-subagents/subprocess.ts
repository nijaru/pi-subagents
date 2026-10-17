import { spawn, type ChildProcess } from "node:child_process";
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
import { appendDiagnostic, truncateHeadTail } from "./bounds.ts";
import { timeoutSummary, withCredentialHint } from "./reports.ts";
import { spawnDeathWatchdog, sweepRootProcessGroup, terminateProcessTree } from "./process-tree.ts";
import { childEnvironment } from "./env.ts";

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
  const command = /^node(\.exe)?$/.test(runtime) ? process.execPath : findOnPath(process.platform === "win32" ? "node.exe" : "node");
  if (!command) throw new Error("Child SDK runner requires Node.js on PATH.");
  const sdk = path.join(getPackageDir(), "dist", "index.js");
  if (!fs.existsSync(sdk)) throw new Error("Child runner requires an installed Pi SDK (dist/index.js); standalone Pi binaries are not supported.");
  const runner = process.env.PI_SUBAGENT_RUNNER
    ? path.resolve(process.env.PI_SUBAGENT_RUNNER)
    : fileURLToPath(new URL("./child-bootstrap.mjs", import.meta.url));
  return { command: fs.realpathSync.native(command), args: [runner, sdk] };
}

/** Bound the cleanup join so escaped descendants cannot prevent settlement. */
const CLEANUP_SETTLE_MS = 6_000;
/** Absolute settlement deadline after a timeout/abort stops the process tree. */
const FORCE_SETTLE_MS = 7_000;
/** A child that reported a terminal result still gets time to exit on its own. */
const TERMINAL_EXIT_GRACE_MS = 5_000;

export interface ProcessResult {
  exitCode: number;
  stopReason?: StopReason;
  outcome: AgentOutcome;
  errorMessage?: string;
  stderr: string;
  stdout?: string;
}

export interface PiProcessRequest {
  bootstrap: ChildBootstrap;
  cwd: string;
  childRunId: string;
  /** Execution deadline; the process timer below is its only owner. */
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent: (event: ChildEvent) => void;
}

export async function runPiProcess(request: PiProcessRequest): Promise<ProcessResult> {
  const { bootstrap, cwd, childRunId, timeoutMs, signal, onEvent } = request;
  if (signal?.aborted) return { exitCode: 1, stopReason: "aborted", outcome: "cancelled", errorMessage: "Subagent aborted.", stderr: "" };

  const startedAt = Date.now();
  const invocation = getChildInvocation();
  return new Promise((resolve) => {
    let settled = false;
    let finishing = false;
    let rootSweepPromise: Promise<void> | undefined;
    let aborted = false;
    let stderr = "";
    let stdout = "";
    let trailing = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let processTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let terminalSeen = false;
    let processFailure: string | undefined;
    let finishedAt: number | undefined;
    let lastResult: ProcessResult | undefined;
    let watchdog: ChildProcess | undefined;
    let watchdogSetup: Promise<void> | undefined;
    const decoder = new StringDecoder("utf8");
    let abortHandler: (() => void) | undefined;

    const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => {
      const timer = setTimeout(resolveDelay, ms);
      timer.unref?.();
    });

    // Cancellation and deadline remain authoritative even after a completed
    // report; cleanup must never turn a finished task into a timeout.
    const termination = (): Partial<ProcessResult> => timedOut
      ? { outcome: "timed_out", exitCode: 1, stopReason: "error", errorMessage: timeoutSummary((finishedAt ?? Date.now()) - startedAt, timeoutMs) }
      : aborted || signal?.aborted
        ? { outcome: "cancelled", exitCode: 1, stopReason: "aborted", errorMessage: "Subagent aborted." }
        : processFailure
          ? { outcome: "failed", exitCode: 1, stopReason: "error", errorMessage: processFailure }
          : {};

    const settleNow = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      // Force settlement can bypass finish(); never leave the watchdog pipe open
      // for the rest of the parent session.
      watchdog?.stdin?.end();
      if (killTimer) clearTimeout(killTimer);
      if (processTimer) clearTimeout(processTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      resolve({
        ...result,
        ...termination(),
        stderr: truncateHeadTail(stderr, MAX_STDERR_BYTES),
        stdout: truncateHeadTail(stdout, MAX_STDERR_BYTES),
      });
    };

    const finish = (result: ProcessResult) => {
      if (settled || finishing) return;
      finishing = true;
      lastResult = result;
      // Release the death watchdog: the child is already exiting, and its pipe
      // must not stay open once this run is accounted for.
      watchdog?.stdin?.end();
      void (async () => {
        // A background run must not release mutation ownership while a
        // descendant from its detached root group can still be alive. Bound the
        // join: a leader that handed its pipes to an escaped descendant may
        // never emit `close`, which must not keep the run unsettled forever.
        await Promise.race([
          (async () => {
            await watchdogSetup;
            watchdog?.stdin?.end();
            if (rootSweepPromise) await rootSweepPromise;
          })(),
          delay(CLEANUP_SETTLE_MS),
        ]);
        // A leader can close before the escalation timer fires while a
        // descendant ignores SIGTERM and does not hold an inherited pipe open.
        // Force the retained tree snapshot before dropping the timer.
        if (aborted || timedOut || processFailure) terminateProcessTree(child, "SIGKILL");
        settleNow(result);
      })();
    };

    const forceSettle = () => {
      if (settled) return;
      settleNow(lastResult ?? {
        exitCode: terminalSeen ? 0 : 1,
        stopReason: terminalSeen ? undefined : "error",
        outcome: terminalSeen ? "completed" : "failed",
        errorMessage: terminalSeen ? undefined : "Subagent process did not exit after termination.",
        stderr,
      });
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
      let rootGroupSwept = false;
      const sweepRoot = () => {
        if (rootGroupSwept) return;
        rootGroupSwept = true;
        rootSweepPromise = sweepRootProcessGroup(child);
      };
      // `close` waits for stdio streams; a descendant can keep an inherited
      // pipe open after the leader exits. Sweep on `exit` first so that child
      // cannot defer cleanup until the hard timeout.
      child.once("exit", () => {
        finishedAt ??= Date.now();
        if (processTimer) clearTimeout(processTimer);
        processTimer = undefined;
        sweepRoot();
      });
      child.once("close", sweepRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({ exitCode: 1, stopReason: "error", outcome: "failed", errorMessage: message, stderr });
      return;
    }

    const stopTree = () => {
      if (settled || killTimer) return;
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) terminateProcessTree(child, "SIGKILL");
      }, 5000);
      killTimer.unref?.();
      // `close` waits for every inherited stdio pipe. A descendant that escaped
      // the process group can keep one open forever, so settlement gets its own
      // deadline independent of pipe EOF.
      forceTimer = setTimeout(forceSettle, FORCE_SETTLE_MS);
      forceTimer.unref?.();
    };
    const stopForAbort = () => { if (!settled) { aborted = true; finishedAt ??= Date.now(); stopTree(); } };
    const stopForTimeout = () => { if (!settled) { timedOut = true; finishedAt ??= Date.now(); stopTree(); } };
    processTimer = setTimeout(stopForTimeout, timeoutMs);
    const deliverLine = (line: string, oversized = false) => {
      if (settled || processFailure) return;
      try {
        if (oversized) throw new Error("Oversized child protocol frame.");
        const event = parseChildEvent(line);
        if (event.kind === "result" || event.kind === "error") {
          terminalSeen = true;
          if (terminalTimer === undefined) {
            terminalTimer = setTimeout(() => {
              if (!settled) {
                terminateProcessTree(child, "SIGKILL");
                forceSettle();
              }
            }, TERMINAL_EXIT_GRACE_MS);
            terminalTimer.unref?.();
          }
        }
        onEvent(event);
      } catch (error) {
        processFailure = `Subagent event handling failed: ${error instanceof Error ? error.message : String(error)}`;
        stopTree();
      }
    };
    abortHandler = stopForAbort;
    if (signal) signal.addEventListener("abort", abortHandler, { once: true });

    // The child may exit before it drains the prompt; an EPIPE here is already
    // reflected by the close/exit handling below.
    child.stdin?.on("error", () => {});
    watchdogSetup = spawnDeathWatchdog(child, invocation.command).then((process) => {
      watchdog = process;
      watchdog?.once("exit", () => {
        if (!finishing && child.exitCode === null && child.signalCode === null) {
          processFailure = "Subagent watchdog exited unexpectedly.";
          stopTree();
        }
      });
      if (settled || finishing || aborted || timedOut || processFailure) watchdog?.stdin?.end();
      else child.stdin?.end(JSON.stringify(bootstrap));
    }).catch((error) => {
      processFailure = `Subagent watchdog failed: ${error instanceof Error ? error.message : String(error)}`;
      stopTree();
    });

    const consumeProtocolText = (text: string) => {
      let cursor = 0;
      while (cursor < text.length && !processFailure && !settled) {
        const newline = text.indexOf("\n", cursor);
        if (newline < 0) {
          const segment = text.slice(cursor);
          if (Buffer.byteLength(trailing, "utf8") + Buffer.byteLength(segment, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
            // A dedicated protocol pipe cannot legitimately contain oversized noise.
            deliverLine("", true);
            trailing = "";
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
      if (!processFailure && !settled) consumeProtocolText(decoder.write(chunk));
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = appendDiagnostic(stdout, chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({ exitCode: 1, stopReason: "error", outcome: "failed", errorMessage: processFailure ?? error.message, stderr });
    });
    child.on("close", (code, signalName) => {
      const finalText = decoder.end();
      if (finalText) consumeProtocolText(finalText);
      if (trailing.trim() && Buffer.byteLength(trailing, "utf8") <= MAX_PROTOCOL_LINE_BYTES) {
        deliverLine(trailing);
      }
      if (processFailure) {
        finish({ exitCode: 1, stopReason: "error", outcome: "failed", errorMessage: withCredentialHint(processFailure), stderr });
        return;
      }
      const exitCode = code ?? 1;
      let errorMessage: string | undefined;
      if (signalName !== null) {
        errorMessage = `Subagent terminated by ${signalName}.`;
      } else if (exitCode !== 0) {
        const cleanStderr = stderr.trim();
        if (cleanStderr) {
          errorMessage = withCredentialHint(`Subagent exited with code ${exitCode}.\n${truncateHeadTail(cleanStderr, 2048)}`);
        } else {
          errorMessage = `Subagent exited with code ${exitCode}.`;
        }
      }
      finish({ exitCode, stderr, stopReason: exitCode === 0 && signalName === null ? undefined : "error", outcome: exitCode === 0 && signalName === null ? "completed" : "failed", errorMessage });
    });

    if (signal?.aborted) stopForAbort();
  });
}
