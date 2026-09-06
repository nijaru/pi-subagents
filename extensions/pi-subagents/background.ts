import type { AgentScope } from "./agents.ts";
import { MAX_BACKGROUND_RUNS, MAX_DIAGNOSTIC_BYTES } from "./limits.ts";
import type { AgentResult, BackgroundRunDetails, BackgroundRunStatus, SubagentDetails } from "./types.ts";
import { truncateOutput } from "./bounds.ts";
import type { ControlContext } from "./control.ts";
import { failed } from "./supervisor.ts";
import { formatDuration } from "./render.ts";

export interface BackgroundRun {
  details: BackgroundRunDetails;
  task: string;
  cwd: string;
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  projectRoot: string;
  mutating: boolean;
  control: ControlContext;
  controller: AbortController;
  result?: AgentResult;
  promise?: Promise<AgentResult>;
  cleanedUp: boolean;
}

export function backgroundActive(run: BackgroundRun): boolean {
  return run.details.status === "starting" || run.details.status === "running";
}

export function backgroundStatus(result: AgentResult): BackgroundRunStatus {
  if (result.termination === "cancelled") return "cancelled";
  if (result.termination === "timed_out") return "timed_out";
  return failed(result) ? "failed" : "completed";
}

export function backgroundSummary(run: BackgroundRun): BackgroundRunDetails {
  return { ...run.details, progress: run.details.progress ? truncateOutput(run.details.progress, MAX_DIAGNOSTIC_BYTES) : undefined };
}

export function pruneBackgroundRuns(runs: Map<string, BackgroundRun>): void {
  if (runs.size < MAX_BACKGROUND_RUNS) return;
  const terminal = [...runs.values()]
    .filter((run) => !backgroundActive(run) && run.cleanedUp)
    .sort((left, right) => (left.details.finishedAt ?? left.details.createdAt) - (right.details.finishedAt ?? right.details.createdAt));
  while (runs.size >= MAX_BACKGROUND_RUNS && terminal.length > 0) {
    const run = terminal.shift()!;
    runs.delete(run.details.runId);
  }
}

export function backgroundToolDetails(
  action: SubagentDetails["action"],
  run?: BackgroundRun,
  results: AgentResult[] = [],
  summaries: BackgroundRunDetails[] = [],
): SubagentDetails {
  return {
    action,
    mode: "background",
    background: run ? backgroundSummary(run) : undefined,
    backgroundRuns: summaries.length > 0
      ? summaries.slice(-MAX_BACKGROUND_RUNS).map((summary) => ({ ...summary, progress: summary.progress ? truncateOutput(summary.progress, 512) : undefined }))
      : undefined,
    agentScope: run?.agentScope ?? "user",
    projectAgentsDir: run?.projectAgentsDir ?? null,
    runId: run?.details.runId ?? "background",
    rootRunId: run?.control.rootRunId ?? "background",
    depth: 0,
    deadlineMs: run?.control.deadlineMs ?? 0,
    results,
  };
}

export function backgroundText(run: BackgroundRun): string {
  const status = run.details.status;
  const duration = formatDuration(run.details.startedAt, run.details.finishedAt);
  const runtime = duration ? ` [${duration}${backgroundActive(run) ? " elapsed" : ""}]` : "";
  const progress = run.details.progress ? `\n${truncateOutput(run.details.progress, MAX_DIAGNOSTIC_BYTES)}` : "";
  return `Background ${status}${runtime}: ${run.details.agent} (${run.details.runId})${progress}`;
}
