import type { AgentBeforeSettleEvent, AgentEndEvent, BoundaryResult, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { SessionChildren } from "./children.ts";

/** Readiness announcements never contain or acknowledge the child's report. */
export class CompletionDelivery {
  private ctx?: ExtensionContext;
  private closed = false;
  // Latched for the external run: successful automatic retries do not rearm it.
  private suppressDelivery = false;
  private readonly attempted = new Set<string>();
  private readonly advertised = new Set<string>();

  constructor(private readonly children: SessionChildren) {}

  bind(ctx: ExtensionContext): void { this.ctx = ctx; }

  private prune(): void {
    for (const set of [this.attempted, this.advertised]) {
      for (const id of set) if (!this.children.has(id)) set.delete(id);
    }
  }

  refreshStatus(): void {
    if (this.closed) return;
    this.prune();
    const count = this.children.unread().length;
    try { this.ctx?.ui?.setStatus("subagents", count ? `${count} unread child result${count === 1 ? "" : "s"}` : undefined); } catch { /* Display is best effort. */ }
  }

  started(ctx: ExtensionContext): void {
    this.bind(ctx);
    this.suppressDelivery = false;
    this.attempted.clear();
  }

  turnStarted(): void { this.advertised.clear(); }

  inbox() {
    if (this.closed) return [];
    this.prune();
    const results = this.children.unread().filter((result) => !this.advertised.has(result.id));
    for (const result of results) this.advertised.add(result.id);
    return results;
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
    this.prune();
    const results = this.children.unread().filter((result) => !this.attempted.has(result.id));
    if (!results.length) return;
    // One attempt per child per parent run avoids continuation loops even if a
    // later extension drops this draft. Reports remain unread, discoverable in
    // the inbox/status, and eligible again on the next parent run.
    for (const result of results) this.attempted.add(result.id);
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
    this.attempted.clear();
    this.advertised.clear();
    try { this.ctx?.ui?.setStatus("subagents", undefined); } catch { /* Host may already be gone. */ }
  }
}
