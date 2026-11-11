import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { SessionChildren, type StartChild } from "../extensions/pi-subagents/children.ts";
import { MAX_DIAGNOSTIC_BYTES, MAX_RETAINED_RUNS } from "../extensions/pi-subagents/limits.ts";
import type { ChildResult } from "../extensions/pi-subagents/types.ts";
import { controlledSupervisor } from "./fixtures/controlled-children.ts";

function controlled(controls?: Parameters<typeof controlledSupervisor>[0]) {
  const fixture = controlledSupervisor(controls);
  const notices: string[] = [];
  const children = new SessionChildren(fixture.supervisor, () => {
    notices.push(...children.unread().map((result) => result.id));
  });
  const start = (options: Partial<StartChild> = {}) => children.start({
    prompt: "bounded task", tools: ["read"], cwd: process.cwd(), ...options,
  });
  return { ...fixture, children, start, notices };
}

function corrupt(result: ChildResult) {
  result.prompt = "rewritten";
  result.cwd = "/rewritten";
  result.tools!.push("write");
  result.output = "rewritten";
  result.lastActivityAt = 999;
  result.activity = "thinking";
  result.currentTool = "write";
  result.usage.input = 999;
  result.usage.cost.total = 999;
  if (result.deadline) result.deadline.expiresAt = 999;
  if (result.interruption) result.interruption.activeToolCount = 999;
  if (result.outputTruncation) result.outputTruncation.retainedBytes = 999;
  if (result.cleanup?.status === "unconfirmed") result.cleanup.taskOutcome = "completed";
  if (result.state.status === "terminal") {
    result.state.outcome = "failed";
    result.state.finishedAt = 0;
  } else result.state = { status: "terminal", outcome: "failed", finishedAt: 0 };
}

describe("session ownership through detached results", () => {
  test("reserves admission before synchronous execution callbacks can reenter", async () => {
    let launches = 0;
    const c = controlled({ onStart() {
      if (++launches < 4) c.start();
      else expect(() => c.start()).toThrow("maximum 4");
    } });
    c.start();
    expect(c.children.list()).toHaveLength(4);
    expect(c.executions).toHaveLength(4);
    await c.children.close();
  });

  test("terminal-looking output or a premature finished snapshot cannot release cleanup admission", async () => {
    const c = controlled();
    const runs = Array.from({ length: 4 }, () => c.start());
    const execution = c.executions[0]!;
    execution.facts.output = "answer arrived before cleanup";
    execution.facts.taskFinishedAt = 2;
    execution.publish("answer ready");
    expect(c.children.get(runs[0]!.id)).toMatchObject({ output: "answer arrived before cleanup", state: { status: "running" } });
    expect(() => c.start()).toThrow("maximum 4");
    execution.snapshotOverride = { status: "finished", report: {
      ...execution.facts, outcome: "completed", finishedAt: 3, cleanup: { status: "confirmed" },
    } };
    expect(c.children.unread()).toEqual([]);
    expect(c.children.takePendingUsage()).toBeUndefined();
    expect(c.children.pruneCollected()).toBe(0);
    expect(() => c.children.resumeTarget(runs[0]!.id)).toThrow("still running");
    expect(() => c.start()).toThrow("maximum 4");
    execution.snapshotOverride = undefined;
    execution.finish();
    await execution.done;
    expect(c.children.get(runs[0]!.id).state).toMatchObject({ status: "terminal", outcome: "completed" });
    c.start();
    await c.children.close();
  });

  test("four collected cleanup-unconfirmed reports retain slots, session provenance, and primary task outcomes", async () => {
    const c = controlled();
    const outcomes = ["completed", "cancelled", "timed_out", "incomplete"] as const;
    const runs = outcomes.map(() => c.start({ persist: true }));
    c.executions[0]!.facts.usage.input = 7;
    const sourceReports = c.executions.map((execution, index) => execution.finish({
      outcome: "failed", errorKind: "cleanup", errorMessage: "descendant still alive",
      sessionFile: `/sessions/child-${index}.jsonl`,
      cleanup: { status: "unconfirmed", error: "descendant still alive", taskOutcome: outcomes[index]! },
    }));
    await Promise.all(c.executions.map((execution) => execution.done));
    for (const source of sourceReports) source.cleanup.status = "confirmed";
    expect(c.children.unread()).toHaveLength(4);
    const reports = await c.children.wait(runs.map((run) => run.id), 1);
    reports.forEach((report, index) => {
      expect(report).toMatchObject({
        state: { status: "terminal", outcome: "failed" }, sessionFile: `/sessions/child-${index}.jsonl`,
        cleanup: { status: "unconfirmed", error: "descendant still alive", taskOutcome: outcomes[index] },
      });
      corrupt(report);
      expect(() => c.children.resumeTarget(runs[index]!.id)).toThrow("cleanup is unconfirmed");
      expect(c.children.get(runs[index]!.id).cleanup).toMatchObject({ taskOutcome: outcomes[index] });
    });
    expect(c.children.unread()).toEqual([]);
    expect(c.children.pruneCollected()).toBe(0);
    expect(() => c.start()).toThrow("maximum 4");
    expect(c.executions).toHaveLength(4);
    expect(c.children.takePendingUsage()?.input).toBe(7);
    expect(c.children.takePendingUsage()).toBeUndefined();
    await c.children.close();
  });

  test("launch inputs and every outward snapshot are isolated from execution and registry state", async () => {
    const c = controlled();
    const options = { prompt: "original task", tools: ["read"], excludeTools: ["write"], cwd: process.cwd(), model: "fixture/model" };
    const run = c.start({ ...options, emit: corrupt });
    options.tools.push("bash");
    options.excludeTools.push("edit");
    options.prompt = "later task";
    const execution = c.executions[0]!;
    expect(execution.task).toMatchObject({ prompt: "original task", tools: ["read"], excludeTools: ["write"], model: "fixture/model" });
    corrupt(run);
    Object.assign(execution.facts, {
      output: "done", lastActivityAt: 10, activity: "tool", currentTool: "read",
      deadline: { phase: "execution", startedAt: 1, expiresAt: 11 },
      interruption: { activity: "tool", activeToolCount: 1, currentTool: "read" },
      outputTruncation: { truncated: false, originalBytes: 4, retainedBytes: 4 },
    });
    execution.facts.usage.input = 5;
    execution.facts.usage.cost.total = 1;
    execution.facts.usage.cacheWrite1h = 2;
    execution.facts.usage.reasoning = 3;
    execution.publish("progress");
    const expected = {
      prompt: "original task", cwd: process.cwd(), tools: ["read"], output: "done",
      state: { status: "running" }, lastActivityAt: 10, activity: "tool", currentTool: "read",
      deadline: { phase: "execution", startedAt: 1, expiresAt: 11 },
      interruption: { activeToolCount: 1 }, outputTruncation: { retainedBytes: 4 },
      usage: { input: 5, cacheWrite1h: 2, reasoning: 3, cost: { total: 1, totalFromProvider: true } },
    };
    const snapshot = c.children.get(run.id);
    expect(snapshot).toMatchObject(expected);
    corrupt(snapshot);
    corrupt(c.children.list()[0]!);
    expect(c.children.get(run.id)).toMatchObject(expected);
    const report = execution.finish();
    await execution.done;
    report.output = "late backend mutation";
    report.usage.input = 999;
    report.usage.cost.total = 999;
    report.deadline!.expiresAt = 999;
    report.interruption!.activeToolCount = 999;
    report.outputTruncation!.retainedBytes = 999;
    const terminal = c.children.get(run.id);
    expect(terminal).toMatchObject({
      ...expected, activity: undefined, currentTool: undefined,
      cleanup: { status: "confirmed" }, state: { status: "terminal", outcome: "completed", finishedAt: 3 },
    });
    corrupt(c.children.unread()[0]!);
    corrupt((await c.children.wait([run.id], 1))[0]!);
    expect(c.children.get(run.id)).toEqual(terminal);
    expect(c.children.takePendingUsage()).toMatchObject(expected.usage);
    await c.children.close();
  });

  test("results expose neither process internals nor synthetic stdout/exit codes and bound retained prompts", async () => {
    const c = controlled();
    const run = c.start({ prompt: "😀".repeat(MAX_DIAGNOSTIC_BYTES) });
    c.executions[0]!.finish();
    await c.executions[0]!.done;
    for (const result of [run, c.children.get(run.id), ...(await c.children.wait([run.id], 1))]) {
      for (const field of ["controller", "control", "promise", "execution", "collected", "stdout", "exitCode"]) {
        expect(Object.hasOwn(result, field)).toBe(false);
      }
      expect(Object.hasOwn(result.state, "exitCode")).toBe(false);
    }
    const result = c.children.get(run.id);
    expect(Buffer.byteLength(result.prompt!)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES);
    expect(result.prompt).toContain("truncated");
    expect(result.prompt).not.toContain("\uFFFD");
    await c.children.close();
  });

  test("stop waits for cleanup, collects only then, and returns independent repeatable reports", async () => {
    const c = controlled({ finishOnCancel: false });
    const run = c.start();
    c.executions[0]!.facts.usage.input = 5;
    const stopping = c.children.stop(run.id);
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(c.children.get(run.id)).toMatchObject({ phase: "stopping", state: { status: "running" } });
    expect(c.children.unread()).toEqual([]);
    expect(c.children.pruneCollected()).toBe(0);
    expect(c.children.takePendingUsage()).toBeUndefined();
    c.executions[0]!.finish({ outcome: "cancelled", stopReason: "aborted" });
    const first = await stopping;
    expect(c.notices).toEqual([]);
    expect(c.children.unread()).toEqual([]);
    corrupt(first);
    expect(await c.children.stop(run.id)).toMatchObject({ tools: ["read"], state: { outcome: "cancelled" }, usage: { input: 5 } });
    expect(c.children.takePendingUsage()?.input).toBe(5);
    expect(c.children.takePendingUsage()).toBeUndefined();
    await c.children.close();
  });

  test("resume rejects running/stopping or nonpersisted handles but permits a cleanup-confirmed stopped session", async () => {
    const c = controlled({ finishOnCancel: false });
    const run = c.start({ persist: true });
    c.executions[0]!.facts.sessionFile = "/sessions/stopped.jsonl";
    expect(() => c.children.resumeTarget(run.id)).toThrow("still running");
    const stopping = c.children.stop(run.id);
    expect(() => c.children.resumeTarget(run.handle!)).toThrow("still running");
    c.executions[0]!.finish({ outcome: "cancelled", stopReason: "aborted" });
    await stopping;
    const target = c.children.resumeTarget(run.handle!);
    expect(target).toEqual({ sessionFile: "/sessions/stopped.jsonl", cwd: process.cwd() });
    target.sessionFile = "/different.jsonl";
    expect(c.children.resumeTarget(run.id).sessionFile).toBe("/sessions/stopped.jsonl");
    const transient = c.start();
    c.executions[1]!.finish();
    await c.executions[1]!.done;
    expect(() => c.children.resumeTarget(transient.id)).toThrow("no persisted session");
    await c.children.close();
  });

  test("steering forwards cancellation without stopping or collecting and rejects settled handles", async () => {
    const c = controlled();
    const run = c.start();
    const controller = new AbortController();
    const execution = c.executions[0]!;
    execution.steerHandler = async (_message, signal) => {
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("Steering cancelled")), { once: true }));
    };
    const steering = c.children.steer(run.handle!, "focus", controller.signal);
    controller.abort();
    await expect(steering).rejects.toThrow("Steering cancelled");
    expect(execution.steering).toEqual([{ message: "focus", signal: controller.signal }]);
    expect(execution.cancelCalls).toBe(0);
    execution.steerHandler = undefined;
    corrupt(await c.children.steer(run.id, "replacement"));
    expect(c.children.get(run.id).state.status).toBe("running");
    execution.finish();
    await execution.done;
    await expect(c.children.steer(run.id, "too late")).rejects.toThrow("no longer running");
    expect(c.children.unread().map((result) => result.id)).toEqual([run.id]);
    await c.children.close();
  });
});

describe("join, collection, and retention contracts", () => {
  test("expired and cancelled waits leave execution running and its later report unread", async () => {
    const c = controlled();
    const run = c.start();
    const controller = new AbortController();
    for (let index = 0; index < 20; index++) {
      expect((await c.children.wait([run.id], 1, controller.signal))[0]!.state.status).toBe("running");
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const waiting = c.children.wait([run.id], 10000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("Wait cancelled");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(c.executions[0]!.cancelCalls).toBe(0);
    expect(c.children.get(run.id).state.status).toBe("running");
    c.executions[0]!.finish();
    await c.executions[0]!.done;
    expect(c.children.unread().map((result) => result.id)).toEqual([run.id]);
    expect(c.children.pruneCollected()).toBe(0);
    expect((await c.children.wait([run.id], 1))[0]!.output).toBe("done");
    expect(c.children.pruneCollected()).toBe(1);
    await c.children.close();
  });

  test("foreground join cancellation stops the execution, but an expired foreground budget merely detaches", async () => {
    const c = controlled();
    const run = c.start();
    expect((await c.children.join(run.id, 1)).state.status).toBe("running");
    expect(c.executions[0]!.cancelCalls).toBe(0);
    const controller = new AbortController();
    const joining = c.children.join(run.id, 10000, controller.signal);
    controller.abort();
    expect((await joining).state).toMatchObject({ outcome: "cancelled" });
    expect(c.executions[0]!.cancelCalls).toBe(1);
    expect(c.children.unread()).toEqual([]);
    expect(c.notices).toEqual([]);
    // An expired join must no longer own cancellation.
    const next = c.start();
    const detached = new AbortController();
    await c.children.join(next.id, 1, detached.signal);
    detached.abort();
    expect(c.executions[1]!.cancelCalls).toBe(0);
    await c.children.close();
  });

  test("foreground cancellation joins cleanup even beyond its expired join budget", async () => {
    const c = controlled({ finishOnCancel: false });
    const run = c.start();
    const controller = new AbortController();
    let returned = false;
    const joining = c.children.join(run.id, 1, controller.signal).then((result) => { returned = true; return result; });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(returned).toBe(false);
    expect(c.children.unread()).toEqual([]);
    c.executions[0]!.finish({ outcome: "cancelled", stopReason: "aborted" });
    expect((await joining).state).toMatchObject({ status: "terminal", outcome: "cancelled" });
    expect(c.children.unread()).toEqual([]);
    await c.children.close();
  });

  test("pre-aborted foreground joins still own cancellation through cleanup", async () => {
    const c = controlled();
    const run = c.start();
    const result = await c.children.join(run.id, 1000, AbortSignal.abort());
    expect(result.state).toMatchObject({ status: "terminal", outcome: "cancelled" });
    expect(c.children.unread()).toEqual([]);
    await c.children.close();
  });

  test("wait-any deduplicates id/handle aliases, returns all selected snapshots, and collects only ready reports", async () => {
    const c = controlled();
    const runs = Array.from({ length: 3 }, () => c.start());
    const joining = c.children.wait([...runs.map((run) => run.id), runs[1]!.handle!], 10000);
    c.executions[1]!.finish();
    c.executions[2]!.finish();
    const results = await joining;
    expect(results.map((result) => result.id)).toEqual(runs.map((run) => run.id));
    expect(results.map((result) => result.state.status)).toEqual(["running", "terminal", "terminal"]);
    expect(c.children.unread()).toEqual([]);
    expect(c.notices).toEqual([]);
    c.executions[0]!.finish();
    await c.executions[0]!.done;
    expect(c.children.unread().map((result) => result.id)).toEqual([runs[0]!.id]);
    expect(c.children.pruneCollected()).toBe(2);
    expect(c.children.get(runs[0]!.id).state.status).toBe("terminal");
    await c.children.close();
  });

  test("a multi-child wait has one expiry budget rather than a fresh budget for each child", async () => {
    const c = controlled();
    const runs = Array.from({ length: 3 }, () => c.start());
    // This completion is outside the join's budget, but inside three serial
    // per-child budgets. It must not become part of the expired wait's report.
    const later = setTimeout(() => c.executions[2]!.finish(), 25);
    try {
      const results = await c.children.wait(runs.map((run) => run.id), 10);
      expect(results.map((result) => result.state.status)).toEqual(["running", "running", "running"]);
      expect(c.executions.every((execution) => execution.cancelCalls === 0)).toBe(true);
    } finally {
      clearTimeout(later);
      await c.children.close();
    }
  });

  test("overlapping waits and stop return the same terminal report without duplicate usage or stranded joins", async () => {
    const c = controlled();
    const a = c.start(); const b = c.start();
    c.executions[0]!.facts.usage.input = 5;
    const one = c.children.wait([a.id, b.id], 10000);
    const two = c.children.wait([a.handle!], 10000);
    const stop = c.children.stop(a.id);
    expect((await one).map((result) => result.state.status)).toEqual(["terminal", "running"]);
    expect((await two)[0]!.state).toMatchObject({ outcome: "cancelled" });
    expect((await stop).state).toMatchObject({ outcome: "cancelled" });
    expect(c.notices).toEqual([]);
    expect(c.children.takePendingUsage()?.input).toBe(5);
    expect(c.children.takePendingUsage()).toBeUndefined();
    c.executions[1]!.finish();
    await c.executions[1]!.done;
    expect(c.children.unread().map((result) => result.id)).toEqual([b.id]);
    await c.children.close();
  });

  test("empty/unknown selections and pre-aborted waits never partially consume completed reports", async () => {
    const c = controlled();
    const runs = [c.start(), c.start()];
    await expect(c.children.wait([runs[0]!.id, "unknown"], 1)).rejects.toThrow("Unknown child");
    c.executions.forEach((execution) => execution.finish());
    await Promise.all(c.executions.map((execution) => execution.done));
    await expect(c.children.wait([], 1)).rejects.toThrow("at least one");
    await expect(c.children.wait([runs[0]!.id, "unknown"], 1)).rejects.toThrow("Unknown child");
    await expect(c.children.wait(runs.map((run) => run.id), 1, AbortSignal.abort())).rejects.toThrow("Wait cancelled");
    expect(c.children.unread().map((result) => result.id)).toEqual(runs.map((run) => run.id));
    expect(c.children.pruneCollected()).toBe(0);
    await c.children.wait(runs.map((run) => run.id), 1);
    expect(c.children.unread()).toEqual([]);
    await c.children.close();
  });

  test("cancellation after completion wakes a multi-wait preserves every selected report", async () => {
    const c = controlled();
    const runs = [c.start(), c.start()];
    const controller = new AbortController();
    const waiting = c.children.wait(runs.map((run) => run.id), 10000, controller.signal);
    c.executions.forEach((execution) => execution.finish());
    // Registry completion reactions wake the wait before this abort; the wait's
    // continuation runs afterward and must check cancellation before collecting.
    queueMicrotask(() => controller.abort());
    await expect(waiting).rejects.toThrow("Wait cancelled");
    expect(c.executions.every((execution) => execution.cancelCalls === 0)).toBe(true);
    expect(c.children.unread().map((result) => result.id)).toEqual(runs.map((run) => run.id));
    expect(c.children.pruneCollected()).toBe(0);
    expect((await c.children.wait(runs.map((run) => run.id), 1)).map((result) => result.output)).toEqual(["done", "done"]);
    await c.children.close();
  });

  test("charges cleanup-completed executions once, independently of repeated retrieval and eviction", async () => {
    const c = controlled();
    const active = c.start();
    const run = c.start();
    c.executions[1]!.facts.usage.input = 5;
    expect(c.children.takePendingUsage()).toBeUndefined();
    c.executions[1]!.finish();
    await c.executions[1]!.done;
    c.children.get(run.id);
    c.children.unread();
    await c.children.wait([run.id], 1);
    await c.children.stop(run.id);
    expect(c.children.takePendingUsage()?.input).toBe(5);
    expect(c.children.takePendingUsage()).toBeUndefined();
    for (let index = 0; index <= MAX_RETAINED_RUNS; index++) {
      const next = c.start();
      const execution = c.executions.at(-1)!;
      execution.facts.usage.input = 2;
      execution.finish();
      await execution.done;
      await c.children.wait([next.id], 1);
    }
    expect(() => c.children.get(run.id)).toThrow("Unknown child");
    expect(c.children.list()).toHaveLength(MAX_RETAINED_RUNS);
    expect(c.children.get(active.id)).toMatchObject({ id: active.id, state: { status: "running" } });
    expect(c.children.takePendingUsage()?.input).toBe((MAX_RETAINED_RUNS + 1) * 2);
    expect(c.children.takePendingUsage()).toBeUndefined();
    await c.children.close();
  });

  test("never evicts unread results; collecting one permits only that result to be replaced", async () => {
    const c = controlled();
    const ids: string[] = [];
    for (let index = 0; index < MAX_RETAINED_RUNS; index++) {
      ids.push(c.start().id);
      c.executions[index]!.finish();
      await c.executions[index]!.done;
    }
    expect(() => c.start()).toThrow("unread");
    expect(c.children.unread().map((result) => result.id)).toEqual(ids);
    expect(c.children.pruneCollected()).toBe(0);
    await c.children.wait([ids[0]!], 1);
    c.start();
    expect(() => c.children.get(ids[0]!)).toThrow("Unknown child");
    expect(c.children.unread().map((result) => result.id)).toEqual(ids.slice(1));
    await c.children.close();
  });

  test("shutdown fences admission, progress, completion notices, and all pending usage before joining cleanup", async () => {
    const c = controlled({ finishOnCancel: false });
    const completed = c.start();
    c.executions[0]!.facts.usage.input = 5;
    c.executions[0]!.finish();
    await c.executions[0]!.done;
    let updates = 0;
    c.start({ emit: () => { updates++; } });
    c.executions[1]!.facts.usage.input = 7;
    const closing = c.children.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    c.executions[1]!.publish("stale update");
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(c.children.isClosed).toBe(true);
    expect(() => c.start()).toThrow("closing");
    expect(c.children.unread()).toEqual([]);
    expect(c.children.takePendingUsage()).toBeUndefined();
    expect(c.executions[1]!.cancelCalls).toBe(1);
    c.executions[1]!.finish({ outcome: "cancelled" });
    await closing;
    c.executions[1]!.publish("late update");
    expect(updates).toBe(0);
    expect(c.notices).toEqual([completed.id]);
    expect(c.children.list()).toEqual([]);
    expect(c.children.takePendingUsage()).toBeUndefined();
    await c.children.close();
  });

  test("presentation failures cannot lose reports, usage, or admission", async () => {
    const fixture = controlledSupervisor();
    const children = new SessionChildren(fixture.supervisor, () => { throw new Error("UI unavailable"); });
    const run = children.start({ prompt: "x", tools: [], cwd: process.cwd(), emit() { throw new Error("renderer failed"); } });
    fixture.executions[0]!.publish("first update");
    fixture.executions[0]!.publish("second update");
    fixture.executions[0]!.facts.usage.input = 5;
    fixture.executions[0]!.finish();
    await fixture.executions[0]!.done;
    expect((await children.wait([run.id], 1))[0]!.output).toBe("done");
    expect(children.takePendingUsage()?.input).toBe(5);
    expect(children.pruneCollected()).toBe(1);
    await children.close();
  });

  test("effect-free creation failures do not leave an admission reservation", async () => {
    const fixture = controlledSupervisor();
    let reject = true;
    const children = new SessionChildren({ create(task) {
      if (reject) throw new Error("construction failed");
      return fixture.supervisor.create(task);
    } }, () => {});
    for (let index = 0; index < 8; index++) {
      expect(() => children.start({ prompt: "x", tools: [], cwd: process.cwd() })).toThrow("construction failed");
    }
    expect(children.list()).toEqual([]);
    reject = false;
    for (let index = 0; index < 4; index++) children.start({ prompt: "x", tools: [], cwd: process.cwd() });
    expect(children.list()).toHaveLength(4);
    await children.close();
  });
});
