import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { getRpcInvocation } from "../extensions/pi-subagents/launch.ts";
import { cleanupChild, hasExited, spawnDeathWatchdog } from "../extensions/pi-subagents/process-tree.ts";

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
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
