import type { AgentBeforeSettleEvent, AgentEndEvent, BoundaryResult, ExtensionContext, MessageEndEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { boundDetails } from "./bounds.ts";
import { SessionChildren } from "./children.ts";
import { MAX_COMPLETION_BYTES } from "./limits.ts";
import { childReports } from "./reports.ts";
import type { ChildResult, SubagentDetails } from "./types.ts";

function completionMessage(results: ChildResult[]) {
  return {
    customType: "subagent-complete",
    content: `${results.length === 1 ? "Background child finished." : "Background children finished."}\n${childReports(results, { maxReportBytes: MAX_COMPLETION_BYTES })}`,
    display: true,
    details: boundDetails({ command: "wait", results }),
  };
}

function completionIds(details: unknown): string[] {
  const results = (details as Partial<SubagentDetails> | undefined)?.results;
  return Array.isArray(results) ? results.flatMap((result) => typeof result?.id === "string" ? [result.id] : []) : [];
}

/** Host turn policy only. SessionChildren owns whether a result is still unread. */
export class CompletionDelivery {
  private ctx?: ExtensionContext;
  private closed = false;
  private suppressDelivery = false;

  constructor(private readonly children: SessionChildren) {}

  bind(ctx: ExtensionContext): void { this.ctx = ctx; }

  refreshStatus(): void {
    if (this.closed) return;
    const count = this.children.unreadCompletionCount();
    try { this.ctx?.ui?.setStatus("subagents", count ? `${count} unread child result${count === 1 ? "" : "s"}` : undefined); } catch { /* Display is best effort. */ }
  }

  started(ctx: ExtensionContext): void {
    this.bind(ctx);
    this.suppressDelivery = false;
  }

  ended(event: AgentEndEvent, ctx: ExtensionContext): void {
    this.bind(ctx);
    const last = event.messages.findLast((message) => message.role === "assistant");
    if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) this.suppressDelivery = true;
  }

  /** Called after a boundary has committed, not while its draft is being built. */
  reconcile(ctx: ExtensionContext): boolean {
    this.bind(ctx);
    if (!this.children.hasOfferedCompletions()) return false;
    const ids = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom_message" || entry.customType !== "subagent-complete") continue;
      for (const id of completionIds(entry.details)) ids.add(id);
    }
    const dropped = this.children.reconcileCompletions(ids);
    if (dropped) this.suppressDelivery = true;
    this.refreshStatus();
    return dropped;
  }

  responded(event: MessageEndEvent, ctx: ExtensionContext): void {
    if (this.closed || ctx.signal?.aborted || event.message.role !== "assistant") return;
    if (!["stop", "toolUse", "length"].includes(event.message.stopReason)) return;
    this.reconcile(ctx);
    if (!this.children.hasPublishedCompletions()) return;
    // A successful assistant response acknowledges the preceding visible notices
    // before its tools run, so admission can reclaim their retained handles.
    // This is canonical-context evidence, not a provider-specific wire receipt.
    const ids = new Set<string>();
    for (const entry of ctx.sessionManager.buildSessionProjection().entries) {
      const source = entry.sourceEntry;
      if (source.type !== "custom_message" || source.customType !== "subagent-complete") continue;
      // Do not acknowledge a notice removed, compacted or redacted out of context.
      if (!entry.messages.some((message) => message.role === "custom" && message.content === source.content)) continue;
      for (const id of completionIds(source.details)) ids.add(id);
    }
    this.children.acknowledgeCompletions(ids);
    this.refreshStatus();
  }

  boundary(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined {
    if (this.closed) return;
    this.reconcile(ctx);
    // Pi's outcome follows the assistant stop reason, so an aborted tool turn
    // can still report "completed". Publication alone is not acknowledgement:
    // a later boundary handler may abort before the next request starts.
    const stopped = event.outcome !== "completed" || ctx.signal?.aborted === true;
    this.suppressDelivery ||= stopped;
    // Never turn an abort or provider failure into an automatic restart.
    if (this.suppressDelivery) return;
    const results = this.children.pendingCompletions();
    if (!results.length) return;
    const message = completionMessage(results);
    this.children.offerCompletions(results.map((result) => result.id));
    this.refreshStatus();
    // Pi coalesces this with any naturally required next request. Unlike a
    // follow-up queue, a later wait cannot race a second prequeued delivery.
    return { entries: [...event.entries, { type: "custom_message", ...message }], continue: true };
  }

  settled(ctx: ExtensionContext): void {
    if (this.closed) return;
    this.reconcile(ctx);
    this.refreshStatus();
    // Pi exposes no late session abort signal. Neither settlement nor a later
    // completion may wake an idle parent: doing so can undo an invisible abort.
    // Reports remain unread for an active-turn boundary or an explicit join.
  }

  close(): void {
    this.closed = true;
    try { this.ctx?.ui?.setStatus("subagents", undefined); } catch { /* The host may already be gone. */ }
  }
}
