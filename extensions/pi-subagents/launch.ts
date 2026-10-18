import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import type { ChildTask } from "./supervisor.ts";

export function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync.native(candidate);
      }
    } catch { /* Keep searching. */ }
  }
  return undefined;
}

function nodeRuntime(): string {
  if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath;
  const node = findOnPath(process.platform === "win32" ? "node.exe" : "node");
  if (!node) throw new Error("Child RPC host requires Node.js on PATH.");
  return node;
}

/** Canonicalize existing files and the directory of a not-yet-created session. */
export function canonicalSession(file: string): string {
  const absolute = path.resolve(file);
  try { return fs.realpathSync.native(absolute); } catch {
    return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
  }
}

function sessionCwd(file: string): string | undefined {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.toString("utf8", 0, length).split("\n", 1)[0] ?? "");
    return header?.type === "session" && typeof header.cwd === "string" ? header.cwd : undefined;
  } catch { return undefined; }
  finally { fs.closeSync(fd); }
}

export interface RpcInvocation {
  command: string;
  args: string[];
  sessionFile?: string;
  probe: boolean;
}

export function getRpcInvocation(task: ChildTask): RpcInvocation {
  const cli = process.env.PI_SUBAGENT_CLI
    ? path.resolve(process.env.PI_SUBAGENT_CLI)
    : path.join(getPackageDir(), "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error("Child RPC host requires an installed Pi CLI (dist/cli.js).");
  const args = [cli, "--mode", "rpc"];
  const probe = !process.env.PI_SUBAGENT_CLI || process.env.PI_SUBAGENT_FORCE_PROBE === "1";
  if (probe) args.push("--extension", fileURLToPath(new URL("./probe-extension.ts", import.meta.url)));
  let sessionFile: string | undefined;
  if (task.resume !== undefined) {
    if (!fs.existsSync(task.resume)) throw new Error(`Child session to resume does not exist: ${task.resume}`);
    sessionFile = canonicalSession(task.resume);
    const savedCwd = sessionCwd(sessionFile);
    if (!savedCwd) throw new Error(`Cannot verify the workspace of session ${sessionFile}.`);
    if (fs.realpathSync.native(savedCwd) !== fs.realpathSync.native(task.cwd)) {
      throw new Error(`Session workspace ${savedCwd} does not match requested cwd ${task.cwd}; resume in its original directory or start a new session.`);
    }
  } else if (task.persist) {
    const root = process.env.PI_SUBAGENT_SESSION_DIR
      ? path.resolve(process.env.PI_SUBAGENT_SESSION_DIR)
      : path.join(getAgentDir(), "subagents", "sessions");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    sessionFile = canonicalSession(path.join(root, `${task.id}.jsonl`));
  }
  if (sessionFile) args.push("--session", sessionFile);
  else args.push("--no-session");
  args.push("--name", task.id);
  if (task.tools.length) args.push("--tools", task.tools.join(","));
  else args.push("--no-tools");
  if (task.excludeTools?.length) args.push("--exclude-tools", task.excludeTools.join(","));
  if (task.model) args.push("--model", task.model);
  if (task.thinking) args.push("--thinking", task.thinking);
  if (task.trustProject) args.push("--approve");
  return { command: nodeRuntime(), args, sessionFile, probe };
}

/**
 * Cooperative, fail-closed ownership across subagent parents. Never expire a
 * lease on a timer or reclaim it by PID: a crashed parent can leave a child
 * briefly alive, and PIDs can be reused. Recovery is explicit after checking
 * that the old child is gone. Ordinary Pi sessions do not honor this lock.
 */
export function acquireSession(file: string, runId: string): () => void {
  const lock = `${canonicalSession(file)}.subagent-lock`;
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Child session is already owned: ${file}. Lock: ${lock}. If its parent crashed, verify the old child has stopped before removing the lock.`);
  }
  try { fs.writeFileSync(fd, JSON.stringify({ parentPid: process.pid, runId })); }
  catch (error) { fs.unlinkSync(lock); throw error; }
  finally { fs.closeSync(fd); }
  let released = false;
  return () => {
    if (released) return;
    fs.unlinkSync(lock);
    released = true;
  };
}
