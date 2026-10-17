import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { getRpcInvocation } from "../extensions/pi-subagents/supervisor.ts";
import { spawnDeathWatchdog } from "../extensions/pi-subagents/process-tree.ts";

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
