/** Maximum active children owned by one parent session. Admission rejects; it never queues unbounded work. */
export const MAX_CONCURRENCY = 4;
export const MAX_RETAINED_RUNS = 32;
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_MESSAGES_PER_AGENT = 128;
export const MAX_STDERR_BYTES = 50 * 1024;
export const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
export const MAX_TASK_BYTES = 100 * 1024;
export const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 120_000;
export const RUNTIME_UPDATE_INTERVAL_MS = 1_000;
export const RUNNING_PROGRESS_TEXT = "Working...";
export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const TIMEOUT_ENV = "PI_SUBAGENT_TIMEOUT_MS";
export const PASSTHROUGH_ENV = "PI_SUBAGENT_PASSTHROUGH_ENV";
export const SUBAGENT_BIN_ENV = "PI_SUBAGENT_BIN";
export const PI_BIN_ENV = "PI_BIN";

export function processTimeoutMs(): number {
  const configured = Number(process.env[TIMEOUT_ENV]);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= MAX_PROCESS_TIMEOUT_MS
    ? configured : DEFAULT_PROCESS_TIMEOUT_MS;
}

/** Invalid or nonzero depth fails closed. Children cannot use this extension to delegate. */
export function isChildProcess(): boolean {
  const depth = process.env[DEPTH_ENV];
  return depth !== undefined && depth !== "0";
}
