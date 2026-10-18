import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireSession, canonicalSession } from "../extensions/pi-subagents/launch.ts";

const dirs: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-lease-"));
  dirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", cwd: dir }));
  return { dir, file };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("session ownership excludes another process and releases idempotently", async () => {
  const { file } = fixture();
  const release = acquireSession(file, "first");
  try {
    const entry = path.resolve(import.meta.dir, "../extensions/pi-subagents/launch.ts");
    const child = Bun.spawn([process.execPath, "--eval", `import { acquireSession } from ${JSON.stringify(entry)}; try { acquireSession(${JSON.stringify(file)}, 'second'); process.exit(1); } catch (e) { console.log(e.message); }`], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain("already owned");
  } finally { release(); }
  release();
  const again = acquireSession(file, "third");
  again();
});

test.skipIf(process.platform === "win32")("symlink aliases share one lease, including a not-yet-created persisted session", () => {
  const { dir, file } = fixture();
  fs.symlinkSync(file, path.join(dir, "alias.jsonl"));
  const release = acquireSession(file, "first");
  try { expect(() => acquireSession(path.join(dir, "alias.jsonl"), "second")).toThrow("already owned"); }
  finally { release(); }
  fs.symlinkSync(dir, path.join(dir, "alias-directory"));
  const fresh = path.join(dir, "fresh.jsonl");
  const freshRelease = acquireSession(fresh, "fresh");
  try { expect(() => acquireSession(path.join(dir, "alias-directory", "fresh.jsonl"), "second")).toThrow("already owned"); }
  finally { freshRelease(); }
});

test("orphaned leases fail closed instead of expiring while an old child may still write", () => {
  const { file } = fixture();
  fs.writeFileSync(`${canonicalSession(file)}.subagent-lock`, JSON.stringify({ parentPid: 0, runId: "old" }));
  expect(() => acquireSession(file, "new")).toThrow("verify the old child has stopped");
});

test.skipIf(process.platform === "win32")("FIFO resume paths are rejected without blocking the parent event loop", async () => {
  const { dir } = fixture();
  const fifo = path.join(dir, "session.fifo");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const entry = path.resolve(import.meta.dir, "../extensions/pi-subagents/launch.ts");
  const task = { id: "fifo", prompt: "x", cwd: dir, tools: [], resume: fifo };
  // Isolate the regression: a blocking open must not freeze the test runner.
  const probe = Bun.spawn([process.execPath, "--eval", `import { getRpcInvocation } from ${JSON.stringify(entry)}; try { getRpcInvocation(${JSON.stringify(task)}); process.exit(1); } catch (e) { console.log(e.message); }`], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => probe.kill("SIGKILL"), 3000);
  try {
    expect(await probe.exited).toBe(0);
    expect(await new Response(probe.stdout).text()).toContain("regular file");
  } finally { clearTimeout(timer); probe.kill("SIGKILL"); }
}, 5000);
