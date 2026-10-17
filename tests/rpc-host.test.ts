import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcChildSupervisor, getRpcInvocation, type ChildControl, type ChildTask } from "../extensions/pi-subagents/supervisor.ts";

const directories: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-child-test-"));
  directories.push(dir);
  return dir;
}
function task(cwd: string, extra: Partial<ChildTask> = {}): ChildTask {
  return { id: "run-1", prompt: "inspect", cwd, tools: ["read"], model: "fixture/model", thinking: "high", ...extra };
}
function run(task: ChildTask, signal = new AbortController().signal, onUpdate?: any, onControl?: (control: ChildControl) => void) {
  return new RpcChildSupervisor().run({ task, signal, onUpdate, onControl });
}
const saved = { ...process.env };
beforeEach(() => {
  process.env.PI_SUBAGENT_CLI = path.resolve(import.meta.dir, "fixtures/fake-rpc-cli.mjs");
  delete process.env.PI_SUBAGENT_SESSION_DIR;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("public RPC child host", () => {
  test("runs a task through the Pi RPC protocol and reports usage", async () => {
    const dir = tempDir();
    const result = await run(task(dir, { prompt: "hello" }));
    expect(result.outcome).toBe("completed");
    expect(result.output).toBe("done");
    expect(result.usage).toMatchObject({ input: 2, output: 3, totalTokens: 9, turns: 1 });
    expect(result.model).toBe("fixture/model");
    expect(result.thinking).toBe("high");
    const capture = JSON.parse(fs.readFileSync(path.join(dir, ".fake-rpc-capture.json"), "utf8"));
    expect(capture.args).toContain("--mode");
    expect(capture.args).toContain("rpc");
    expect(capture.args).toContain("--no-session");
    expect(capture.args).toContain("--model");
    expect(capture.args).toContain("fixture/model");
    expect(capture.args).toContain("--tools");
    expect(capture.args).toContain("read");
    expect(capture.cwd).toBe(fs.realpathSync.native(dir));
  });

  test("keeps persisted sessions when requested", async () => {
    const dir = tempDir();
    const sessionDir = path.join(tempDir(), "sessions");
    process.env.PI_SUBAGENT_SESSION_DIR = sessionDir;
    const result = await run(task(dir, { persist: true }));
    expect(result.outcome).toBe("completed");
    expect(result.sessionFile).toBe(path.join(sessionDir, "run-1.jsonl"));
    const capture = JSON.parse(fs.readFileSync(path.join(dir, ".fake-rpc-capture.json"), "utf8"));
    expect(capture.args).toContain("--session");
    expect(capture.args).not.toContain("--no-session");
  });

  test("times out execution and retains partial output", async () => {
    const dir = tempDir();
    const result = await run(task(dir, { prompt: "SCENARIO=slow", executionTimeoutMs: 50 }));
    expect(result.outcome).toBe("timed_out");
    expect(result.timeoutPhase).toBe("execution");
    expect(result.output).toBe("partial");
    expect(result.errorMessage).toContain("Subagent timed out during execution");
  });

  test("times out startup before get_state", async () => {
    const dir = tempDir();
    const result = await run(task(dir, { id: "startup", prompt: "startup", startupTimeoutMs: 50 }));
    expect(result.outcome).toBe("timed_out");
    expect(result.timeoutPhase).toBe("startup");
  });

  test("classifies provider errors and output limits", async () => {
    const dir = tempDir();
    const failed = await run(task(dir, { prompt: "SCENARIO=fail" }));
    expect(failed).toMatchObject({ outcome: "failed", errorKind: "provider" });
    const incomplete = await run(task(dir, { prompt: "SCENARIO=length" }));
    expect(incomplete).toMatchObject({ outcome: "incomplete", stopReason: "length" });
  });

  test("cancels on abort and exposes steering", async () => {
    const dir = tempDir();
    const controller = new AbortController();
    let control: ChildControl | undefined;
    const pending = run(task(dir, { prompt: "SCENARIO=steer" }), controller.signal, undefined, (value) => { control = value; });
    while (!control) await Bun.sleep(5);
    await control.steer("focus");
    const steered = await pending;
    expect(steered.output).toBe("steered: focus");
    expect(steered.outcome).toBe("completed");

    const second = run(task(dir, { prompt: "SCENARIO=slow" }), controller.signal);
    controller.abort();
    expect((await second).outcome).toBe("cancelled");
  });

  test("sweeps descendants before settling a completed task", async () => {
    const dir = tempDir();
    const result = await run(task(dir, { prompt: "SCENARIO=descendant" }));
    expect(result.outcome).toBe("completed");
    const pid = Number(fs.readFileSync(path.join(dir, "descendant.pid"), "utf8"));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 2_000;
    while (alive() && Date.now() < deadline) await Bun.sleep(25);
    expect(alive()).toBe(false);
  });

  test("surfaces process exits and startup failures as failures", async () => {
    const dir = tempDir();
    const result = await run(task(dir, { prompt: "SCENARIO=exit" }));
    expect(result.outcome).toBe("failed");
    expect(result.errorKind).toBe("protocol");
    expect(result.errorMessage).toContain("exited before completion");
  });

  test("invocation uses the selected Pi CLI and exact model/tools", () => {
    const invocation = getRpcInvocation(task(process.cwd(), { tools: [], thinking: "low" }));
    expect(invocation.command).toContain("node");
    expect(invocation.args[0]).toContain("fake-rpc-cli.mjs");
    expect(invocation.args).toContain("--no-tools");
    expect(invocation.args).toContain("--thinking");
    expect(invocation.args).toContain("low");
  });
});

test("aborts a running child and retains partial output", async () => {
  const dir = tempDir();
  const controller = new AbortController();
  let seen = false;
  const pending = run(task(dir, { prompt: "SCENARIO=slow" }), controller.signal, (data: { output?: string }) => { if (data.output) seen = true; });
  for (let i = 0; i < 100 && !seen; i++) await Bun.sleep(5);
  controller.abort();
  const result = await pending;
  expect(result.outcome).toBe("cancelled");
  expect(result.errorKind).toBe("cancelled");
  expect(result.output).toBe("partial");
});

test("aborts during startup without mislabeling it as a timeout", async () => {
  const dir = tempDir();
  const controller = new AbortController();
  const pending = run(task(dir, { id: "startup", prompt: "startup", startupTimeoutMs: 5000 }), controller.signal);
  await Bun.sleep(25);
  controller.abort();
  const result = await pending;
  expect(result.outcome).toBe("cancelled");
  expect(result.timeoutPhase).toBeUndefined();
});

test("resume and trustProject are passed to the child invocation", () => {
  const dir = tempDir();
  const session = path.join(dir, "existing.jsonl");
  fs.writeFileSync(session, "");
  const invocation = getRpcInvocation(task(dir, { resume: session, trustProject: true }));
  expect(invocation.sessionFile).toBe(session);
  expect(invocation.args).toContain("--session");
  expect(invocation.args).toContain("--approve");
  expect(invocation.args).not.toContain("--no-session");
});
