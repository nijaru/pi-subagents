import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { getRpcInvocation } from "../extensions/pi-subagents/launch.ts";
import { cleanupChild, hasExited, spawnDeathWatchdog, sweepRootProcessGroup } from "../extensions/pi-subagents/process-tree.ts";

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

test.skipIf(process.platform === "win32")("watchdog keeps a live child group until the parent pipe closes", async () => {
  const victim = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const pid = victim.pid!;
  const command = getRpcInvocation({ id: "watchdog", prompt: "x", cwd: process.cwd(), tools: [] }).command;
  const watchdog = await spawnDeathWatchdog(victim, command);
  expect(watchdog).toBeDefined();
  try {
    await Bun.sleep(250);
    expect(groupAlive(pid)).toBe(true);
    watchdog!.stdin!.end();
    const deadline = Date.now() + 8_000;
    while (groupAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
    expect(groupAlive(pid)).toBe(false);
  } finally {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    watchdog?.kill("SIGKILL");
  }
}, 15_000);

test.skipIf(process.platform === "win32").each([false, true])("group signal permission errors remain uncertain until absence is confirmed (persistent=%s)", async (persistent) => {
  const pid = 2147483646;
  const original = process.kill;
  const controller = new AbortController();
  let queries = 0;
  process.kill = ((target, signal) => {
    if (target !== -pid) return original(target, signal);
    const code = signal === 0 && ++queries > 1 && !persistent ? "ESRCH" : "EPERM";
    throw Object.assign(new Error(code), { code });
  }) as typeof process.kill;
  const timer = persistent ? setTimeout(() => controller.abort(), 5) : undefined;
  try {
    const child = { pid, exitCode: 0, signalCode: null } as unknown as ChildProcess;
    expect(await sweepRootProcessGroup(child, controller.signal)).toBe(!persistent);
    expect(queries).toBeGreaterThan(0);
  } finally {
    if (timer) clearTimeout(timer);
    process.kill = original;
  }
});

test.skipIf(process.platform === "win32")("leader exit before descendant discovery cannot falsely confirm escaped work", async () => {
  const command = getRpcInvocation({ id: "escaped", prompt: "x", cwd: process.cwd(), tools: [], persist: false }).command;
  const leader = spawn(command, ["-e", `
    const { spawn } = require("node:child_process");
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    process.stdout.write(String(worker.pid), () => process.exit(0));
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  leader.stdout.on("data", (chunk) => { output += chunk; });
  await new Promise<void>((resolve) => leader.once("close", () => resolve()));
  const descendant = Number(output);
  expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
  try {
    const result = await cleanupChild(leader, undefined, true);
    expect(result.leaderExited).toBe(true);
    expect(result.error).toContain("descendant");
    expect(groupAlive(descendant)).toBe(true);
  } finally {
    try { process.kill(-descendant, "SIGKILL"); } catch { /* Already stopped. */ }
    const until = Date.now() + 1000;
    while (groupAlive(descendant) && Date.now() < until) await Bun.sleep(25);
    expect(groupAlive(descendant)).toBe(false);
  }
});

test.skipIf(process.platform === "win32")("the independent cleanup deadline survives orderly shutdown waits", async () => {
  const command = getRpcInvocation({ id: "cleanup", prompt: "x", cwd: process.cwd(), tools: [] }).command;
  const victim = spawn(command, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write('ready');"], {
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  victim.stdin.on("error", () => {});
  await new Promise<void>((resolve) => victim.stdout.once("data", () => resolve()));
  const realSetTimeout = globalThis.setTimeout;
  try {
    // Accelerate only the outer guard, not its shutdown stages. This exercises
    // deadline ownership without making the suite spend 16 seconds waiting.
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 16_000) args[1] = 20;
      return realSetTimeout(...args);
    }) as typeof setTimeout;
    const result = await cleanupChild(victim, undefined, true);
    expect(result.error).toContain("cleanup exceeded");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    try { process.kill(-victim.pid!, "SIGKILL"); } catch { /* already gone */ }
    if (!hasExited(victim)) await new Promise<void>((resolve) => victim.once("exit", () => resolve()));
  }
});
