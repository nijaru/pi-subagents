import { describe, expect, test } from "bun:test";
import { CompletionDelivery } from "../extensions/pi-subagents/delivery.ts";
import { SessionChildren } from "../extensions/pi-subagents/children.ts";
import { MAX_OUTPUT_BYTES, MAX_RETAINED_RUNS } from "../extensions/pi-subagents/limits.ts";
import { emptyUsage } from "../extensions/pi-subagents/types.ts";

function controlled() {
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const statuses: (string | undefined)[] = [];
  let delivery: CompletionDelivery;
  const children = new SessionChildren({
    async run({ signal }) {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      signal.addEventListener("abort", () => gate.resolve(), { once: true });
      await gate.promise;
      return { output: "PRIVATE_REPORT", stderr: "", usage: emptyUsage(), outcome: signal.aborted ? "cancelled" : "completed", exitCode: 0, stopReason: "stop" };
    },
  }, () => delivery.refreshStatus());
  const ctx: any = {
    signal: new AbortController().signal,
    ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) },
  };
  delivery = new CompletionDelivery(children);
  delivery.started(ctx);
  const start = (notify: "inbox" | "turn" = "turn") => children.start({ prompt: "inspect", tools: [], cwd: process.cwd(), notify });
  const boundary = (outcome = "completed", entries: any[] = []) => delivery.boundary({ type: "turn_end", messageEntryId: "entry", entries, outcome } as any, ctx);
  const close = async () => { delivery.close(); await children.close(); };
  return { children, delivery, gates, statuses, ctx, start, boundary, close };
}

describe("non-consuming readiness announcements", () => {
  test("batches handles, preserves prior drafts, and never transfers reports", async () => {
    const c = controlled();
    const runs = [c.start(), c.start()];
    c.gates.forEach((gate) => gate.resolve());
    await Promise.all(runs.map((run) => run.promise));
    const prior = { type: "custom" as const, customType: "another-extension", data: 1 };
    const result = c.boundary("completed", [prior]);
    expect(result?.continue).toBe(true);
    expect(result?.entries?.[0]).toBe(prior);
    const notice = result?.entries?.[1];
    expect(JSON.stringify(notice)).not.toContain("PRIVATE_REPORT");
    expect(notice).toMatchObject({ customType: "subagent-ready", details: { handles: runs.map((run) => run.handle) } });
    expect(c.children.unreadCompletionCount()).toBe(2);
    expect(c.boundary()).toBeUndefined();
    expect(c.children.pendingInbox()).toHaveLength(2);
    expect((await c.children.wait(runs.map((run) => run.handle), 1)).map((result) => result.output)).toEqual(["PRIVATE_REPORT", "PRIVATE_REPORT"]);
    expect(c.children.unreadCompletionCount()).toBe(0);
    await c.close();
  });

  test("explicit joins win over automatic announcements", async () => {
    const c = controlled();
    const run = c.start();
    const joining = c.children.wait([run.handle], 1000);
    c.gates[0]!.resolve();
    await joining;
    expect(c.boundary()).toBeUndefined();
    c.delivery.settled(c.ctx);
    expect(c.statuses.at(-1)).toBeUndefined();
    await c.close();
  });

  test.each(["aborted", "error", "signal"])("never restarts a %s parent", async (failure) => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    if (failure === "signal") c.ctx.signal = AbortSignal.abort();
    expect(c.boundary(failure === "signal" ? "completed" : failure)).toBeUndefined();
    c.delivery.settled(c.ctx);
    expect(c.statuses.at(-1)).toBe("1 unread child result");
    c.ctx.signal = new AbortController().signal;
    c.delivery.started(c.ctx);
    expect(c.boundary()?.continue).toBe(true);
    await c.close();
  });

  test("an error assistant suppresses misleading completed tool boundaries", async () => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    c.delivery.ended({ messages: [{ role: "assistant", stopReason: "error" }] } as any, c.ctx);
    expect(c.boundary()).toBeUndefined();
    expect(c.children.unreadCompletionCount()).toBe(1);
    await c.close();
  });

  test("a dropped draft cannot loop or consume a report; next run may retry", async () => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.boundary()?.continue).toBe(true);
    // A later extension can discard the draft. No transcript reconciliation is
    // needed: even a committed notice never owns this report.
    expect(c.boundary()).toBeUndefined();
    c.delivery.settled(c.ctx);
    expect(c.children.unreadCompletionCount()).toBe(1);
    expect(c.children.pendingInbox()[0]?.handle).toBe(run.handle);
    c.delivery.started(c.ctx);
    expect(c.boundary()?.continue).toBe(true);
    expect((await c.children.wait([run.handle], 1))[0]!.output).toBe("PRIVATE_REPORT");
    expect(c.boundary()).toBeUndefined();
    await c.close();
  });

  test.each(["inbox", "turn"] as const)("late %s completions never wake idle parents", async (notify) => {
    const c = controlled();
    const run = c.start(notify);
    expect(c.boundary()).toBeUndefined();
    c.delivery.settled(c.ctx);
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.statuses.at(-1)).toBe("1 unread child result");
    expect(c.children.get(run.handle).delivery).toBe("unread");
    expect((await c.children.wait([run.handle], 1))[0]!.output).toBe("PRIVATE_REPORT");
    await c.close();
  });

  test("even large announcements never authorize eviction of unread reports", async () => {
    const c = controlled();
    for (let i = 0; i < MAX_RETAINED_RUNS; i++) {
      const run = c.start();
      c.gates[i]!.resolve();
      await run.promise;
      run.result.output = "x".repeat(MAX_OUTPUT_BYTES);
    }
    const notice: any = c.boundary()?.entries?.[0];
    expect(notice.details.handles).toHaveLength(MAX_RETAINED_RUNS);
    expect(Buffer.byteLength(JSON.stringify(notice))).toBeLessThan(MAX_OUTPUT_BYTES);
    expect(() => c.start()).toThrow("unread");
    expect(c.children.pruneDelivered()).toBe(0);
    await c.children.wait([c.children.list()[0]!.id], 1);
    expect(c.start()).toBeDefined();
    await c.close();
  });

  test("shutdown fences status and boundary delivery", async () => {
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
