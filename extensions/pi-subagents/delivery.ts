import type { AgentBeforeSettleEvent, AgentEndEvent, BoundaryResult, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
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
  private suppressDelivery = false;

  constructor(private readonly children: SessionChildren) {}

  bind(ctx: ExtensionContext): void { this.ctx = ctx; }

  refreshStatus(): void {
    if (this.closed) return;
    const count = this.children.pendingCompletions().length;
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
      const details = entry.details as Partial<SubagentDetails> | undefined;
      if (Array.isArray(details?.results)) {
        for (const result of details.results) if (typeof result?.id === "string") ids.add(result.id);
      }
    }
    const dropped = this.children.reconcileCompletions(ids);
    if (dropped) this.suppressDelivery = true;
    this.refreshStatus();
    return dropped;
  }

  boundary(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext): BoundaryResult | undefined {
    if (this.closed) return;
    this.reconcile(ctx);
    this.suppressDelivery ||= event.outcome !== "completed";
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
