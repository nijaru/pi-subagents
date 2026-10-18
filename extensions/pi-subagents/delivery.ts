import type { AgentBeforeSettleEvent, AgentEndEvent, BoundaryResult, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { SessionChildren } from "./children.ts";

/** Readiness announcements never contain or acknowledge the child's report. */
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
    this.children.resetContinuationNotices();
  }

  ended(event: AgentEndEvent, ctx: ExtensionContext): void {
    this.bind(ctx);
    const last = event.messages.findLast((message) => message.role === "assistant");
    if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) this.suppressDelivery = true;
  }

  boundary(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined {
    if (this.closed) return;
    this.bind(ctx);
    this.suppressDelivery ||= event.outcome !== "completed" || ctx.signal?.aborted === true;
    if (this.suppressDelivery) return;
    const results = this.children.pendingCompletions();
    if (!results.length) return;
    // One attempt per child per parent run avoids continuation loops even if a
    // later extension drops this draft. Reports remain unread, discoverable in
    // the inbox/status, and eligible again on the next parent run.
    this.children.offerCompletions(results.map((result) => result.id));
    const handles = results.map((result) => result.handle ?? result.id);
    return {
      entries: [...event.entries, {
        type: "custom_message", customType: "subagent-ready", display: true,
        content: `Child results ready: ${handles.join(", ")}. Read them with subagent wait; this notice does not contain their reports.`,
        details: { handles },
      }],
      continue: true,
    };
  }

  settled(ctx: ExtensionContext): void {
    if (this.closed) return;
    this.bind(ctx);
    this.refreshStatus();
    // Never wake an idle parent: Pi has no reliable late idle-abort signal.
  }

  close(): void {
    this.closed = true;
    try { this.ctx?.ui?.setStatus("subagents", undefined); } catch { /* Host may already be gone. */ }
  }
}
