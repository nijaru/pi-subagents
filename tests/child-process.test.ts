import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { SubprocessChildSupervisor } from "../extensions/pi-subagents/supervisor.ts";
import { emptyUsage, type ChildResult } from "../extensions/pi-subagents/types.ts";

async function fixture(script: string, callback: (result: ChildResult, supervisor: SubprocessChildSupervisor) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "child-protocol-process-"));
  const oldRunner = process.env.PI_SUBAGENT_RUNNER;
  const oldTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
  const file = join(dir, "runner.mjs");
  writeFileSync(file, `import { writeSync, writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    let input=''; for await (const chunk of process.stdin) input += chunk;
    const request=JSON.parse(input);
    const send = value => writeSync(3, JSON.stringify({version:1,...value})+'\\n');
    send({kind:'ready',model:request.model,tools:request.tools});
    ${script}`);
  process.env.PI_SUBAGENT_RUNNER = file;
  process.env.PI_SUBAGENT_TIMEOUT_MS = "10000";
  const result: ChildResult = { id: "test", prompt: "task", cwd: dir, tools: [], model: "fixture/model", state: { status: "running" }, usage: emptyUsage(), stderr: "" };
  try { await callback(result, new SubprocessChildSupervisor()); }
  finally {
    if (oldRunner === undefined) delete process.env.PI_SUBAGENT_RUNNER; else process.env.PI_SUBAGENT_RUNNER = oldRunner;
    if (oldTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS; else process.env.PI_SUBAGENT_TIMEOUT_MS = oldTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("hard parent death kills a real protocol child through the detached watchdog", async () => {
  if (process.platform === "win32") return;
  await fixture(`writeFileSync('pid',String(process.pid)); setInterval(()=>{},1000);`, async (result) => {
    const source = resolve(import.meta.dir, "../extensions/pi-subagents/supervisor.ts");
    const entry = join(result.cwd, "parent.ts");
    writeFileSync(entry, `import { SubprocessChildSupervisor } from ${JSON.stringify(source)};
      await new SubprocessChildSupervisor().run({result:${JSON.stringify(result)},signal:new AbortController().signal});`);
    const parent = spawn(process.execPath, [entry], { cwd: result.cwd, env: process.env, stdio: "ignore" });
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (!pid && Date.now() < deadline) {
        try { pid = Number(readFileSync(join(result.cwd, "pid"), "utf8")) || undefined; } catch { /* startup */ }
        if (!pid) await Bun.sleep(25);
      }
      expect(pid).toBeDefined();
      parent.kill("SIGKILL");
      const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };
      const stopped = Date.now() + 8000;
      while (alive() && Date.now() < stopped) await Bun.sleep(25);
      expect(alive()).toBe(false);
    } finally {
      parent.kill("SIGKILL");
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  });
}, 15000);

const failure = `send({kind:'error',errorMessage:'earlier assistant failure'}); setInterval(()=>{},1000);`;
test("process timeout outranks earlier protocol error", async () => {
  await fixture(failure, async (result, supervisor) => {
    process.env.PI_SUBAGENT_TIMEOUT_MS = "200";
    const outcome = await supervisor.run({ result, signal: new AbortController().signal });
    expect(outcome.outcome).toBe("timed_out");
  });
});
test("process cancellation outranks earlier protocol error", async () => {
  await fixture(failure, async (result, supervisor) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try { expect((await supervisor.run({ result, signal: controller.signal })).outcome).toBe("cancelled"); }
    finally { clearTimeout(timer); }
  });
});
test("oversized protocol frame fails closed while stdout JSON stays diagnostic", async () => {
  await fixture(`console.log(JSON.stringify({version:1,kind:'error',errorMessage:'stdout spoof'}));
    writeSync(3,'X'.repeat(1100000)); setInterval(()=>{},1000);`, async (result, supervisor) => {
    const outcome = await supervisor.run({ result, signal: new AbortController().signal });
    expect(outcome.outcome).toBe("failed");
    expect(outcome.errorMessage).toContain("event handling failed");
    expect(result.stdout).toContain("stdout spoof");
  });
});
test("normal leader exit sweeps surviving descendants before returning", async () => {
  if (process.platform === "win32") return;
  await fixture(`const child=spawn('sh',['-c','sleep 30'],{stdio:'ignore'});
    writeFileSync('pid',String(child.pid)); child.unref();`, async (result, supervisor) => {
    await supervisor.run({ result, signal: new AbortController().signal });
    const pid = Number(readFileSync(join(result.cwd, "pid"), "utf8"));
    try { expect(() => process.kill(pid, 0)).toThrow(); }
    finally { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  });
});
