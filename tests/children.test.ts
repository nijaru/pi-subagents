import { describe, expect, test } from "bun:test";
import { SessionChildren } from "../extensions/pi-subagents/children.ts";
import type { ChildRunRequest, ChildSupervisor } from "../extensions/pi-subagents/supervisor.ts";
import { MAX_RETAINED_RUNS } from "../extensions/pi-subagents/limits.ts";

function controlled() {
  const requests: ChildRunRequest[] = [];
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const supervisor: ChildSupervisor = {
    async run(request) {
      const gate = Promise.withResolvers<void>();
      requests.push(request); gates.push(gate);
      request.signal.addEventListener("abort", () => gate.resolve(), { once: true });
      await gate.promise;
      request.result.output = "done";
      return request.signal.aborted
        ? { outcome: "cancelled", exitCode: 1, stopReason: "aborted" }
        : { outcome: "completed", exitCode: 0, stopReason: "stop" };
    },
  };
  const notices: string[] = [];
  const children = new SessionChildren(supervisor, (result) => notices.push(result.id));
  const start = (background = true) => children.start({ prompt: "bounded task", tools: ["read"], cwd: process.cwd(), notify: background });
  return { children, start, requests, gates, notices };
}

describe("session ownership", () => {
  test("registers admission before a supervisor can reenter the owner", async () => {
    const c = controlled();
    const runs = Array.from({ length: 4 }, () => c.start());
    expect(() => c.start()).toThrow("maximum 4");
    expect(c.children.list().map((r) => r.id)).toEqual(runs.map((r) => r.result.id));
    await c.children.close();
    expect(c.requests.every((r) => r.signal.aborted)).toBe(true);
    expect(c.notices).toEqual([]);
  });
  test("holds admission until execution cleanup returns, even after terminal output", async () => {
    const c = controlled();
    const runs = Array.from({ length: 4 }, () => c.start());
    // Terminal output has arrived, but the supervisor has not returned yet.
    c.requests[0]!.result.output = "done";
    expect(c.children.snapshot(runs[0]!).state.status).toBe("running");
    expect(() => c.start()).toThrow("maximum 4");
    c.gates[0]!.resolve();
    await runs[0]!.promise;
    expect(c.children.snapshot(runs[0]!).state).toMatchObject({ status: "terminal", outcome: "completed" });
    c.start();
    await c.children.close();
  });
  test("expired and cancelled waits release their completion listeners", async () => {
    const c = controlled();
    const run = c.start();
    for (let i = 0; i < 20; i++) await c.children.wait([run.result.id], 1);
    expect(run.waiters.size).toBe(0);
    const controller = new AbortController();
    const wait = c.children.wait([run.result.id], 10000, controller.signal);
    expect(run.waiters.size).toBe(1);
    controller.abort();
    await expect(wait).rejects.toThrow("Wait cancelled");
    expect(run.waiters.size).toBe(0);
    await c.children.close();
  });
  test("an active join claims delivery and suppresses the completion notice", async () => {
    const c = controlled();
    const run = c.start();
    const joining = c.children.wait([run.result.id], 10000);
    c.gates[0]!.resolve();
    expect((await joining)[0]!.output).toBe("done");
    await run.promise;
    expect(c.notices).toEqual([]);
  });
  test("a join that expires while the child is live re-arms the completion notice", async () => {
    const c = controlled();
    const run = c.start();
    expect((await c.children.wait([run.result.id], 1))[0]!.state.status).toBe("running");
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.notices).toEqual([run.result.id]);
  });
  test("wait-any collects ready reports and re-arms remaining children", async () => {
    const c = controlled();
    const runs = Array.from({ length: 3 }, () => c.start());
    const joining = c.children.wait(runs.map((run) => run.result.id), 10000);
    c.gates[1]!.resolve();
    c.gates[2]!.resolve();
    const results = await joining;
    expect(results.map((result) => result.state.status)).toEqual(["running", "terminal", "terminal"]);
    expect(runs.map((run) => run.delivery)).toEqual(["unread", "delivered", "delivered"]);
    expect(runs.every((run) => run.waiters.size === 0 && run.activeWaits === 0)).toBe(true);
    expect(c.notices).toEqual([]);
    c.gates[0]!.resolve();
    await runs[0]!.promise;
    expect(c.notices).toEqual([runs[0]!.result.id]);
    await c.children.close();
  });
  test("overlapping waits and stop release listeners without duplicate notices or usage", async () => {
    const c = controlled();
    const a = c.start(); const b = c.start();
    c.requests[0]!.result.usage.input = 5;
    const one = c.children.wait([a.result.id, b.result.id], 10000);
    const two = c.children.wait([a.result.id], 10000);
    const stop = c.children.stop(a.result.id);
    expect((await one)[0]!.state).toMatchObject({ outcome: "cancelled" });
    expect((await two)[0]!.state).toMatchObject({ outcome: "cancelled" });
    await stop;
    expect(c.notices).toEqual([]);
    expect(c.children.takePendingUsage()?.input).toBe(5);
    expect(c.children.takePendingUsage()).toBeUndefined();
    expect(a.activeWaits).toBe(0);
    expect(b.waiters.size).toBe(0);
    await c.children.close();
  });
  test("invalid selections and cancelled multi-waits do not consume reports", async () => {
    const c = controlled();
    const a = c.start(); const b = c.start();
    await expect(c.children.wait([a.result.id, "unknown"], 1)).rejects.toThrow("Unknown child");
    expect(a.activeWaits).toBe(0);
    const controller = new AbortController();
    const joining = c.children.wait([a.result.id, b.result.id], 10000, controller.signal);
    controller.abort();
    c.gates[0]!.resolve();
    c.gates[1]!.resolve();
    await expect(joining).rejects.toThrow("Wait cancelled");
    await Promise.all([a.promise, b.promise]);
    expect(c.children.pendingCompletions()).toHaveLength(2);
    expect([a, b].every((run) => run.activeWaits === 0 && run.waiters.size === 0 && !run.controller.signal.aborted)).toBe(true);
    // Resolve all ids before consuming even an already-completed report.
    await expect(c.children.wait([a.result.id, "unknown"], 1)).rejects.toThrow("Unknown child");
    expect(a.delivery).toBe("unread");
    expect((await c.children.wait([a.result.id, b.result.id], 1)).every((result) => result.state.status === "terminal")).toBe(true);
    expect(c.children.pendingCompletions()).toHaveLength(0);
    await c.children.close();
  });
  test("evicts only completed handles and bounds retained state", async () => {
    const c = controlled();
    const active = c.start();
    let firstCompleted = "";
    for (let i = 1; i <= MAX_RETAINED_RUNS; i++) {
      const run = c.start(false);
      if (i === 1) firstCompleted = run.result.id;
      c.gates[i]!.resolve();
      await run.promise;
    }
    expect(c.children.list()).toHaveLength(MAX_RETAINED_RUNS);
    expect(c.children.get(active.result.id)).toBe(active);
    expect(() => c.children.get(firstCompleted)).toThrow("Unknown child");
    await c.children.close();
  });
  test("charges completed executions once, independently of joins and eviction", async () => {
    const c = controlled();
    const run = c.start();
    c.requests[0]!.result.usage.input = 5;
    expect(c.children.takePendingUsage()).toBeUndefined(); // cleanup still running
    c.gates[0]!.resolve();
    await run.promise;
    await c.children.wait([run.result.id], 1);
    await c.children.stop(run.result.id);
    expect(c.children.takePendingUsage()?.input).toBe(5);
    expect(c.children.takePendingUsage()).toBeUndefined();
    for (let i = 1; i <= MAX_RETAINED_RUNS + 1; i++) {
      const next = c.start();
      c.requests[i]!.result.usage.input = 2;
      c.gates[i]!.resolve();
      await next.promise;
      c.children.acknowledgeCompletions([next.result.id]);
    }
    expect(() => c.children.get(run.result.id)).toThrow("Unknown child");
    expect(c.children.takePendingUsage()?.input).toBe((MAX_RETAINED_RUNS + 1) * 2);
    expect(c.children.takePendingUsage()).toBeUndefined();
    await c.children.close();
  });
  test("does not evict unread results to admit more work", async () => {
    const c = controlled();
    for (let i = 0; i < MAX_RETAINED_RUNS; i++) {
      const run = c.start();
      c.gates[i]!.resolve();
      await run.promise;
    }
    expect(() => c.start()).toThrow("unread");
    expect(c.children.pendingCompletions()).toHaveLength(MAX_RETAINED_RUNS);
    await c.children.wait([c.children.list()[0]!.id], 1);
    c.start();
    await c.children.close();
  });
  test("shutdown discards pending usage and fences charges from stopped children", async () => {
    const c = controlled();
    const completed = c.start();
    c.requests[0]!.result.usage.input = 5;
    c.gates[0]!.resolve();
    await completed.promise;
    c.start();
    c.requests[1]!.result.usage.input = 7;
    await c.children.close();
    expect(c.children.takePendingUsage()).toBeUndefined();
  });
  test("session closure fences completion and rejects subsequent admission", async () => {
    const c = controlled();
    c.start();
    const closed = c.children.close();
    expect(() => c.start()).toThrow("closing");
    await closed;
    expect(c.notices).toEqual([]);
    expect(c.children.list()).toEqual([]);
  });
  test("shutdown fences foreground updates as well as completion notices", async () => {
    const c = controlled();
    let updates = 0;
    c.children.start({ prompt: "x", tools: [], cwd: process.cwd(), notify: false, emit: () => { updates++; } });
    const closing = c.children.close();
    c.requests[0]!.emit?.(c.requests[0]!.result, "stale update");
    await closing;
    expect(updates).toBe(0);
  });
  test("notification failure does not lose the completed result", async () => {
    const children = new SessionChildren({ async run({ result }) { result.output = "answer"; return { outcome: "completed", exitCode: 0, stopReason: "stop" }; } }, () => { throw new Error("UI unavailable"); });
    const run = children.start({ prompt: "x", tools: [], cwd: process.cwd(), notify: true });
    await run.promise;
    expect((await children.wait([run.result.id], 1))[0]!.output).toBe("answer");
    await children.close();
  });
  test("lifecycle state never duplicates execution diagnostics", async () => {
    const children = new SessionChildren({ async run() {
      return { outcome: "failed", exitCode: 1, stopReason: "error", errorMessage: "diagnostic".repeat(1000), stdout: "not lifecycle state" };
    } }, () => {});
    const run = children.start({ prompt: "x", tools: [], cwd: process.cwd(), notify: false });
    const result = await run.promise;
    expect(Object.keys(result.state).sort()).toEqual(["exitCode", "finishedAt", "outcome", "status", "stopReason"]);
    expect(result.errorMessage).toContain("diagnostic");
    await children.close();
  });
  test("supervisor setup failures settle rather than leaking admission", async () => {
    const children = new SessionChildren({ async run() { throw new Error("setup failed"); } }, () => {});
    for (let i = 0; i < 8; i++) {
      const run = children.start({ prompt: "x", tools: [], cwd: process.cwd(), notify: true });
      expect((await run.promise).errorMessage).toBe("setup failed");
      expect(children.snapshot(run).state).toMatchObject({ status: "terminal", outcome: "failed" });
    }
    await children.close();
  });
});
