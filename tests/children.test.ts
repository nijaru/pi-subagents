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
    for (let i = 0; i < 20; i++) await c.children.wait(run.result.id, 1);
    expect(run.waiters.size).toBe(0);
    const controller = new AbortController();
    const wait = c.children.wait(run.result.id, 10000, controller.signal);
    expect(run.waiters.size).toBe(1);
    controller.abort();
    await expect(wait).rejects.toThrow("Wait cancelled");
    expect(run.waiters.size).toBe(0);
    await c.children.close();
  });
  test("an active join claims delivery and suppresses the completion notice", async () => {
    const c = controlled();
    const run = c.start();
    const joining = c.children.wait(run.result.id, 10000);
    c.gates[0]!.resolve();
    expect((await joining).output).toBe("done");
    await run.promise;
    expect(c.notices).toEqual([]);
  });
  test("a join that expires while the child is live re-arms the completion notice", async () => {
    const c = controlled();
    const run = c.start();
    expect((await c.children.wait(run.result.id, 1)).state.status).toBe("running");
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.notices).toEqual([run.result.id]);
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
    await c.children.wait(run.result.id, 1);
    await c.children.stop(run.result.id);
    expect(c.children.takePendingUsage()?.input).toBe(5);
    expect(c.children.takePendingUsage()).toBeUndefined();
    for (let i = 1; i <= MAX_RETAINED_RUNS + 1; i++) {
      const next = c.start();
      c.requests[i]!.result.usage.input = 2;
      c.gates[i]!.resolve();
      await next.promise;
    }
    expect(() => c.children.get(run.result.id)).toThrow("Unknown child");
    expect(c.children.takePendingUsage()?.input).toBe((MAX_RETAINED_RUNS + 1) * 2);
    expect(c.children.takePendingUsage()).toBeUndefined();
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
    expect((await children.wait(run.result.id, 1)).output).toBe("answer");
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
