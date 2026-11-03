import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentActivityOutcome,
  AgentBeforeSettleEvent,
  ExtensionContext,
  SessionBoundaryDraft,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { CompletionDelivery } from "../extensions/pi-subagents/delivery.ts";
import { SessionChildren } from "../extensions/pi-subagents/children.ts";
import { MAX_OUTPUT_BYTES, MAX_RETAINED_RUNS } from "../extensions/pi-subagents/limits.ts";
import { emptyUsage } from "../extensions/pi-subagents/types.ts";
import { controlledSupervisor } from "./fixtures/controlled-children.ts";

function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture/model",
    usage: emptyUsage(), stopReason, timestamp: 1,
  };
}

function controlled() {
  const fixture = controlledSupervisor();
  const statuses: (string | undefined)[] = [];
  let delivery: CompletionDelivery;
  const children = new SessionChildren(fixture.supervisor, () => delivery.refreshStatus());
  const ctx = {
    signal: new AbortController().signal,
    ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) },
  } as unknown as ExtensionContext;
  delivery = new CompletionDelivery(children);
  delivery.started(ctx);
  delivery.turnStarted();
  const start = () => children.start({ prompt: "PRIVATE_PROMPT", tools: ["read"], cwd: "/PRIVATE_WORKSPACE" });
  const boundary = (
    outcome: AgentActivityOutcome = "completed",
    entries: SessionBoundaryDraft[] = [],
    type: "turn_end" | "agent_before_settle" = "turn_end",
  ) => {
    const common = {
      entries, outcome, continue: false,
      context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
    };
    const event: TurnEndEvent | AgentBeforeSettleEvent = type === "turn_end"
      ? { ...common, type, turnIndex: 0, message: assistant("stop"), toolResults: [], messageEntryId: "entry", toolResultEntryIds: [] }
      : { ...common, type };
    return delivery.boundary(event, ctx);
  };
  const finish = async (index: number) => {
    const execution = fixture.executions[index]!;
    execution.finish({ output: "PRIVATE_REPORT", sessionFile: `/PRIVATE_SESSIONS/child-${index}.jsonl` });
    await execution.done;
  };
  const close = async () => { delivery.close(); await children.close(); };
  return { ...fixture, children, delivery, statuses, ctx, start, boundary, finish, close };
}

describe("non-consuming readiness announcements", () => {
  test("batches only handles, preserves prior drafts, and never transfers reports", async () => {
    const c = controlled();
    const runs = [c.start(), c.start()];
    await Promise.all([c.finish(0), c.finish(1)]);
    const prior = { type: "custom" as const, customType: "another-extension", data: 1 };
    const result = c.boundary("completed", [prior]);
    expect(result?.continue).toBe(true);
    expect(result?.entries?.[0]).toBe(prior);
    const notice = result?.entries?.[1];
    expect(notice).toMatchObject({
      type: "custom_message", customType: "subagent-ready", display: true,
      details: { handles: runs.map((run) => run.handle) },
    });
    expect(JSON.stringify(notice)).not.toContain("PRIVATE_");
    expect(c.children.unread()).toHaveLength(2);
    expect(c.boundary()).toBeUndefined();
    expect(c.boundary("completed", [], "agent_before_settle")).toBeUndefined();
    expect(c.delivery.inbox().map((result) => result.id)).toEqual(runs.map((run) => run.id));
    expect(c.children.unread()).toHaveLength(2);
    expect((await c.children.wait(runs.map((run) => run.id), 1)).map((result) => result.output)).toEqual(["PRIVATE_REPORT", "PRIVATE_REPORT"]);
    expect(c.children.unread()).toEqual([]);
    await c.close();
  });

  test("inbox snapshots are detached, once per turn, and independent of boundary attempts", async () => {
    const c = controlled();
    const run = c.start();
    await c.finish(0);
    const inbox = c.delivery.inbox();
    expect(inbox.map((result) => result.id)).toEqual([run.id]);
    inbox[0]!.tools!.push("write");
    inbox[0]!.usage.input = 999;
    inbox[0]!.output = "changed";
    expect(c.delivery.inbox()).toEqual([]);
    expect(c.boundary("completed", [], "agent_before_settle")?.continue).toBe(true);
    c.delivery.turnStarted();
    expect(c.delivery.inbox()[0]).toMatchObject({ tools: ["read"], output: "PRIVATE_REPORT", usage: { input: 0 } });
    expect(c.delivery.inbox()).toEqual([]);
    // A new turn rearms tool-boundary advertising, not continuation attempts.
    expect(c.boundary()).toBeUndefined();
    await c.children.wait([run.id], 1);
    c.delivery.turnStarted();
    expect(c.delivery.inbox()).toEqual([]);
    expect(c.children.pruneCollected()).toBe(1);
    await c.close();
  });

  test("explicit joins own completion and suppress both inbox and automatic notices", async () => {
    const c = controlled();
    const run = c.start();
    const joining = c.children.wait([run.handle!], 1000);
    await c.finish(0);
    await joining;
    expect(c.boundary()).toBeUndefined();
    expect(c.delivery.inbox()).toEqual([]);
    c.delivery.settled(c.ctx);
    expect(c.statuses.at(-1)).toBeUndefined();
    await c.close();
  });

  test("an expired or cancelled join rearms later delivery without stopping the child", async () => {
    const c = controlled();
    const run = c.start();
    await c.children.wait([run.id], 1);
    const controller = new AbortController();
    const joining = c.children.wait([run.id], 10000, controller.signal);
    controller.abort();
    await expect(joining).rejects.toThrow("Wait cancelled");
    expect(c.executions[0]!.cancelCalls).toBe(0);
    await c.finish(0);
    expect(c.delivery.inbox().map((result) => result.id)).toEqual([run.id]);
    expect(c.boundary()?.continue).toBe(true);
    expect(c.children.pruneCollected()).toBe(0);
    await c.close();
  });

  test.each(["aborted", "error", "signal"] as const)("never restarts a %s parent, even after a successful automatic retry", async (failure) => {
    const c = controlled();
    c.start();
    await c.finish(0);
    if (failure === "signal") c.ctx.signal = AbortSignal.abort();
    expect(c.boundary(failure === "signal" ? "completed" : failure)).toBeUndefined();
    c.ctx.signal = new AbortController().signal;
    c.delivery.turnStarted();
    expect(c.boundary("completed", [], "agent_before_settle")).toBeUndefined();
    c.delivery.settled(c.ctx);
    expect(c.statuses.at(-1)).toBe("1 unread child result");
    c.delivery.started(c.ctx);
    c.delivery.turnStarted();
    expect(c.boundary()?.continue).toBe(true);
    await c.close();
  });

  test.each(["error", "aborted"] as const)("an assistant %s latches suppression until the next external run", async (stopReason) => {
    const c = controlled();
    const run = c.start();
    await c.finish(0);
    c.delivery.ended({ type: "agent_end", messages: [assistant(stopReason)] }, c.ctx);
    expect(c.boundary()).toBeUndefined();
    c.delivery.ended({ type: "agent_end", messages: [assistant("stop")] }, c.ctx);
    expect(c.boundary()).toBeUndefined();
    expect(c.delivery.inbox().map((result) => result.id)).toEqual([run.id]);
    expect((await c.children.wait([run.id], 1))[0]!.output).toBe("PRIVATE_REPORT");
    await c.close();
  });

  test("a dropped draft cannot loop or consume a report; only the next run can retry", async () => {
    const c = controlled();
    const run = c.start();
    await c.finish(0);
    expect(c.boundary()?.continue).toBe(true);
    // Simulate a later extension dropping the draft: no commit or transcript
    // reconciliation is needed because a notice never owns the report.
    expect(c.boundary()).toBeUndefined();
    c.delivery.turnStarted();
    expect(c.boundary("completed", [], "agent_before_settle")).toBeUndefined();
    c.delivery.settled(c.ctx);
    expect(c.children.unread().map((result) => result.id)).toEqual([run.id]);
    expect(c.delivery.inbox()[0]?.id).toBe(run.id);
    c.delivery.started(c.ctx);
    c.delivery.turnStarted();
    expect(c.boundary()?.continue).toBe(true);
    expect((await c.children.wait([run.id], 1))[0]!.output).toBe("PRIVATE_REPORT");
    expect(c.boundary()).toBeUndefined();
    await c.close();
  });

  test("new completions can be advertised in the same run without retrying an older dropped draft", async () => {
    const c = controlled();
    const first = c.start();
    const second = c.start();
    await c.finish(0);
    expect(c.boundary()?.entries?.[0]).toMatchObject({ details: { handles: [first.handle] } });
    await c.finish(1);
    expect(c.boundary()?.entries?.[0]).toMatchObject({ details: { handles: [second.handle] } });
    expect(c.boundary()).toBeUndefined();
    expect(c.children.unread()).toHaveLength(2);
    await c.close();
  });

  test("late completions only update idle status; the next active run discovers their unread handles", async () => {
    const c = controlled();
    const run = c.start();
    expect(c.boundary()).toBeUndefined();
    c.delivery.settled(c.ctx);
    c.ctx.signal = undefined;
    await c.finish(0);
    expect(c.statuses).toEqual([undefined, "1 unread child result"]);
    expect(c.children.unread().map((result) => result.id)).toEqual([run.id]);
    expect(c.children.pruneCollected()).toBe(0);
    c.ctx.signal = new AbortController().signal;
    c.delivery.started(c.ctx);
    c.delivery.turnStarted();
    expect(c.boundary()?.entries?.[0]).toMatchObject({ details: { handles: [run.handle] } });
    expect((await c.children.wait([run.id], 1))[0]!.output).toBe("PRIVATE_REPORT");
    await c.close();
  });

  test("bounded handle-only announcements never authorize eviction, regardless of report size", async () => {
    const c = controlled();
    for (let index = 0; index < MAX_RETAINED_RUNS; index++) {
      c.start();
      c.executions[index]!.finish({ output: "x".repeat(MAX_OUTPUT_BYTES) });
      await c.executions[index]!.done;
    }
    const notice = c.boundary()?.entries?.[0];
    expect(notice).toMatchObject({ details: { handles: c.children.list().map((result) => result.handle) } });
    expect(Buffer.byteLength(JSON.stringify(notice))).toBeLessThan(MAX_OUTPUT_BYTES);
    expect(JSON.stringify(notice)).not.toContain("xxxxx");
    expect(c.statuses.at(-1)).toBe(`${MAX_RETAINED_RUNS} unread child results`);
    expect(() => c.start()).toThrow("unread");
    expect(c.children.pruneCollected()).toBe(0);
    await c.children.wait([c.children.list()[0]!.id], 1);
    expect(c.start()).toBeDefined();
    await c.close();
  });

  test("shutdown fences status and boundary delivery before active cleanup completes", async () => {
    const c = controlled();
    c.start();
    await c.finish(0);
    c.start();
    c.delivery.close();
    const count = c.statuses.length;
    expect(c.statuses.at(-1)).toBeUndefined();
    c.delivery.refreshStatus();
    c.delivery.settled(c.ctx);
    c.delivery.started(c.ctx);
    c.delivery.turnStarted();
    expect(c.statuses).toHaveLength(count);
    expect(c.boundary()).toBeUndefined();
    await c.children.close();
    expect(c.statuses).toHaveLength(count);
    expect(c.delivery.inbox()).toEqual([]);
    expect(c.children.unread()).toEqual([]);
    expect(c.children.takePendingUsage()).toBeUndefined();
  });
});
