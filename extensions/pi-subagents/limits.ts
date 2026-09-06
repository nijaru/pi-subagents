export const MAX_DEPTH = 3;

export const MAX_PARALLEL_TASKS = 8;

/** Maximum active child reservations across an entire recursive delegation tree. */
export const MAX_CONCURRENCY = 4;

/** Total child processes a root delegation may ever create. */
export const MAX_DESCENDANTS = 32;

export const MAX_OUTPUT_BYTES = 50 * 1024;

export const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

export const MAX_MESSAGE_BYTES = 16 * 1024;

export const MAX_MESSAGES_PER_AGENT = 128;

export const MAX_STDERR_BYTES = 50 * 1024;

/** Maximum protocol line retained or parsed from the child stream. */
export const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;

export const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;

export const MAX_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const MAX_TASK_BYTES = 100 * 1024;

export const MAX_CHAIN_STEPS = 32;

/** Maximum declared nodes in one opt-in workflow. */
export const MAX_WORKFLOW_STEPS = 16;

/** Workflow transitions remain bounded by the root descendant budget. */
export const MAX_WORKFLOW_TRANSITIONS = MAX_DESCENDANTS;

/** Maximum concurrently running top-level background children. */
export const MAX_BACKGROUND_ACTIVE = MAX_CONCURRENCY;

/** Maximum background handles retained by one extension instance. */
export const MAX_BACKGROUND_RUNS = 8;

export const MAX_CHAIN_CONTEXT_BYTES = 50 * 1024;

export const MAX_STRUCTURED_OUTPUT_BYTES = MAX_OUTPUT_BYTES;

export const MAX_DELEGATION_POLICY_BYTES = 128 * 1024;

export const RUNTIME_UPDATE_INTERVAL_MS = 1_000;

export const RUNNING_PROGRESS_TEXT = "Working...";

export const CONTROL_LOCK_STALE_MS = 5_000;

export const CONTROL_LOCK_WAIT_MS = 10_000;

export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";

export const RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";

export const PARENT_ID_ENV = "PI_SUBAGENT_PARENT_ID";

export const ROOT_ID_ENV = "PI_SUBAGENT_ROOT_ID";

export const CONTROL_ENV = "PI_SUBAGENT_CONTROL_FILE";

export const DEADLINE_ENV = "PI_SUBAGENT_DEADLINE_MS";

export const BUDGET_ENV = "PI_SUBAGENT_BUDGET_REMAINING";

export const DELEGATION_POLICY_ENV = "PI_SUBAGENT_DELEGATION_POLICY";

export const DELEGATION_POLICY_FILE_ENV = "PI_SUBAGENT_DELEGATION_POLICY_FILE";

export const TIMEOUT_ENV = "PI_SUBAGENT_TIMEOUT_MS";

export const PASSTHROUGH_ENV = "PI_SUBAGENT_PASSTHROUGH_ENV";

export const SUBAGENT_BIN_ENV = "PI_SUBAGENT_BIN";

export const PI_BIN_ENV = "PI_BIN";

export const CONTROL_VERSION = 2;
