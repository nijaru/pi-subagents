# pi-subagents

Declarative agent delegation for [pi](https://github.com/earendil-works/pi). Define agents as Markdown files and delegate work to them in isolated subprocesses.

## Install

```bash
pi install git:github.com/nijaru/pi-subagents
```

The extension registers one public tool: `subagent`.

## Modes

Use exactly one mode per call:

### Single

```json
{"agent":"reviewer","task":"Review the authentication changes for correctness."}
```

### Parallel

```json
{"tasks":[
  {"agent":"reviewer","task":"Review the implementation."},
  {"agent":"profiler","task":"Look for measurable performance regressions."}
]}
```

Up to eight tasks are accepted. Execution has a local and root-wide concurrency limit; results remain in input order.

Parallel tasks that may mutate the same project root are rejected. Give read-only agents `capability: read`, use distinct project roots, or use a serial chain.

### Sequential chain

```json
{"chain":[
  {"agent":"explore","task":"Map the relevant files."},
  {"agent":"worker","task":"Implement the fix using this report:\n\n{previous}"}
]}
```

`{previous}` is replaced with the preceding final text output. A chain stops at its first failed step.

### Bounded workflow

Use a workflow when the next agent depends on whether the previous run succeeded or failed. Nodes run serially through the same supervisor; `onSuccess` and `onFailure` select the next node, and `{previous}` carries the prior result. A missing next edge ends the workflow. Loops are allowed but bounded by the root descendant budget.

```json
{"workflow":{"start":"review","steps":[
  {"id":"review","agent":"reviewer","task":"Review the change.","onSuccess":"implement"},
  {"id":"implement","agent":"worker","task":"Apply the review:\n\n{previous}"}
]}}
```

Use `parallel` for independent fan-out; workflows are for dependent branches and bounded retries.

### Background runs

Use background mode only when the child should outlive the current tool call. It is an in-memory, session-scoped lifecycle: `start` returns a run id, `status` observes one run or all retained runs, `result` retrieves a completed result, and `stop` cancels a run and waits for cleanup. Background runs do not survive Pi restart and currently support one child at a time, not batches or workflows.

```json
{"background":{"action":"start","agent":"explore","task":"Run the long investigation."}}
{"background":{"action":"status","runId":"<run-id>"}}
{"background":{"action":"result","runId":"<run-id>"}}
{"background":{"action":"stop","runId":"<run-id>"}}
```

The registry allows four active and eight retained runs per extension instance. It shares the normal child supervisor, deadline, cancellation, process cleanup, and output bounds; it does not add persistence, worktrees, artifacts, or peer coordination.

## Agent definitions

Bundled agents ship in this package. User definitions live in `~/.pi/agent/agents/*.md`; project definitions live in the nearest `.pi/agents/*.md` and require project trust plus an interactive confirmation.

```markdown
---
name: reviewer
description: Use when a finished change needs independent fresh-context review.
capability: read
tools: read, grep, find, ls
---

Review the requested code and report concrete findings.
```

Pi selects agents from their name, description, and the parent task. Keep descriptions focused on **when to delegate**; put procedure and output detail in the body.

Frontmatter fields:

- `name` and `description` are required.
- `tools` is an explicit Pi tool allowlist. If omitted, the child gets no tools; it never inherits all tools. Supported Pi built-ins include `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. Tool names are passed through unchanged, so installed extension names must match exactly. Common current research tools include `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, and `query-docs`. The unified `mcp` proxy is also available when `pi-mcp-adapter` is installed.
- `capability` is effect metadata for scheduling safety, not a security sandbox. Omitted capability is conservatively treated as potentially mutating for parallel safety. A `read` profile must use only the known read-only tools (`read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, or `query-docs`) and cannot delegate; unknown or mutation-capable tools invalidate the definition.
- `delegation: true` explicitly permits nested use of `subagent`; it defaults to `false`. Delegation is itself potentially mutating, so delegation-capable profiles must use `capability: write` or omit the capability. Bundled agents are leaves by default; custom definitions can opt into bounded nested delegation when the role genuinely owns coordination.
- `model` is optional and otherwise inherits the parent model.
- `thinking` is an optional reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). Without it, the child inherits the parent session's thinking level; pi maps generic levels per model and drops them for non-reasoning models, so inheritance is safe across a model override.
- `outputSchema` is an optional bounded TypeBox-compatible JSON Schema. When present, the child is instructed to return raw JSON only; a malformed or non-matching terminal response is a failed delegation. Schemas are limited to 16 KiB and local `$ref` values.
- `allowedAgents` optionally restricts the exact agent names this definition may invoke through nested delegation. `maxDelegationDepth` optionally limits how many nested levels it may create (`0` disables nested calls; the global maximum is 3). An inherited parent policy can only narrow these limits.

Definitions with invalid control metadata or output schemas are skipped. Project-agent task directories must stay inside the trusted project root. Bundled definitions can be overridden by user or project definitions with the same name.

### Structured outputs

Opt in per agent when downstream steps need typed data:

```markdown
---
name: analyst
description: Use when a downstream workflow needs a compact structured analysis.
outputSchema:
  type: object
  properties:
    summary:
      type: string
    risks:
      type: array
      items:
        type: string
  required: [summary, risks]
  additionalProperties: false
---
Return the analysis as JSON matching the schema.
```

The parsed value is available as `structuredOutput` in bounded result details. Plain-text agents and existing chain interpolation remain unchanged. JSON must be the complete terminal assistant response; Markdown fences and surrounding prose are rejected.

Nested delegation can be narrowed per agent:

```markdown
---
name: coordinator
description: Use when one bounded coordinator should delegate only review work.
delegation: true
capability: write
allowedAgents: [reviewer, researcher]
maxDelegationDepth: 1
---
Delegate only the allowed review tasks.
```

Nested calls outside `allowedAgents` or beyond `maxDelegationDepth` fail before a child starts. The parent policy is intersected with the selected child's policy, so a child cannot broaden its parent's restriction.

## Models, transport, and limits

Every delegation starts a fresh `pi --mode json -p --no-session` subprocess. Task and system-prompt contents are written to temporary mode-0600 files instead of being placed in argv. Cancellation terminates the root process group, and normal completion also sweeps surviving descendants before shutdown.

Nested delegation is bounded by depth 3, a root-wide budget of 32 descendants, a shared limit of four active child slots, at most 16 declared workflow nodes, and one root deadline. Nested callers temporarily yield their parent slot while waiting for descendants, so recursive delegation does not starve behind a full sibling fan-out; the slot count is active work capacity, not a promise that waiting ancestor processes consume no memory. These are guardrails, not a hostile-code sandbox: a Bash-capable child can intentionally launch processes outside the extension's control file or process group. Controls are propagated through ephemeral mode-0600 files and environment IDs; state publication is atomic, policy transport is bounded to 128 KiB, and malformed control state fails closed. Each child has a 30-minute hard timeout, configurable up to two hours with `PI_SUBAGENT_TIMEOUT_MS` and bounded by the root deadline.

Environment is allowlisted. Children automatically receive standard Pi model credential variables, every `$VAR` reference from `~/.pi/agent/models.json`, and credential-shaped `*_API_KEY`/`*_TOKEN` variables. This lets nested agents use model, web research, documentation, GitHub, and similar credentials without manual setup while still excluding arbitrary application environment. `PI_SUBAGENT_PASSTHROUGH_ENV` supports exact names and globs for non-credential variables; `*` passes all env and is an explicit insecure opt-in. Best practice: store keys via `pi /login` into `~/.pi/agent/auth.json` when supported.

A top-level `model` override applies to every mode. A task/chain item may also specify `model`. Resolution is top-level/item override, then agent definition, then the parent pi model. Inheritance passes the parent `provider/id`; runtime-registered providers or credentials are not copied into the child process, so those require child Pi configuration or the explicit environment passthrough policy.

Task inputs are capped at 100 KiB, and agent discovery reads at most 256 Markdown definitions from a bounded streaming directory scan, with 256 KiB per file and 4 MiB of file contents. The model-visible final result and each partial update use one deterministic 50 KiB output cap per tool call. Final assistant output is kept separately from bounded 16 KiB diagnostic message records; oversized provider metadata is omitted from retained message history, and valid structured values are included when they fit the bounded result details. A result is successful only after a terminal assistant response (`stop` or `length`); tool-use turns alone are failures. Result details expose explicit termination states for completed, failed, cancelled, and timed-out runs. The child stream is framed incrementally with a 1 MiB per-line guard: oversized or ignored protocol lines are skipped so verbose tool traffic cannot reject a later valid final response, while cancellation, timeouts, and child failures still terminate the process. Pi 0.84 token-level `message_update` deltas are intentionally ignored for parent previews; `message_end` remains authoritative and tool lifecycle events still provide coarse progress. Background runs retain at most four active and eight bounded handles per extension instance, reject same-root foreground/background mutation overlap, and clean their control state on completion, stop, or session shutdown. Stream input, stderr, diagnostics, stored messages, and rendering are bounded separately and malformed result details render safely. Thrown tool errors retain pi-agent-core error semantics; pi itself may discard custom `Error` fields, so callers must not depend on structured details surviving an error boundary.

`action: "list"` returns the complete agent metadata to the model, while its successful result intentionally renders no body in the interactive TUI to avoid polluting the transcript.

The package targets the current Pi CLI/API used by its `@earendil-works/pi-*` 0.84.0 development dependencies. It does not add compatibility shims for older Pi versions.

## Relationship to pi-workflows

`pi-subagents` is the process-isolated named-agent dispatcher. `pi-workflows` is a separate orchestration extension that owns its private in-process Pi SDK leaf sessions, durable journals, budgets, and lifecycle. Workflows should not invoke this public tool as its worker backend; that would create nested schedulers and duplicate accounting. If workflows later needs crash isolation, it can add a private leaf-process adapter without changing this public API.

## Future opt-ins

Persistent sessions and managed worktrees are deliberately not implemented as subsystems. They can be added later as explicit opt-in features with their own persistence, cleanup, and mutation policies.

## Development

```bash
bun run check
```

No build step — pi loads the TypeScript extension directly.

## License

MIT
