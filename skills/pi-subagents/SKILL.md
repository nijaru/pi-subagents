---
name: pi-subagents
description: |
  Delegate work to specialized agents with single-agent, parallel, sequential-chain, bounded workflow, and session-scoped background modes.
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
| Workflow | `{ workflow: { start?, steps: [{ id, agent, task, onSuccess?, onFailure? }] } }` | Follow bounded success/failure branches serially; `{previous}` is the prior result |
| Background | `{ background: { action: "start"|"status"|"result"|"stop", runId?, agent?, task? } }` | Keep one child alive across tool calls in the current Pi session |

Use the top-level `model` to override any mode. Resolution is top-level/item override → agent definition → parent pi model. `cwd` defaults to the current project directory. A chain stops at its first failed step; a workflow can branch on success or failure and may loop only within the root descendant budget. Use parallel for independent fan-out.

`action: "list"` is the only top-level action and cannot be combined with a delegation mode. Background lifecycle actions live inside `background`; `start` accepts one agent/task, `status` accepts an optional runId, and `result`/`stop` require runId. Background runs are in-memory and session-scoped; they do not survive Pi restart.

## Agent policy

Definitions are Markdown files with YAML frontmatter. Required: `name`, `description`. Optional: `model`, `thinking`, `tools`, `capability`, and `delegation`. `thinking` sets an explicit reasoning effort (`minimal`…`max`); without it the child inherits the parent session's level.

- `tools` is an explicit allowlist. Missing tools means the child receives `--no-tools`, not pi's defaults.
- `capability: read` is effect metadata for scheduling safety, not a security sandbox; `capability: write` marks it potentially mutating. Omitted capability is conservatively potentially mutating. A read profile is accepted only with the known read-only tools (`read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `source_check`, `fetch_content`, `get_search_content`, `resolve-library-id`, or `query-docs`) and cannot delegate; unknown or mutation-capable tools invalidate the definition.
- `delegation: true` is required for nested `subagent` calls and defaults false. Delegation-capable profiles must use `capability: write` or omit the capability. Bundled `architect` and `worker` may delegate; other bundled agents are leaves.
- `outputSchema` is an optional bounded TypeBox-compatible JSON Schema. The child must return raw JSON matching it; malformed, fenced, or non-matching terminal output fails the delegation. Schemas are limited to 16 KiB and local `$ref` values.
- `allowedAgents` optionally restricts exact names available to nested calls. `maxDelegationDepth` optionally limits nested levels (`0` disables them; the global maximum is 3). Inherited parent policies only narrow a child policy.

For example:

```markdown
---
name: analyst
description: Return typed analysis
outputSchema:
  type: object
  properties:
    summary: { type: string }
  required: [summary]
  additionalProperties: false
---
Return JSON matching the schema.
```

Project agents are repository-controlled prompts. The current pi project must be trusted, UI sessions confirm before using them, and headless calls reject them. Project-agent task `cwd` values must remain inside the trusted project root. Parallel potentially mutating tasks sharing the same project root are rejected; distinct project roots may run concurrently. Use a serial chain for shared-worktree writes. Nested `action: "list"` is filtered by an inherited `allowedAgents` policy.

## Safety and limits

Every delegation starts a fresh `pi --mode json -p --no-session` subprocess. Tool names are passed through unchanged; current research profiles use `web_search` (native/default), `web_fetch`, and `web_research`, the exact Context7 names `resolve-library-id`/`query-docs`, and the optional unified `mcp` proxy when `pi-mcp-adapter` is installed. Metered providers are explicit rather than default. Task and system-prompt contents travel through temporary mode-0600 files, not argv. Cancellation terminates the root process group; normal completion also sweeps surviving descendants.

Nested calls propagate depth, run/parent/root IDs, deadline, timeout, explicit passthrough-env policy, and ephemeral mode-0600 control/policy files. The root-wide limits are depth 3, 32 total descendants, four active child slots, at most 16 declared workflow nodes, and a 128 KiB nested-policy bound. Nested callers temporarily yield their parent slot while waiting for descendants, so recursive delegation does not starve behind a full sibling fan-out; active slots are work capacity, not a guarantee that waiting ancestor processes consume no memory. These are guardrails rather than a hostile-code sandbox: a Bash-capable child can intentionally launch outside the extension's control file or process group. Each process has a 30-minute hard timeout, configurable up to two hours with `PI_SUBAGENT_TIMEOUT_MS`, and bounded by the root deadline.

Env is allowlisted. Standard Pi model credentials, all `$VAR` refs from `~/.pi/agent/models.json`, and credential-shaped `*_API_KEY`/`*_TOKEN` variables are passed, including nested model and research-tool credentials. Arbitrary application variables are still excluded by default. For other variables, set `PI_SUBAGENT_PASSTHROUGH_ENV` with exact names or globs. `*` passes all env (insecure). Best: `pi /login` stores credentials in `~/.pi/agent/auth.json` when supported. The model-visible final result and partial updates use one deterministic 50 KiB cap per tool call; final output is separate from bounded message records. Pi 0.84 JSON `message_update` events are delta-only and intentionally ignored for parent previews so token streams do not render word by word; `message_end` remains authoritative and tool lifecycle events provide coarse progress. Stream data, stderr, diagnostics, stored messages, and rendering are bounded too.

Task input is capped at 100 KiB; discovery keeps at most 256 lexicographically earliest Markdown definitions, with 256 KiB per file and 4 MiB of file contents. Result details include bounded typed pi messages, usage, stop reasons, explicit termination (`completed`, `failed`, `cancelled`, or `timed_out`), run/depth IDs where available, and a parsed `structuredOutput` value when an agent schema is configured and the value fits the result bound. Oversized provider metadata is omitted from retained message history rather than growing it past the 16 KiB per-message bound. A child must emit a terminal assistant response (`stop` or `length`); tool-use turns alone are not successful output. Plain-text agents and chain interpolation remain unchanged; structured output must be the complete terminal response, no larger than 50 KiB, with no Markdown fences or surrounding prose. Thrown tool errors preserve pi-agent-core semantics; custom `Error` fields may be dropped by pi, so structured details are not guaranteed on failures. Malformed subprocess JSON and malformed result details are ignored or rendered safely.

`pi-workflows` is a separate orchestration extension with private in-process SDK leaf sessions; it should not invoke this public tool as its worker backend. A future process-isolated workflow adapter, if needed, should be a private leaf runner rather than nested public scheduling.

Background runs are bounded to four active and eight retained handles per extension instance. Persistent sessions, managed worktrees, artifacts, and peer coordination remain future explicit opt-ins, not part of this tool.
