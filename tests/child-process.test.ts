import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { SubprocessChildSupervisor, type ChildTask } from "../extensions/pi-subagents/supervisor.ts";
import { emptyUsage } from "../extensions/pi-subagents/types.ts";
import { getChildInvocation } from "../extensions/pi-subagents/subprocess.ts";

async function fixture(script: string, callback: (task: ChildTask, supervisor: SubprocessChildSupervisor) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "child-protocol-process-"));
  const oldRunner = process.env.PI_SUBAGENT_RUNNER;
  const oldTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
  const file = join(dir, "runner.mjs");
  writeFileSync(file, `import { writeSync, writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    let input=''; for await (const chunk of process.stdin) input += chunk;
    const request=JSON.parse(input);
    const send = value => writeSync(3, JSON.stringify({version:2,...value})+'\\n');
    send({kind:'ready',model:request.model,thinking:'off',tools:request.tools});
    ${script}`);
  process.env.PI_SUBAGENT_RUNNER = file;
  process.env.PI_SUBAGENT_TIMEOUT_MS = "10000";
  const task: ChildTask = { id: "test", prompt: "task", cwd: dir, tools: [], model: "fixture/model" };
  try { await callback(task, new SubprocessChildSupervisor()); }
  finally {
    if (oldRunner === undefined) delete process.env.PI_SUBAGENT_RUNNER; else process.env.PI_SUBAGENT_RUNNER = oldRunner;
    if (oldTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS; else process.env.PI_SUBAGENT_TIMEOUT_MS = oldTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")("hard parent death kills a real protocol child even without shell utilities on PATH", async () => {
  await fixture(`writeFileSync('pid',String(process.pid)); setInterval(()=>{},1000);`, async (task) => {
    const source = resolve(import.meta.dir, "../extensions/pi-subagents/supervisor.ts");
    const entry = join(task.cwd, "parent.ts");
    writeFileSync(entry, `import { SubprocessChildSupervisor } from ${JSON.stringify(source)};
      await new SubprocessChildSupervisor().run({task:${JSON.stringify(task)},signal:new AbortController().signal});`);
    symlinkSync(getChildInvocation().command, join(task.cwd, "node"));
    const parent = spawn(process.execPath, [entry], { cwd: task.cwd, env: { ...process.env, PATH: task.cwd }, stdio: "ignore" });
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (!pid && Date.now() < deadline) {
        try { pid = Number(readFileSync(join(task.cwd, "pid"), "utf8")) || undefined; } catch { /* startup */ }
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

test.each(["empty error", "duplicate result"])("terminal protocol frames cannot be overwritten: %s", async (scenario) => {
  const report = { output: "answer", stopReason: "stop", outputTruncation: { truncated: false, originalBytes: 6, retainedBytes: 6 } };
  const resultFrame = `send(${JSON.stringify({ kind: "result", report, usage: emptyUsage() })});`;
  await fixture((scenario === "empty error" ? `send({kind:"error",errorMessage:""});` : resultFrame) + resultFrame, async (task, supervisor) => {
    expect((await supervisor.run({ task, signal: new AbortController().signal })).outcome).toBe("failed");
  });
});

test("progress consumers cannot change the supervisor's report or accounting", async () => {
  const usage = { ...emptyUsage(), input: 3, cost: { ...emptyUsage().cost, total: 1 } };
  const report = { output: "answer", stopReason: "stop", outputTruncation: { truncated: false, originalBytes: 6, retainedBytes: 6 } };
  await fixture(`send(${JSON.stringify({ kind: "result", report, usage })});`, async (task, supervisor) => {
    const execution = await supervisor.run({
      task, signal: new AbortController().signal,
      onUpdate(data) {
        data.model = "rewritten/model";
        data.output = "rewritten";
        data.usage.input = 999;
        data.usage.cost.total = 999;
        if (data.outputTruncation) data.outputTruncation.retainedBytes = 0;
      },
    });
    expect(execution).toMatchObject({
      outcome: "completed", model: "fixture/model", thinking: "off", output: "answer",
      outputTruncation: { truncated: false, originalBytes: 6, retainedBytes: 6 },
      usage: { input: 3, cost: { total: 1 } },
    });
    expect(task.model).toBe("fixture/model");
  });
});

test.skipIf(process.platform === "win32")("watchdog startup failure stops the child before releasing the task", async () => {
  await fixture(`writeFileSync('task-received','yes');`, async (task, supervisor) => {
    const node = getChildInvocation().command;
    const wrapper = join(task.cwd, "node");
    writeFileSync(wrapper, `#!${node}
import {spawn} from 'node:child_process';
if(process.argv[2].endsWith('death-watchdog.mjs')) process.exit(1);
const child=spawn(${JSON.stringify(node)},process.argv.slice(2),{stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));
`);
    chmodSync(wrapper, 0o755);
    const path = process.env.PATH;
    process.env.PATH = task.cwd;
    try {
      const outcome = await supervisor.run({ task, signal: new AbortController().signal });
      expect(outcome.outcome).toBe("failed");
      expect(outcome.errorMessage).toContain("watchdog failed");
      expect(existsSync(join(task.cwd, "task-received"))).toBe(false);
    } finally { process.env.PATH = path; }
  });
});

const failure = `send({kind:'error',errorMessage:'earlier assistant failure'}); setInterval(()=>{},1000);`;
test("process timeout outranks earlier protocol error", async () => {
  await fixture(failure, async (task, supervisor) => {
    process.env.PI_SUBAGENT_TIMEOUT_MS = "200";
    const outcome = await supervisor.run({ task, signal: new AbortController().signal });
    expect(outcome.outcome).toBe("timed_out");
  });
});
test("process cancellation outranks earlier protocol error", async () => {
  await fixture(failure, async (task, supervisor) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try { expect((await supervisor.run({ task, signal: controller.signal })).outcome).toBe("cancelled"); }
    finally { clearTimeout(timer); }
  });
});
test("oversized protocol frame fails closed while stdout JSON stays diagnostic", async () => {
  await fixture(`console.log(JSON.stringify({version:2,kind:'error',errorMessage:'stdout spoof'}));
    writeSync(3,'X'.repeat(1100000)); setInterval(()=>{},1000);`, async (task, supervisor) => {
    const outcome = await supervisor.run({ task, signal: new AbortController().signal });
    expect(outcome.outcome).toBe("failed");
    expect(outcome.errorMessage).toContain("event handling failed");
    expect(outcome.stdout).toContain("stdout spoof");
  });
});
test.skipIf(process.platform === "win32")("normal leader exit sweeps surviving descendants before returning", async () => {
  await fixture(`const child=spawn('sh',['-c','sleep 30'],{stdio:'ignore'});
    writeFileSync('pid',String(child.pid)); child.unref();`, async (task, supervisor) => {
    await supervisor.run({ task, signal: new AbortController().signal });
    const pid = Number(readFileSync(join(task.cwd, "pid"), "utf8"));
    try { expect(() => process.kill(pid, 0)).toThrow(); }
    finally { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  });
});
