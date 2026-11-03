import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { cleanupChild, spawnDeathWatchdog } from "../extensions/pi-subagents/process-tree.ts";
import * as os from "node:os";
import * as path from "node:path";
import { getRpcInvocation } from "../extensions/pi-subagents/launch.ts";
import { runChild, type ExecutionUpdate, type ExecutionControl } from "./fixtures/run-child.ts";
import type { ChildTask } from "../extensions/pi-subagents/execution.ts";

const directories: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-child-test-"));
  directories.push(dir);
  return dir;
}
function task(cwd: string, extra: Partial<ChildTask> = {}): ChildTask {
  return { id: "run-1", prompt: "inspect", cwd, tools: ["read"], model: "fixture/model", thinking: "high", persist: false, ...extra };
}
function run(task: ChildTask, signal = new AbortController().signal, onUpdate?: any, onControl?: (control: ExecutionControl) => void) {
  return runChild({ task, signal, onUpdate, onReady: onControl });
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

  test("establishes requested model and effort after startup drift", async () => {
    const result = await run(task(tempDir(), { id: "config-drift", thinking: "low", strictThinking: true }));
    expect(result).toMatchObject({ outcome: "completed", model: "fixture/model", thinking: "low" });
  });

  test.each([
    ["config-locked", "low", "does not match requested low"],
    ["unsupported-effort", "xhigh", "does not support thinking xhigh"],
  ] as const)("rejects %s before submitting model work", async (id, thinking, error) => {
    const dir = tempDir();
    const result = await run(task(dir, { id, thinking, strictThinking: true }));
    expect(result).toMatchObject({ outcome: "failed", errorKind: "startup" });
    expect(result.errorMessage).toContain(error);
    expect(fs.existsSync(path.join(dir, ".fake-rpc-prompt"))).toBe(false);
  });

  test("observes thinking and overlapping tool lifecycles without retaining private payloads", async () => {
    const updates: ExecutionUpdate[] = [];
    const progress: string[] = [];
    const result = await run(task(tempDir(), { prompt: "SCENARIO=activity", tools: ["read", "bash"] }), undefined,
      (data: ExecutionUpdate, text?: string) => { updates.push(data); if (text) progress.push(text); });
    const model = updates.find((data) => data.activity === "model")!;
    const thinking = updates.filter((data) => data.activity === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.length).toBeLessThan(32); // Do not publish a snapshot for every token in the burst.
    expect(thinking[0]!.lastActivityAt!).toBeGreaterThan(model.lastActivityAt!);
    expect(thinking.every((data) => !data.output && !data.currentTool)).toBe(true);
    const tools = updates.filter((data) => data.activity === "tool");
    expect(tools.some((data) => data.currentTool === "bash")).toBe(true);
    // The first read remains active after the overlapping read and bash finish.
    expect(tools.at(-1)!.currentTool).toBe("read");
    const afterTools = updates[updates.indexOf(tools.at(-1)!) + 1]!;
    expect(afterTools.activity).toBeUndefined();
    expect(afterTools.currentTool).toBeUndefined();
    expect(updates.some((data) => data.activity === "text")).toBe(true);
    expect(result).toMatchObject({ outcome: "completed", output: "public report", usage: { turns: 2, totalTokens: 18 } });
    expect(result.activity).toBeUndefined();
    expect(result.currentTool).toBeUndefined();
    expect(result.interruption).toBeUndefined();
    expect(result.lastActivityAt).toBe(updates.at(-1)!.lastActivityAt);
    expect(result.lastActivityAt!).toBeLessThanOrEqual(result.taskFinishedAt!);
    // Phase changes remain inspectable without redrawing the UI for each token.
    expect(progress.length).toBeLessThan(5);
    expect(JSON.stringify([updates, result, progress])).not.toContain("PRIVATE_");
  });

  test("interruption freezes overlapping tool counts without lending mutable snapshots", async () => {
    const controller = new AbortController();
    const result = await run(task(tempDir(), { prompt: "SCENARIO=activity", tools: ["read", "bash"] }), controller.signal,
      (data: ExecutionUpdate) => {
        if (data.currentTool === "bash") controller.abort();
        if (data.interruption) data.interruption.activeToolCount = 99;
      });
    expect(result).toMatchObject({ outcome: "cancelled", interruption: { activity: "tool", activeToolCount: 3, currentTool: "bash" } });
    expect(result.activity).toBeUndefined();
    expect(result.currentTool).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  test("warming and cleanup do not hide a stalled tool's last activity", async () => {
    const updates: ExecutionUpdate[] = [];
    const result = await run(task(tempDir(), { prompt: "SCENARIO=activity-hang", executionTimeoutMs: 150 }), undefined,
      (data: ExecutionUpdate) => updates.push(data));
    const tool = updates.find((data) => data.currentTool === "read")!;
    expect(tool.activity).toBe("tool");
    expect(result).toMatchObject({ outcome: "timed_out", timeoutPhase: "execution", lastActivityAt: tool.lastActivityAt });
    expect(result.usage.totalTokens).toBe(18); // Foreground and warmer usage are both billed.
    expect(result.lastActivityAt!).toBeLessThan(result.taskFinishedAt!);
    expect(result.activity).toBeUndefined();
    expect(result.currentTool).toBeUndefined();
    expect(JSON.stringify([updates, result])).not.toContain("PRIVATE_");
  });

  test("observes Pi recovery phases without retaining private retry diagnostics", async () => {
    const updates: ExecutionUpdate[] = [];
    const result = await run(task(tempDir(), { prompt: "SCENARIO=recovery-activity" }), undefined,
      (data: ExecutionUpdate) => updates.push(data));
    expect(updates.map(data => data.activity).filter((activity, index, all) => activity !== all[index - 1]))
      .toEqual(["compaction", "retry", "compaction", undefined, "retry", "model", undefined, "model", "text", undefined]);
    expect(result).toMatchObject({ outcome: "completed", usage: { turns: 1, totalTokens: 18 } });
    expect(result.interruption).toBeUndefined();
    expect(JSON.stringify(updates)).not.toContain("PRIVATE_");
  });

  test("counts background usage and compaction once without adding foreground turns", async () => {
    const result = await run(task(tempDir(), { prompt: "SCENARIO=usage" }));
    expect(result.outcome).toBe("completed");
    expect(result.usage).toMatchObject({
      input: 6, output: 9, cacheRead: 12, cacheWrite: 15, totalTokens: 27,
      cost: { total: 3 }, turns: 1,
    });
  });

  test("saves sessions by default and exposes the effective phase deadline", async () => {
    const sessionDir = path.join(tempDir(), "sessions");
    process.env.PI_SUBAGENT_SESSION_DIR = sessionDir;
    const updates: ExecutionUpdate[] = [];
    const result = await run(task(tempDir(), { persist: undefined, executionTimeoutMs: 1_000, startupTimeoutMs: 2_000 }), undefined,
      (data: ExecutionUpdate) => updates.push(data));
    expect(result.sessionFile).toBe(path.join(fs.realpathSync.native(path.dirname(sessionDir)), "sessions", "run-1.jsonl"));
    const starting = updates.find(data => data.deadline?.phase === "startup")!;
    const running = updates.find(data => data.phase === "running")!;
    expect(starting.deadline!.expiresAt - starting.deadline!.startedAt).toBe(2_000);
    expect(running.deadline!.expiresAt - running.deadline!.startedAt).toBe(1_000);
    expect(result.deadline).toEqual(running.deadline);
    expect(result.deadline!.startedAt).toBeGreaterThanOrEqual(starting.deadline!.startedAt);
    running.deadline!.expiresAt = 0;
    expect(result.deadline!.expiresAt).toBeGreaterThan(0);
  });

  test("keeps persisted sessions when requested", async () => {
    const dir = tempDir();
    const sessionDir = path.join(tempDir(), "sessions");
    process.env.PI_SUBAGENT_SESSION_DIR = sessionDir;
    const result = await run(task(dir, { persist: true }));
    expect(result.outcome).toBe("completed");
    expect(result.sessionFile).toBe(path.join(fs.realpathSync.native(sessionDir), "run-1.jsonl"));
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

  test("reports the environment-resolved execution deadline without extending it on activity", async () => {
    process.env.PI_SUBAGENT_TIMEOUT_MS = "100";
    const result = await run(task(tempDir(), { prompt: "SCENARIO=slow" }));
    expect(result.outcome).toBe("timed_out");
    expect(result.deadline!.expiresAt - result.deadline!.startedAt).toBe(100);
    expect(result.taskFinishedAt).toBeGreaterThanOrEqual(result.deadline!.expiresAt);
  });

  test("times out startup before get_state", async () => {
    const dir = tempDir();
    const result = await run(task(dir, { id: "startup", prompt: "startup", startupTimeoutMs: 50 }));
    expect(result.outcome).toBe("timed_out");
    expect(result.timeoutPhase).toBe("startup");
    expect(result.interruption).toBeUndefined();
  });

  test("classifies provider errors and output limits", async () => {
    const dir = tempDir();
    const failed = await run(task(dir, { prompt: "SCENARIO=fail" }));
    expect(failed).toMatchObject({ outcome: "failed", errorKind: "provider" });
    const incomplete = await run(task(dir, { prompt: "SCENARIO=length" }));
    expect(incomplete).toMatchObject({ outcome: "incomplete", stopReason: "length" });
  });

  test("queues steering through the RPC control", async () => {
    const dir = tempDir();
    let control: ExecutionControl | undefined;
    const pending = run(task(dir, { prompt: "SCENARIO=steer" }), undefined, undefined, (value) => { control = value; });
    while (!control) await Bun.sleep(5);
    await control.steer("focus");
    const steered = await pending;
    expect(steered.output).toBe("waiting for steer\n\nsteered: Steering instruction:\n\nfocus");
    expect(steered.outcome).toBe("completed");
  });

  test("sweeps descendants before settling a completed task", async () => {
    const dir = tempDir();
    const result = await run(task(dir, { prompt: "SCENARIO=descendant" }));
    expect(result).toMatchObject({ outcome: "completed", cleanup: { status: "confirmed" } });
    const pid = Number(fs.readFileSync(path.join(dir, "descendant.pid"), "utf8"));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(false);
  });

  test.each([["detached-descendant", "timed_out"], ["detached-complete", "completed"]] as const)("cleans detached work after %s", async (scenario, outcome) => {
    const dir = tempDir();
    const result = await run(task(dir, { prompt: `SCENARIO=${scenario}`, executionTimeoutMs: 100 }));
    expect(result.outcome).toBe(outcome);
    const pid = Number(fs.readFileSync(path.join(dir, "detached.pid"), "utf8"));
    try {
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect(alive()).toBe(false);
    } finally { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
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
  fs.writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "existing", cwd: dir })}\n`);
  const invocation = getRpcInvocation(task(dir, { resume: session, trustProject: true }));
  expect(invocation.sessionFile).toBe(fs.realpathSync.native(session));
  expect(invocation.args).toContain("--session");
  expect(invocation.args).toContain("--approve");
  expect(invocation.args).not.toContain("--no-session");
});

test("wraps the task prompt so leading slash commands stay literal", async () => {
  const dir = tempDir();
  const result = await run(task(dir, { prompt: "/capture hello" }));
  expect(result.outcome).toBe("completed");
  expect(fs.readFileSync(path.join(fs.realpathSync.native(dir), ".fake-rpc-prompt"), "utf8")).toBe("Task:\n\n/capture hello");
});

test.each([["partial-after", "FIRST\n\nSECOND"], ["partial-thinking", "FIRST"], ["partial-empty", "FIRST"]])("interrupted %s retains earlier work and any open text", async (scenario, expected) => {
  const dir = tempDir();
  const result = await run(task(dir, { prompt: `SCENARIO=${scenario}`, executionTimeoutMs: 100 }));
  expect(result.outcome).toBe("timed_out");
  expect(result.output).toBe(expected);
});

test("missing terminal assistant content fails instead of hanging cleanup", async () => {
  const result = await run(task(tempDir(), { prompt: "SCENARIO=malformed", executionTimeoutMs: 1_000 }));
  expect(result).toMatchObject({ outcome: "failed", errorKind: "protocol" });
}, 2_000);

test("non-fatal child extension errors are retained as diagnostics", async () => {
  const dir = tempDir();
  const result = await run(task(dir, { prompt: "SCENARIO=extension-error" }));
  expect(result.outcome).toBe("completed");
  expect(result.stderr).toContain("hook boom");
});

test("passes explicit nested-tool exclusions to the child CLI", () => {
  const invocation = getRpcInvocation(task(process.cwd(), {
    excludeTools: ["mcp__*", "list_mcp_resources", "read_mcp_resource"],
  }));
  const index = invocation.args.indexOf("--exclude-tools");
  expect(index).toBeGreaterThan(-1);
  expect(invocation.args[index + 1]).toBe("mcp__*,list_mcp_resources,read_mcp_resource");
});

test("fails before prompting when the probe command is unavailable", async () => {
  const dir = tempDir();
  const result = await run(task(dir, { id: "no-probe", prompt: "must not run" }));
  expect(result.outcome).toBe("failed");
  expect(result.errorKind).toBe("startup");
  expect(result.errorMessage).toContain("probe extension is unavailable");
  expect(fs.existsSync(path.join(fs.realpathSync.native(dir), ".fake-rpc-prompt"))).toBe(false);
});

test.each([
  { prompt: "inspect", taskOutcome: "completed", outcome: "failed", errorKind: "cleanup" },
  { prompt: "SCENARIO=slow", taskOutcome: "timed_out", outcome: "timed_out", errorKind: "deadline", executionTimeoutMs: 100 },
  { prompt: "SCENARIO=fail", taskOutcome: "failed", outcome: "failed", errorKind: "provider" },
] as const)("unconfirmed cleanup retains the lease and original $taskOutcome cause after leader exit", async (options) => {
  const dir = tempDir();
  const session = path.join(dir, "owned.jsonl");
  fs.writeFileSync(session, `${JSON.stringify({ type: "session", cwd: dir })}\n`);
  const result = await runChild({ task: task(dir, { resume: session, ...options }) }, {
    spawn, watchdog: spawnDeathWatchdog,
    async cleanup(...args) {
      const actual = await cleanupChild(...args);
      expect(actual).toEqual({ leaderExited: true, error: undefined });
      return { ...actual, error: "Injected cleanup uncertainty after real resource cleanup" };
    },
  });
  expect(result).toMatchObject({
    outcome: options.outcome, errorKind: options.errorKind,
    cleanup: { status: "unconfirmed", taskOutcome: options.taskOutcome },
  });
  if (options.taskOutcome === "timed_out") expect(result.errorMessage).toContain("Subagent timed out during execution");
  if (options.taskOutcome === "failed") expect(result.errorMessage).toContain("Child provider returned an error.");
  expect(fs.existsSync(`${session}.subagent-lock`)).toBe(true);
  const contender = await run(task(dir, { resume: session }));
  expect(contender).toMatchObject({ outcome: "failed", errorKind: "startup" });
  expect(contender.errorMessage).toContain("already owned");
  // Only this test injected uncertainty after independently confirming cleanup.
  fs.unlinkSync(`${session}.subagent-lock`);
  expect((await run(task(dir, { resume: session }))).outcome).toBe("completed");
});

test("session ownership spans orderly shutdown and is released before returning", async () => {
  const dir = tempDir();
  const session = path.join(dir, "owned.jsonl");
  fs.writeFileSync(session, `${JSON.stringify({ type: "session", cwd: dir })}\n`);
  const stopping = Promise.withResolvers<void>();
  const first = run(task(dir, { resume: session, prompt: "SCENARIO=shutdown" }), undefined,
    (data: { phase: string }) => { if (data.phase === "stopping") stopping.resolve(); });
  try {
    await stopping.promise;
    const contender = await run(task(dir, { resume: session }));
    expect(contender.outcome).toBe("failed");
    expect(contender.errorKind).toBe("startup");
    expect(contender.errorMessage).toContain("already owned");
  } finally { await first; }
  expect(fs.existsSync(path.join(dir, "shutdown.done"))).toBe(true);
  expect((await run(task(dir, { resume: session }))).outcome).toBe("completed");
});

test.each([
  { id: "startup", startupTimeoutMs: 80 },
  { id: "failed", prompt: "SCENARIO=fail" },
  { id: "deadline", prompt: "SCENARIO=slow", executionTimeoutMs: 100 },
])("failed child $id releases session ownership after cleanup", async (options) => {
  const dir = tempDir();
  const session = path.join(dir, "owned.jsonl");
  fs.writeFileSync(session, `${JSON.stringify({ type: "session", cwd: dir })}\n`);
  const result = await run(task(dir, { resume: session, ...options }));
  expect(result.outcome).not.toBe("completed");
  expect((await run(task(dir, { resume: session }))).outcome).toBe("completed");
});

test("drains buffered terminal records when the child exits immediately", async () => {
  const result = await run(task(tempDir(), { prompt: "SCENARIO=exit-final" }));
  expect(result.outcome).toBe("completed");
  expect(result.output).toContain("BUFFERED_FINAL");
  expect(result.outputTruncation?.originalBytes).toBe(Buffer.byteLength("BUFFERED_FINAL".repeat(40000)));
});

test("interrupted streams keep truthful byte counts beyond the retained buffer", async () => {
  const result = await run(task(tempDir(), { prompt: "SCENARIO=partial-large", executionTimeoutMs: 200 }));
  const total = Buffer.byteLength("界🙂".repeat(1000)) * 32;
  expect(result.outcome).toBe("timed_out");
  expect(result.outputTruncation).toMatchObject({ truncated: true, originalBytes: total });
  expect(result.outputTruncation?.retainedBytes).toBe(Buffer.byteLength(result.output!));
  expect(result.output).toContain(`of ${total} bytes`);
  expect(result.usage).toMatchObject({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 9, turns: 1 });
});
