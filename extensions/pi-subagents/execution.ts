import type { ModelThinkingLevel, StopReason } from "@earendil-works/pi-ai";
import type { AgentOutcome, ChildResult, UsageSummary } from "./types.ts";

/** Immutable launch specification, independent of presentation and delivery. */
export interface ChildTask {
  readonly id: string;
  readonly prompt: string;
  readonly label?: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly strictThinking?: boolean;
  readonly persist?: boolean;
  readonly resume?: string;
  readonly trustProject?: boolean;
  readonly excludeTools?: readonly string[];
  readonly executionTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface ExecutionFacts {
  startedAt: number;
  taskFinishedAt?: number;
  deadline?: { phase: "startup" | "execution"; startedAt: number; expiresAt: number };
  sessionFile?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  lastActivityAt?: number;
  activity?: ChildResult["activity"];
  currentTool?: string;
  interruption?: ChildResult["interruption"];
  output?: string;
  outputTruncation?: ChildResult["outputTruncation"];
  errorMessage?: string;
  stderr: string;
  usage: UsageSummary;
}
export interface ExecutionOutcome {
  outcome: AgentOutcome;
  stopReason?: StopReason;
  errorMessage?: string;
  errorKind?: "startup" | "provider" | "protocol" | "deadline" | "cancelled" | "unknown";
  timeoutPhase?: "startup" | "execution";
}
export interface ExecutionReport extends ExecutionFacts, ExecutionOutcome {
  finishedAt: number;
  cleanup: { status: "confirmed" } | { status: "unconfirmed"; error: string };
}
export type ExecutionSnapshot =
  | { status: "active"; phase: "starting" | "running" | "stopping"; facts: ExecutionFacts }
  | { status: "finished"; report: ExecutionReport };

/** Construct without effects; start only after the registry has reserved admission. */
export interface ChildExecution {
  readonly done: Promise<ExecutionReport>;
  start(onUpdate?: (progress?: string) => void): void;
  snapshot(): ExecutionSnapshot;
  cancel(): void;
  steer(message: string, signal?: AbortSignal): Promise<void>;
}
export interface ChildSupervisor { create(task: ChildTask): ChildExecution; }

/** First terminal cause wins, independently of subsequent cleanup disposition. */
export type ExecutionEnd = { kind: "settled" } | { kind: "cancelled" }
  | { kind: "deadline"; phase: "startup" | "execution"; budget: number; elapsed: number }
  | { kind: "failure"; message: string; startup: boolean };
