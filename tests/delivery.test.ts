import { describe, expect, test } from "bun:test";
import { CompletionDelivery } from "../extensions/pi-subagents/delivery.ts";
import { SessionChildren } from "../extensions/pi-subagents/children.ts";
import { MAX_OUTPUT_BYTES, MAX_RETAINED_RUNS } from "../extensions/pi-subagents/limits.ts";

function controlled() {
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const entries: any[] = [];
  const statuses: (string | undefined)[] = [];
  let delivery: CompletionDelivery;
  const children = new SessionChildren({
    async run({ result, signal }) {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      signal.addEventListener("abort", () => gate.resolve(), { once: true });
      await gate.promise;
      result.output = "report";
      return { outcome: signal.aborted ? "cancelled" : "completed", exitCode: 0, stopReason: "stop" };
    },
  }, () => delivery.refreshStatus());
  const ctx: any = { sessionManager: { getBranch: () => entries }, ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) } };
  delivery = new CompletionDelivery(children);
  delivery.bind(ctx);
  const start = () => children.start({ prompt: "inspect", tools: [], cwd: process.cwd(), notify: true });
  const boundary = (outcome = "completed", drafts: any[] = []) => delivery.boundary({ type: "turn_end", entries: drafts, outcome } as any, ctx);
  const commit = (result: ReturnType<typeof boundary>) => {
    entries.push(...(result?.entries ?? []));
    delivery.reconcile(ctx);
  };
  const close = async () => { delivery.close(); await children.close(); };
  return { children, delivery, gates, entries, statuses, ctx, start, boundary, commit, close };
}

describe("parent completion delivery", () => {
  test("completion before wait stays retractable", async () => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.children.pendingCompletions()).toHaveLength(1);
    expect((await c.children.wait(run.result.id, 1)).output).toBe("report");
    expect(c.boundary()).toBeUndefined();
    c.delivery.settled(c.ctx);
    expect(c.statuses.at(-1)).toBeUndefined();
    await c.close();
  });

  test("a blocking join delivers instead of adding a boundary notice", async () => {
    const c = controlled();
    const run = c.start();
    const waiting = c.children.wait(run.result.id, 1000);
    c.gates[0]!.resolve();
    await waiting;
    expect(c.boundary()).toBeUndefined();
    await c.close();
  });

  test("batches unread results into one boundary continuation, preserving prior drafts", async () => {
    const c = controlled();
    const runs = [c.start(), c.start()];
    c.gates.forEach((gate) => gate.resolve());
    await Promise.all(runs.map((run) => run.promise));
    const prior = { type: "custom" as const, customType: "another-extension", data: 1 };
    const result = c.boundary("completed", [prior]);
    expect(result?.continue).toBe(true);
    expect(result?.entries).toHaveLength(2);
    expect(result?.entries?.[0]).toBe(prior);
    const draft: any = result?.entries?.[1];
    expect(draft.details.results.map((r: any) => r.id)).toEqual(runs.map((run) => run.result.id));
    expect(c.children.hasOfferedCompletions()).toBe(true);
    c.commit(result);
    expect(c.children.hasOfferedCompletions()).toBe(false);
    expect(c.boundary()).toBeUndefined();
    await c.close();
  });

  test.each(["aborted", "error"])("does not offer a continuation for a %s parent", async (outcome) => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.boundary(outcome)).toBeUndefined();
    c.delivery.settled(c.ctx);
    expect(c.children.pendingCompletions()).toHaveLength(1);
    c.delivery.started(c.ctx);
    c.commit(c.boundary());
    expect(c.children.pendingCompletions()).toEqual([]);
    await c.close();
  });

  test("a discarded boundary draft stays unread until the next run", async () => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.boundary()?.entries).toHaveLength(1);
    // Another boundary hook removed the entry; no commit occurred.
    c.delivery.settled(c.ctx);
    expect(c.children.pendingCompletions()).toHaveLength(1);
    expect(c.boundary()).toBeUndefined();
    c.delivery.started(c.ctx);
    c.commit(c.boundary());
    expect(c.children.pendingCompletions()).toEqual([]);
    await c.close();
  });

  test("a dropped draft stays suppressed through the next natural provider request", async () => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.boundary()?.continue).toBe(true);
    // A later hook removes the entry but leaves continuation enabled.
    c.delivery.reconcile(c.ctx);
    expect(c.boundary()).toBeUndefined();
    expect(c.boundary()).toBeUndefined();
    c.delivery.settled(c.ctx);
    expect(c.statuses.at(-1)).toBe("1 unread child result");
    await c.close();
  });

  test.each(["before", "after"])("completion %s settlement remains unread until a join or boundary", async (timing) => {
    const c = controlled();
    const run = c.start();
    expect(c.boundary()).toBeUndefined();
    // Pi can abort in a later hook without exposing another aborted event.
    if (timing === "after") c.delivery.settled(c.ctx);
    c.gates[0]!.resolve();
    await run.promise;
    if (timing === "before") c.delivery.settled(c.ctx);
    expect(c.children.pendingCompletions()).toHaveLength(1);
    expect(c.statuses.at(-1)).toBe("1 unread child result");
    expect((await c.children.wait(run.result.id, 1)).output).toBe("report");
    c.delivery.refreshStatus();
    expect(c.statuses.at(-1)).toBeUndefined();
    await c.close();
  });

  test("bounded batches represent every retained result and mark shortened excerpts", async () => {
    const c = controlled();
    for (let i = 0; i < MAX_RETAINED_RUNS; i++) {
      const run = c.start();
      c.gates[i]!.resolve();
      await run.promise;
      run.result.output = "x".repeat(MAX_OUTPUT_BYTES);
    }
    const result = c.boundary();
    const draft: any = result?.entries?.[0];
    expect(Buffer.byteLength(draft.content)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(draft.details))).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(draft.details.results).toHaveLength(MAX_RETAINED_RUNS);
    for (const run of c.children.list()) expect(draft.content).toContain(run.id);
    expect(draft.content).toContain("Excerpt truncated");
    c.commit(result);
    await c.close();
  });

  test("shutdown fences status updates and boundary delivery", async () => {
    const c = controlled();
    c.start();
    await c.close();
    const count = c.statuses.length;
    c.delivery.refreshStatus();
    expect(c.statuses).toHaveLength(count);
    expect(c.boundary()).toBeUndefined();
    expect(c.children.pendingCompletions()).toEqual([]);
  });
});
