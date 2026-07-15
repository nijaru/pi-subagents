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

Parallel tasks that may mutate the same canonical `cwd` are rejected. Give read-only agents `capability: read`, use distinct directories, or use a serial chain.

### Sequential chain

```json
{"chain":[
  {"agent":"explore","task":"Map the relevant files."},
  {"agent":"worker","task":"Implement the fix using this report:\n\n{previous}"}
]}
```

`{previous}` is replaced with the preceding final text output. A chain stops at its first failed step.

## Agent definitions

Bundled agents ship in this package. User definitions live in `~/.pi/agent/agents/*.md`; project definitions live in the nearest `.pi/agents/*.md` and require project trust plus an interactive confirmation.

```markdown
---
name: reviewer
description: Review code for correctness
capability: read
tools: read, grep, find, ls
---

Review the requested code and report concrete findings.
```

Frontmatter fields:

- `name` and `description` are required.
- `tools` is an explicit pi tool allowlist. If omitted, the child gets no tools; it never inherits all tools. Supported pi built-ins include `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`.
- `capability` is effect metadata for scheduling safety, not a security sandbox. Omitted capability is conservatively treated as potentially mutating for parallel safety. A `read` profile must use only the known read-only tools (`read`, `grep`, `find`, `ls`, `code_search`, `web_search`, or `fetch_content`) and cannot delegate; unknown or mutation-capable tools invalidate the definition.
- `delegation: true` explicitly permits nested use of `subagent`; it defaults to `false`. Delegation is itself potentially mutating, so delegation-capable profiles must use `capability: write` or omit the capability. The bundled `architect` and `worker` are delegation-capable. Other bundled agents are leaves.
- `model` is optional and otherwise inherits the parent model.

Definitions with invalid control metadata are skipped. Project-agent task directories must stay inside the trusted project root. Bundled definitions can be overridden by user or project definitions with the same name.

## Models, transport, and limits

Every delegation starts a fresh `pi --mode json -p --no-session` subprocess. Task and system-prompt contents are written to temporary mode-0600 files instead of being placed in argv. Cancellation terminates the root process group, and normal completion also sweeps surviving descendants before shutdown.

Nested delegation is bounded by depth 3, a root-wide budget of 32 descendants, a shared limit of four live child processes, and one root deadline. These are guardrails, not a hostile-code sandbox: a Bash-capable child can intentionally launch processes outside the extension's control file or process group. Controls are propagated through an ephemeral mode-0600 control file and environment IDs; malformed control state fails closed. Each child has a 30-minute hard timeout, configurable up to two hours with `PI_SUBAGENT_TIMEOUT_MS` and bounded by the root deadline.

Only a small environment allowlist is copied. Additional provider variables require explicit `PI_SUBAGENT_PASSTHROUGH_ENV=NAME1,NAME2`; ambient secrets are not copied automatically.

A top-level `model` override applies to every mode. A task/chain item may also specify `model`. Resolution is top-level/item override, then agent definition, then the parent pi model. Inheritance passes the parent `provider/id`; runtime-registered providers or credentials are not copied into the child process, so those require child Pi configuration or the explicit environment passthrough policy.

The model-visible final result and each partial update use one deterministic 50 KiB output cap per tool call. Final assistant output is kept separately from bounded 16 KiB diagnostic message records; cumulative JSON message updates are counted by logical growth rather than repeatedly charged in full, with an independent raw stream cap. Stream input, stderr, diagnostics, stored messages, and rendering are bounded separately and malformed result details render safely. Thrown tool errors retain pi-agent-core error semantics; pi itself may discard custom `Error` fields, so callers must not depend on structured details surviving an error boundary.

The package targets the current pi CLI/API used by its `@earendil-works/pi-*` 0.80.x development dependencies. It does not add compatibility shims for older pi versions.

## Relationship to pi-workflows

`pi-subagents` is the process-isolated named-agent dispatcher. `pi-workflows` is a separate orchestration extension that owns its private in-process Pi SDK leaf sessions, durable journals, budgets, and lifecycle. Workflows should not invoke this public tool as its worker backend; that would create nested schedulers and duplicate accounting. If workflows later needs crash isolation, it can add a private leaf-process adapter without changing this public API.

## Future opt-ins

Persistent sessions, background run registries, and managed worktrees are deliberately not implemented as a subsystem. They can be added later as explicit opt-in features with their own persistence, cleanup, and mutation policies.

## Development

```bash
bun run check
```

No build step — pi loads the TypeScript extension directly.

## License

MIT
