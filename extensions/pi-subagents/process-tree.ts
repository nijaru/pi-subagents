import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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
 * Keep the first descendant snapshot until the SIGKILL escalation. A process
 * can exit after SIGTERM while its descendants become reparented, so a
 * later `ps` snapshot rooted at the leader would otherwise miss them.
 */
const terminatedProcessDescendants = new WeakMap<ChildProcess, Set<number>>();

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

/**
 * Spawn a detached watchdog connected to a parent-owned private pipe.
 *
 * The pipe closes however the parent dies, including SIGKILL, and the watchdog
 * then terminates the child's process group. That is the only way a hard parent
 * crash cannot leave a mutating child behind, since no exit handler runs on
 * SIGKILL. Windows needs a native job object for the same effect, so it keeps
 * the graceful-shutdown-only guarantee.
 */
export async function spawnDeathWatchdog(child: ChildProcess, command: string): Promise<ChildProcess | undefined> {
  if (process.platform === "win32" || !child.pid) return undefined;
  const watchdog = spawn(command, [fileURLToPath(new URL("./death-watchdog.mjs", import.meta.url)), String(child.pid)], {
    stdio: ["pipe", "pipe", "ignore"], detached: true, env: {},
  });
  watchdog.stdin?.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const stdout = watchdog.stdout!;
      let ready = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watchdog.off("error", fail);
        watchdog.off("exit", exited);
        stdout.off("data", data);
        stdout.off("end", ended);
        stdout.off("error", fail);
        if (error) reject(error); else resolve();
      };
      const fail = (error: Error) => finish(error);
      const exited = () => finish(new Error("Watchdog exited before readiness."));
      const data = (chunk: Buffer) => {
        ready += chunk.toString();
        if (ready.length > 16) finish(new Error("Invalid watchdog readiness."));
      };
      const ended = () => ready === "ready\n" ? finish() : exited();
      const timer = setTimeout(() => finish(new Error("Watchdog readiness timed out.")), 5000);
      watchdog.once("error", fail);
      watchdog.once("exit", exited);
      stdout.on("data", data);
      stdout.once("end", ended);
      stdout.once("error", fail);
    });
    watchdog.on("error", () => {});
    watchdog.stdout?.destroy();
    // Cleanup alone must never keep the parent's event loop alive.
    watchdog.unref();
    return watchdog;
  } catch (error) {
    watchdog.stdin?.end();
    watchdog.kill("SIGKILL");
    throw error;
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
