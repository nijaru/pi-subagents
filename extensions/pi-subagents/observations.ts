import type { StopReason } from "@earendil-works/pi-ai";
import { boundedDiagnostic } from "./bounds.ts";
import { timeoutSummary, withCredentialHint } from "./reports.ts";
import { ChildTranscript } from "./transcript.ts";
import { addUsage, emptyUsage, isUsage, textFromMessage, type ChildActivity, type ChildResult, type UsageRecord } from "./types.ts";
import type { ChildEvent } from "./rpc.ts";
import type { ExecutionOutcome, ExecutionEnd } from "./execution.ts";

type Observation = Pick<ChildResult, "usage" | "lastActivityAt" | "activity" | "currentTool" | "output" | "outputTruncation" | "errorMessage">;

/** Reduces public RPC events to bounded evidence. No process, timers, or callbacks. */
export class ChildObservations {
  private readonly transcript = new ChildTranscript();
  private readonly usage = emptyUsage();
  private readonly tools = new Map<string, number>();
  private open = false;
  private streamingUsage?: UsageRecord;
  private stopReason?: StopReason;
  private errorMessage?: string;
  private lastActivityAt?: number;
  private activity?: ChildActivity;
  private stopped = false;

  constructor(private readonly allowedTools: readonly string[]) {}

  get activityKey(): string { return `${this.activity ?? ""}/${this.currentTool ?? ""}`; }

  get currentTool(): string | undefined { return [...this.tools.keys()].at(-1); }

  private record(kind?: ChildActivity): void {
    this.lastActivityAt = Date.now();
    this.activity = this.tools.size ? "tool" : kind;
  }

  /** Returns whether observations changed; background usage is not foreground activity. */
  accept(event: ChildEvent): boolean {
    if (this.stopped) return false;
    switch (event.type) {
      case "turn_start": this.record("model"); break;
      case "message_start":
        if (event.message?.role !== "assistant") return false;
        this.transcript.start(); this.streamingUsage = undefined; this.open = true;
        this.record("model");
        break;
      case "message_update": {
        if (isUsage(event.usage)) this.streamingUsage = structuredClone({ ...event.usage, turns: 0 });
        const update = event.assistantMessageEvent;
        switch (update?.type) {
          case "text_start": this.transcript.startBlock(update.contentIndex); this.record("text"); break;
          case "text_delta":
            if (typeof update.delta !== "string") throw new Error("Child RPC emitted a malformed text delta.");
            this.open = true;
            this.transcript.append(update.contentIndex, update.delta); this.record("text");
            break;
          case "text_end":
            if (typeof update.content !== "string") throw new Error("Child RPC emitted malformed completed text.");
            this.transcript.completeBlock(update.contentIndex, update.content); this.record("text");
            break;
          case "thinking_start": case "thinking_delta": case "thinking_end": this.record("thinking"); break;
          case "start": case "toolcall_start": case "toolcall_delta": case "toolcall_end": this.record("model"); break;
          case "done": case "error": this.record(); break;
          default: return false;
        }
        break;
      }
      case "message_end":
        if (event.message?.role === "assistant") {
          const message = event.message;
          this.open = false;
          this.stopReason = message.stopReason;
          this.errorMessage = boundedDiagnostic(message.errorMessage);
          this.transcript.finish(textFromMessage(message), message.stopReason);
          this.usage.turns++;
          if (isUsage(message.usage)) addUsage(this.usage, message.usage);
          else if (this.streamingUsage) addUsage(this.usage, this.streamingUsage);
          this.streamingUsage = undefined;
          this.record();
        } else if (event.message?.role === "toolResult" && isUsage(event.message.usage)) addUsage(this.usage, event.message.usage);
        else return false;
        break;
      case "entry_appended":
        // Compaction entries repeat compaction_end; only standalone usage is billed here.
        if (event.entry?.type !== "usage" || !isUsage(event.entry.usage)) return false;
        addUsage(this.usage, event.entry.usage);
        break;
      case "auto_retry_start": case "summarization_retry_scheduled": this.record("retry"); break;
      case "compaction_start": case "summarization_retry_attempt_start": this.record("compaction"); break;
      case "auto_retry_end": this.record(); break;
      case "compaction_end":
        if (isUsage(event.result?.usage)) addUsage(this.usage, event.result.usage);
        this.record();
        break;
      case "tool_execution_start":
        if (this.allowedTools.includes(event.toolName)) {
          const count = this.tools.get(event.toolName) ?? 0;
          this.tools.delete(event.toolName);
          this.tools.set(event.toolName, count + 1);
        }
        this.record("tool");
        break;
      case "tool_execution_update": this.record("tool"); break;
      case "tool_execution_end": {
        const count = this.tools.get(event.toolName) ?? 0;
        if (count > 1) this.tools.set(event.toolName, count - 1);
        else this.tools.delete(event.toolName);
        this.record();
        break;
      }
      default: return false;
    }
    return true;
  }

  /** Finalize in-flight usage once, freezing interruption evidence before cleanup. */
  stop(interrupted: boolean): ChildResult["interruption"] {
    if (this.stopped) return;
    const interruption = interrupted ? {
      activity: this.activity, currentTool: this.currentTool,
      activeToolCount: [...this.tools.values()].reduce((sum, count) => sum + count, 0),
    } : undefined;
    if (this.open) {
      this.usage.turns++;
      if (this.streamingUsage) addUsage(this.usage, this.streamingUsage);
    }
    this.stopped = true;
    this.streamingUsage = undefined;
    this.tools.clear();
    this.activity = undefined;
    return interruption;
  }

  snapshot(mode: "live" | "history" | "reports" = "live"): Observation {
    return { ...this.transcript.snapshot(mode), usage: structuredClone(this.usage),
      lastActivityAt: this.lastActivityAt, activity: this.activity,
      currentTool: this.currentTool, errorMessage: this.errorMessage };
  }

  outcome(end: ExecutionEnd): ExecutionOutcome {
    if (end.kind === "deadline") return {
      outcome: "timed_out", stopReason: "error", errorKind: "deadline", timeoutPhase: end.phase,
      errorMessage: timeoutSummary(end.elapsed, end.budget, end.phase),
    };
    if (end.kind === "cancelled") return {
      outcome: "cancelled", stopReason: "aborted", errorKind: "cancelled", errorMessage: "Subagent cancelled.",
    };
    if (end.kind === "failure") return {
      outcome: "failed", stopReason: "error", errorKind: end.startup ? "startup" : "protocol",
      errorMessage: withCredentialHint(end.message),
    };
    switch (this.stopReason) {
      case "error": return { outcome: "failed", stopReason: "error", errorKind: "provider", errorMessage: withCredentialHint(this.errorMessage || "Child provider returned an error.") };
      case "length": return { outcome: "incomplete", stopReason: "length", errorKind: "provider", errorMessage: "Child reached the model output limit; response is incomplete." };
      case "aborted": return { outcome: "cancelled", stopReason: "aborted", errorKind: "cancelled", errorMessage: this.errorMessage || "Child aborted." };
      case "stop": if (this.transcript.snapshot().output) return { outcome: "completed", stopReason: "stop" };
    }
    return { outcome: "failed", stopReason: "error", errorKind: "protocol", errorMessage: this.errorMessage || "Child produced no terminal assistant output; a final response is required." };
  }
}
