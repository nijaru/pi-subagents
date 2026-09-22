import type { AgentBeforeSettleEvent, AgentEndEvent, BoundaryResult, ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { boundDetails, truncateOutput } from "./bounds.ts";
import { SessionChildren } from "./children.ts";
import { MAX_COMPLETION_BYTES, MAX_OUTPUT_BYTES } from "./limits.ts";
import { runtimeLabel } from "./render.ts";
import { resultText } from "./supervisor.ts";
import type { ChildResult, SubagentDetails } from "./types.ts";

export function childSummary(result: ChildResult): string {
  const status = result.state.status === "running" ? "running" : result.state.outcome;
  return `${result.id} [${status}]${runtimeLabel(result) ? ` · ${runtimeLabel(result)}` : ""}\n${truncateOutput(result.prompt, 256)}`;
}

function completionMessage(results: ChildResult[]) {
  // Keep every child represented within one aggregate model-context budget.
  const perResult = Math.min(MAX_COMPLETION_BYTES, Math.floor(MAX_OUTPUT_BYTES / results.length) - 1024);
  const reports = results.map((result) => {
    const output = resultText(result);
    const excerpt = truncateOutput(output, perResult);
    const guidance = excerpt === output ? "" : "\n\nExcerpt truncated; use subagent wait with this id for the full retained result.";
    return `${childSummary(result)}\n\n${excerpt}${guidance}`;
  });
  return {
    customType: "subagent-complete",
    content: `${results.length === 1 ? "Background child finished." : "Background children finished."}\n${reports.join("\n\n---\n\n")}`,
    display: true,
    details: boundDetails({ command: "wait", results }),
  };
}

/** Host turn policy only. SessionChildren owns whether a result is still unread. */
export class CompletionDelivery {
  private ctx?: ExtensionContext;
  private closed = false;
  private scheduled = false;
  private suppressWake = false;

  constructor(private readonly pi: ExtensionAPI, private readonly children: SessionChildren) {}

  bind(ctx: ExtensionContext): void { this.ctx = ctx; }

  refreshStatus(): void {
    if (this.closed) return;
    const count = this.children.pendingCompletions().length;
    try { this.ctx?.ui?.setStatus("subagents", count ? `${count} unread child result${count === 1 ? "" : "s"}` : undefined); } catch { /* Display is best effort. */ }
  }

  started(ctx: ExtensionContext): void {
    this.bind(ctx);
    this.suppressWake = false;
  }

  ended(event: AgentEndEvent, ctx: ExtensionContext): void {
    this.bind(ctx);
    const last = event.messages.findLast((message) => message.role === "assistant");
    if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) this.suppressWake = true;
  }

  /** Called after a boundary has committed, not while its draft is being built. */
  reconcile(ctx: ExtensionContext): boolean {
    this.bind(ctx);
    if (!this.children.hasOfferedCompletions()) return false;
    const ids = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom_message" || entry.customType !== "subagent-complete") continue;
      const details = entry.details as Partial<SubagentDetails> | undefined;
      if (Array.isArray(details?.results)) {
        for (const result of details.results) if (typeof result?.id === "string") ids.add(result.id);
      }
    }
    const dropped = this.children.reconcileCompletions(ids);
    if (dropped) this.suppressWake = true;
    this.refreshStatus();
    return dropped;
  }

  boundary(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined {
    if (this.closed) return;
    this.reconcile(ctx);
    this.suppressWake ||= event.outcome !== "completed";
    // Never turn an abort or provider failure into an automatic restart.
    if (this.suppressWake) return;
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
    // Pi exposes no session abort signal after the low-level run. An abort
    // during another async pre-settlement hook can therefore be invisible here.
    // Never start work from settlement itself: late results remain visible in
    // the status indicator until a natural turn or an explicit wait reads them.
  }

  ready(): void {
    if (this.closed) return;
    this.refreshStatus();
    // Check idleness when completion occurs as well as when the microtask runs.
    // Busy-to-idle transition alone must not resurrect an aborted parent.
    if (this.scheduled || this.suppressWake || !this.ctx?.isIdle()) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed || this.suppressWake || !this.ctx?.isIdle()) return;
      const results = this.children.pendingCompletions();
      if (!results.length) return;
      // Only idle parents are woken directly. While busy, ownership stays here
      // until a turn boundary or a tool result delivers the report.
      try {
        this.pi.sendMessage(completionMessage(results), { triggerTurn: true });
        this.children.acknowledgeCompletions(results.map((result) => result.id));
        this.refreshStatus();
      } catch {
        // Keep the report readable; presentation failures must not crash Pi or
        // create an automatic retry loop while the host rejects messages.
        this.suppressWake = true;
      }
    });
  }

  close(): void {
    this.closed = true;
    try { this.ctx?.ui?.setStatus("subagents", undefined); } catch { /* The host may already be gone. */ }
  }
}
