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
      Object.assign(request.result, { exitCode: request.signal.aborted ? 1 : 0, termination: request.signal.aborted ? "cancelled" : "completed", output: "done" });
    },
  };
  const notices: string[] = [];
  const children = new SessionChildren(supervisor, (result) => notices.push(result.id));
  const start = (background = true) => children.start({ prompt: "bounded task", tools: ["read"], cwd: process.cwd(), background });
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
    c.requests[0]!.result.exitCode = 0;
    c.requests[0]!.result.termination = "completed";
    expect(c.children.snapshot(runs[0]!).exitCode).toBe(-1);
    expect(() => c.start()).toThrow("maximum 4");
    c.gates[0]!.resolve();
    await runs[0]!.promise;
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
    c.children.start({ prompt: "x", tools: [], cwd: process.cwd(), background: false, emit: () => { updates++; } });
    const closing = c.children.close();
    c.requests[0]!.emit?.(c.requests[0]!.result, "stale update");
    await closing;
    expect(updates).toBe(0);
  });
  test("notification failure does not lose the completed result", async () => {
    const children = new SessionChildren({ async run({ result }) { result.exitCode = 0; result.termination = "completed"; result.output = "answer"; } }, () => { throw new Error("UI unavailable"); });
    const run = children.start({ prompt: "x", tools: [], cwd: process.cwd(), background: true });
    await run.promise;
    expect((await children.wait(run.result.id, 1)).output).toBe("answer");
    await children.close();
  });
  test("supervisor setup failures settle rather than leaking admission", async () => {
    const children = new SessionChildren({ async run() { throw new Error("setup failed"); } }, () => {});
    for (let i = 0; i < 8; i++) {
      const run = children.start({ prompt: "x", tools: [], cwd: process.cwd(), background: true });
      expect((await run.promise).errorMessage).toBe("setup failed");
      expect(children.snapshot(run).termination).toBe("failed");
    }
    await children.close();
  });
});
