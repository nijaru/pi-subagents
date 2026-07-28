---
name: pi-subagents
description: |
  Delegate work to specialized agents with single-agent, parallel, and sequential-chain workflows.
  Use for review, implementation handoffs, and bounded recursive delegation.
---

# Pi Subagents

Use the `subagent` tool to delegate focused work to isolated pi subprocesses.

## Contract

The tool accepts exactly one mode:

| Mode | Shape | Behavior |
|---|---|---|
| Single | `{ agent, task }` | Run one agent and return its final output |
| Parallel | `{ tasks: [{ agent, task, model?, cwd? }] }` | Run up to 8 tasks with bounded concurrency |
| Chain | `{ chain: [{ agent, task, model?, cwd? }] }` | Run steps serially; `{previous}` is the preceding final output |

Use the top-level `model` to override any mode. Resolution is top-level/item override → agent definition → parent pi model. `cwd` defaults to the current project directory. A chain stops at its first failed step.

`action: "list"` is the only action and cannot be combined with a delegation mode. Its successful metadata result is available to the model but intentionally renders no body in the interactive TUI.

## Agent policy

Definitions are Markdown files with YAML frontmatter. Required: `name`, `description`. Optional: `model`, `tools`, `capability`, and `delegation`.

- `tools` is an explicit allowlist. Missing tools means the child receives `--no-tools`, not pi's defaults.
- `capability: read` is effect metadata for scheduling safety, not a security sandbox; `capability: write` marks it potentially mutating. Omitted capability is conservatively potentially mutating. A read profile is accepted only with the known read-only tools (`read`, `grep`, `find`, `ls`, `web_search`, `source_check`, `fetch_content`, `get_search_content`, `resolve-library-id`, or `query-docs`) and cannot delegate; unknown or mutation-capable tools invalidate the definition.
- `delegation: true` is required for nested `subagent` calls and defaults false. Delegation-capable profiles must use `capability: write` or omit the capability. Bundled `architect` and `worker` may delegate; other bundled agents are leaves.

Project agents are repository-controlled prompts. The current pi project must be trusted, UI sessions confirm before using them, and headless calls reject them. Project-agent task `cwd` values must remain inside the trusted project root. Parallel potentially mutating tasks sharing the same canonical cwd are rejected; distinct cwd values may run concurrently. Use a serial chain for shared-worktree writes.

## Safety and limits

Every delegation starts a fresh `pi --mode json -p --no-session` subprocess. Tool names are passed through unchanged; current research profiles use `web_search`/`fetch_content` (with Exa selected by `provider: "exa"`), the exact Context7 names `resolve-library-id`/`query-docs`, and the optional unified `mcp` proxy when `pi-mcp-adapter` is installed. Task and system-prompt contents travel through temporary mode-0600 files, not argv. Cancellation terminates the root process group; normal completion also sweeps surviving descendants.

Nested calls propagate depth, run/parent/root IDs, deadline, timeout, explicit passthrough-env policy, and an ephemeral mode-0600 control state. The root-wide limits are depth 3, 32 total descendants, and four live child processes. These are guardrails rather than a hostile-code sandbox: a Bash-capable child can intentionally launch outside the extension's control file or process group. A full shared semaphore fails fast rather than deadlocking active parents. Each process has a 30-minute hard timeout, configurable up to two hours with `PI_SUBAGENT_TIMEOUT_MS`, and bounded by the root deadline.

Env is allowlisted. Standard pi model credential variables and all `$VAR` refs from `~/.pi/agent/models.json` are passed, including JSONC configs and nested model/header references. No unrelated application secrets are copied by default. For custom tool vars, set `PI_SUBAGENT_PASSTHROUGH_ENV` with exact names or globs. `*` passes all env (insecure). Best: `pi /login` stores credentials in `~/.pi/agent/auth.json` — children need no env passthrough. The model-visible final result and partial updates use one deterministic 50 KiB cap per tool call; final output is separate from bounded message records, and cumulative message updates are charged by logical growth with an independent raw stream cap. Stream data, stderr, diagnostics, stored messages, and rendering are bounded too.

Result details include bounded typed pi messages, usage, stop reasons, and run/depth IDs where available. Thrown tool errors preserve pi-agent-core semantics; custom `Error` fields may be dropped by pi, so structured details are not guaranteed on failures. Malformed subprocess JSON and malformed result details are ignored or rendered safely.

`pi-workflows` is a separate orchestration extension with private in-process SDK leaf sessions; it should not invoke this public tool as its worker backend. A future process-isolated workflow adapter, if needed, should be a private leaf runner rather than nested public scheduling.

Persistent sessions, background registries, and managed worktrees are future explicit opt-ins, not part of this tool.
