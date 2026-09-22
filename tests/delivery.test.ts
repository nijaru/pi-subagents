import { describe, expect, test } from "bun:test";
import { CompletionDelivery } from "../extensions/pi-subagents/delivery.ts";
import { SessionChildren } from "../extensions/pi-subagents/children.ts";
import { MAX_OUTPUT_BYTES, MAX_RETAINED_RUNS } from "../extensions/pi-subagents/limits.ts";

function controlled(rejectMessages = false) {
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const messages: any[] = [];
  const entries: any[] = [];
  const statuses: (string | undefined)[] = [];
  let idle = false;
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
  }, () => delivery.ready());
  const ctx: any = { isIdle: () => idle, sessionManager: { getBranch: () => entries }, ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) } };
  delivery = new CompletionDelivery({
    sendMessage(message: any, options: any) {
      if (rejectMessages) throw new Error("host rejected message");
      messages.push({ message, options });
      entries.push({ type: "custom_message", ...message });
      idle = false;
    },
  } as any, children);
  delivery.bind(ctx);
  const start = () => children.start({ prompt: "inspect", tools: [], cwd: process.cwd(), notify: true });
  const boundary = (outcome = "completed", drafts: any[] = []) => delivery.boundary({ type: "turn_end", entries: drafts, outcome } as any, ctx);
  const commit = (result: ReturnType<typeof boundary>) => {
    entries.push(...(result?.entries ?? []));
    delivery.reconcile(ctx);
  };
  const close = async () => { delivery.close(); await children.close(); };
  return { children, delivery, gates, messages, entries, statuses, ctx, start, boundary, commit, close, setIdle: (value: boolean) => { idle = value; } };
}

describe("parent completion delivery", () => {
  test("completion before wait stays retractable while the parent is working", async () => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.messages).toEqual([]);
    expect(c.children.pendingCompletions()).toHaveLength(1);
    expect((await c.children.wait(run.result.id, 1)).output).toBe("report");
    expect(c.boundary()).toBeUndefined();
    c.setIdle(true);
    c.delivery.settled(c.ctx);
    await Promise.resolve();
    expect(c.messages).toEqual([]);
    await c.close();
  });

  test("a blocking join delivers instead of waking or adding a boundary notice", async () => {
    const c = controlled();
    const run = c.start();
    const waiting = c.children.wait(run.result.id, 1000);
    c.gates[0]!.resolve();
    await waiting;
    expect(c.boundary()).toBeUndefined();
    expect(c.messages).toEqual([]);
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
    expect(c.messages).toEqual([]);
    await c.close();
  });

  test("idle completion wakes once; later reads cannot create another notice", async () => {
    const c = controlled();
    c.setIdle(true);
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].options).toEqual({ triggerTurn: true });
    await c.children.wait(run.result.id, 1);
    await c.children.stop(run.result.id);
    c.setIdle(true);
    c.delivery.settled(c.ctx);
    await Promise.resolve();
    expect(c.messages).toHaveLength(1);
    await c.close();
  });

  test("coalesces simultaneous idle completions into one wake-up", async () => {
    const c = controlled();
    const runs = [c.start(), c.start(), c.start(), c.start()];
    c.setIdle(true);
    c.gates.forEach((gate) => gate.resolve());
    await Promise.all(runs.map((run) => run.promise));
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].message.details.results).toHaveLength(4);
    await c.close();
  });

  test.each(["aborted", "error"])("does not automatically restart a %s parent", async (outcome) => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.boundary(outcome)).toBeUndefined();
    c.setIdle(true);
    c.delivery.settled(c.ctx);
    await Promise.resolve();
    expect(c.messages).toEqual([]);
    expect(c.children.pendingCompletions()).toHaveLength(1);
    c.setIdle(false);
    c.delivery.started(c.ctx);
    c.commit(c.boundary());
    expect(c.children.pendingCompletions()).toEqual([]);
    await c.close();
  });

  test("a discarded boundary draft stays unread without an idle retry loop", async () => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.boundary()?.entries).toHaveLength(1);
    // Another boundary hook removed the entry; no commit occurred.
    c.setIdle(true);
    c.delivery.settled(c.ctx);
    await Promise.resolve();
    expect(c.messages).toEqual([]);
    expect(c.children.pendingCompletions()).toHaveLength(1);
    c.setIdle(false);
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
    // A later hook removes the entry but leaves continuation enabled. Pi can
    // still make its natural next request when the prior turn had tool results.
    c.delivery.reconcile(c.ctx); // turn_start, after the empty draft committed
    expect(c.boundary()).toBeUndefined(); // next successful turn_end
    expect(c.boundary()).toBeUndefined(); // agent_before_settle
    c.setIdle(true);
    c.delivery.settled(c.ctx);
    await Promise.resolve();
    expect(c.messages).toEqual([]);
    expect(c.statuses.at(-1)).toBe("1 unread child result");
    await c.close();
  });

  test("completion during a late pre-settlement abort does not restart the parent", async () => {
    const c = controlled();
    const run = c.start();
    expect(c.boundary()).toBeUndefined();
    // Another pre-settlement handler is awaiting when the child completes.
    // Pi can then abort without a new agent_end or an exposed abort signal.
    c.gates[0]!.resolve();
    await run.promise;
    c.setIdle(true);
    c.delivery.settled(c.ctx);
    await Promise.resolve();
    expect(c.messages).toEqual([]);
    expect(c.statuses.at(-1)).toBe("1 unread child result");
    expect((await c.children.wait(run.result.id, 1)).output).toBe("report");
    c.delivery.refreshStatus();
    expect(c.statuses.at(-1)).toBeUndefined();
    await c.close();
  });

  test("a rejected idle message remains unread without crashing or retrying", async () => {
    const c = controlled(true);
    c.setIdle(true);
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    expect(c.children.pendingCompletions()).toHaveLength(1);
    c.delivery.ready();
    await Promise.resolve();
    expect(c.messages).toEqual([]);
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

  test("shutdown fences scheduled idle wake-ups", async () => {
    const c = controlled();
    const run = c.start();
    c.gates[0]!.resolve();
    await run.promise;
    c.setIdle(true);
    c.delivery.ready();
    await c.close();
    await Promise.resolve();
    expect(c.messages).toEqual([]);
    expect(c.children.pendingCompletions()).toEqual([]);
  });
});
