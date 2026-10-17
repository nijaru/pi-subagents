# pi-subagents

Delegate a self-contained task to a fresh [Pi](https://github.com/earendil-works/pi) child, either foreground or background. The parent supplies the task—not a named role or workflow.

## Install

```bash
pi install npm:@nijaru/pi-subagents
```

Requires a Node/npm installation of Pi 1.0.4 or newer with its SDK files, and Node 22.19+ available to launch children. CI checks both the Pi 1.0.4 floor and the pinned development version (currently 1.3.0). Host-provided peer dependencies use `*` per Pi's package contract, not as a guarantee that every Pi version works. Standalone Pi binaries are not supported. Restart Pi or use `/reload`. The package registers one tool, `subagent`.

## Usage

Ask Pi to delegate a specific task, or use these tool-call shapes:

```json
{"command":"run","prompt":"Review the parser changes. Report concrete regressions with file/line and evidence. Do not edit files.","tools":["read"]}
```

`run` starts a child and joins it for up to `joinTimeoutMs` (60 seconds by default, or `PI_SUBAGENT_FOREGROUND_MS`). If the join expires, the child keeps working and the call returns a running handle. `joinTimeoutMs` is a join budget, never an execution deadline. Cancelling the call cancels the child.

For independent work while the parent continues:

```json
{"command":"spawn","prompt":"Implement the parser regression test in tests/parser.test.ts. Own only that file, run its tests, and report changes and results.","cwd":"../parser-worktree","executionTimeoutMs":900000}
{"command":"status"}
{"command":"wait","ids":["sa-4821"]}
{"command":"stop","id":"sa-4821"}
```

Every child gets a short session-scoped handle (`sa-<n>`, for example `sa-4821`) that `wait`, `status`, and `stop` accept in place of the full UUID. The number starts at a fresh random point each session, so a resumed transcript cannot immediately collide with a new child. Handles are never reused while retained. Up to 32 handles are retained; the oldest completed, read handle is evicted to admit new work. Unread results are never evicted.

### Completion delivery

`notify` controls how a finished child reaches the parent:

- **`inbox`** (default): the child does not spend a parent turn. The next top-level non-subagent tool result advertises unread handles, the footer shows the count, and `wait` retrieves the reports. `/subagents` lists retained children and unread state. An idle parent is never woken.
- **`turn`**: Pi offers one continuation turn at an active boundary when the child finishes, as in earlier releases. Unread results are batched into one notice. Aborts, provider errors, and dropped notices leave the report unread for an explicit `wait`.

Inbox delivery makes background work visible without adding a model turn and avoids the retraction/acknowledgment races of pushed notices. Turn delivery is opt-in when the child must resume the parent immediately.

Use `wait` before finishing a task that depends on child results. Pass one or more ids or handles: the call wakes when **any** selected child finishes, returns all ready reports, and identifies those still running. It waits up to five minutes by default, or up to ten minutes with `timeoutMs`. A longer budget does not delay early completion. Wait again only on remaining ids when their results block progress, rather than polling. `wait_expired: true` means the wait budget expired without a completed child; it is not an execution timeout.

`status` inspects one child or lists retained children. `stop` cancels one child and joins cleanup; it is safe to repeat. `run`, `wait`, and `stop` mark the completed reports they return as read. `status` does not consume a report.

### Time budgets

Four independent budgets avoid conflating readiness, work, joining, and cleanup:

| Budget | Default | Scope |
| --- | --- | --- |
| `startupTimeoutMs` | 30 seconds (`PI_SUBAGENT_STARTUP_TIMEOUT_MS`) | Process, watchdog, SDK, extensions, and MCP readiness before the task starts |
| `executionTimeoutMs` | 30 minutes (`PI_SUBAGENT_TIMEOUT_MS`) | Model/tool work, starting when the child reports ready |
| `joinTimeoutMs` | 60 seconds (`PI_SUBAGENT_FOREGROUND_MS`) | How long a `run` call blocks before returning a running handle |
| `timeoutMs` | 5 minutes | How long one `wait` call joins; never changes a child deadline |

`startupTimeoutMs` and `executionTimeoutMs` are run/spawn options within 5 minutes and 2 hours respectively. `joinTimeoutMs` applies only to `run`. At expiry the child is stopped and its result keeps partial output, with the cause naming the phase, elapsed runtime, and applied deadline. Cancel a wait without stopping its children; use `stop` for that. Cancelling `run` cancels its child.

Handles belong to the current parent session. All children stop on quit, reload, or session replacement. Background work requires a live parent process; a one-shot print invocation is not a persistent worker host.

The TUI hides agent-facing text — delegated prompts and child reports — behind expansion. Each child is one status line: live work and status listings carry a handle, phase, and one-line task label; finished children show outcome and duration, with the error message added for failures. Expand for the full prompt and report, diagnostics, working directory, tools, and usage. Turn-mode notices occupy one line; inbox results are advertised in the next top-level non-subagent tool result.

### Programmatic results

Codemode calls receive `{ command, results, waitExpired? }`, not report text. Each child carries its id, short handle, lifecycle `state`, live `phase` (running only), structured `errorKind`, `timeoutPhase` for deadline failures, bounded report and diagnostics, truncation metadata, and usage. The same bounded envelope is returned as tool `details`; the model still receives a text summary. Child reports do not have to be JSON. When launch context cannot fit, `omittedFields` identifies removed `prompt`, `cwd`, or `tools` fields; their empty placeholders are not execution values.

```javascript
const result = await tools.subagent({
  command: "run", prompt: "Review src/parser.ts. Return concrete findings; do not edit.", tools: ["read"],
});
for (const child of result.results) {
  text({ handle: child.handle, state: child.state, report: child.output, error: child.errorMessage });
}
```

Failed children remain structured results, even when Pi marks the call as a tool error. Inspect `state.outcome` rather than assuming that a resolved script call means success. Invalid requests and cancelled waits still reject. `waitExpired` distinguishes a wait budget expiring from a child execution timeout.

### Usage accounting

Child usage includes assistant calls, completed compaction summaries, and usage reported by child tools, including reported reasoning tokens. Summary calls do not increment the assistant-turn count. Reasoning tokens are a breakdown of output tokens, not extra tokens added to the total. After cleanup finishes, each child's usage is added once to the next parent tool result, including failed results. Repeated `status`, `wait`, or `stop` calls do not charge it again. Pi includes this usage in its footer, `/session`, and RPC totals.

Pi cannot attach usage to a custom completion message. Background costs therefore enter native totals only when another parent tool finishes; until then, they remain visible in the child details. Quit, reload, or session replacement discards any unreported usage, including usage from children stopped during shutdown. No extra tool call or model turn is created just to report costs.

### Tools and context

- Defaults are the parent's active tools among `read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, and `query-docs`. Mutation tools (`bash`, `edit`, `write`) must be requested explicitly. Research tools require their extensions; they are not supplied by this package.
- `tools` selects an explicit allowlist from tools active **or callable** in the parent, including codemode/deferred tools that are not declared to the model. Merely registered or hidden tools are not eligible. Selecting a tool does not activate it in the parent. `tools: []` is reasoning-only. An empty default selection is rejected rather than silently launching an unusable coding child.
- Children are leaves. The `subagent` tool cannot be passed to them, and nested calls are rejected.
- `model` optionally selects an exact `provider/model-id`; otherwise the parent's model is inherited. Fuzzy CLI model patterns are not accepted.
- `thinking` selects a Pi reasoning effort supported by that model, such as `high` or `xhigh`. Omitted effort inherits the parent's level for the same model; a different model uses its own Pi defaults (per-model setting, then the global default). An unsupported explicit effort fails before prompting rather than silently changing it. Pi may clamp inherited/default effort to model capabilities; reports and expanded details show the effective startup level.
- `cwd` defaults to the parent cwd; relative paths resolve against it.
- Every child starts a new conversation. The prompt should include scope, relevant evidence, constraints, expected output, and verification. Parent conversation history is not copied.

The subprocess loads its own Pi configuration, CLI built-in extensions (including codemode, tool search, and MCP), configured extensions, skills, and applicable `AGENTS.md` files. **Fresh context does not mean an empty system prompt.** Runtime-only tools, providers, credentials, and permission-hook state are not cloned from the parent; required integrations must also be configured in child Pi. Before submitting the task, the child verifies the requested model and tools against its own loaded integrations. An unavailable tool or model fails startup instead of silently reducing the child's capabilities. Explicit MCP tool names get up to ten seconds to register before startup fails. The tool allowlist also restricts nested calls: selecting `codemode` alone does not grant access to omitted MCP tools. Project resources follow Pi's noninteractive trust policy, including saved decisions and global `project_trust` hooks; parent-only trust decisions are not copied.

`tools` filters tool names, not extension code: child Pi still loads its configured extensions, so unrelated extension behavior (commands, hooks, providers) keeps running even when its tools are excluded. Use `tools: []` to give the model no tools; that is not a sandbox.

### When to delegate

Use `spawn` for independent work alongside useful, non-overlapping parent work. Use `run` when a fresh perspective or context-heavy investigation is worth waiting for. Keep routine lookups and tightly coupled edits local. The parent owns integration and verification; do not repeat the child's assignment while it runs.

Children are separate processes that share your working tree. The extension counts concurrency slots; it does not arbitrate write ownership, and it cannot guard the parent's own edits. Give concurrent writers distinct worktrees rather than relying on children to stay out of each other's way. Read-only children may overlap, but reading files while another process changes them does not provide a consistent snapshot.

## Limits and safety

| Resource | Limit |
|---|---|
| Active children | 4 per parent session; excess starts are rejected |
| Retained handles | 32; oldest completed, read handles are evicted first; unread results block admission rather than disappearing |
| Startup | 30 seconds by default (`PI_SUBAGENT_STARTUP_TIMEOUT_MS`, up to 5 minutes); covers process, watchdog, SDK, extensions, and MCP readiness |
| Foreground `run` | 60 seconds by default; `PI_SUBAGENT_FOREGROUND_MS` or `joinTimeoutMs` changes it, and expiry returns a running handle |
| Child execution | 30 minutes by default (`PI_SUBAGENT_TIMEOUT_MS`, up to 2 hours); `executionTimeoutMs` bounds one task within the same limit |
| One wait call | 5 minutes by default, at most 10 minutes, shared across selected ids; wakes on any completion and never sets or extends child deadlines |
| Task prompt | 100 KiB |
| Tool response and result details | 50 KiB each |
| Child stdout and stderr | 50 KiB each, keeping both ends; diagnostics cannot be interpreted as result frames |
| Background completion excerpt | At most 8 KiB per child within a 50 KiB aggregate message |

All children use one packaged SDK runner in a detached Node subprocess, with an in-memory Pi session. The task and configuration travel in a bounded JSON request on stdin, not in command arguments or a temporary file. Task text is submitted literally: a leading slash does not invoke a command or expand a prompt template. A private pipe carries versioned readiness, progress, partial output, cumulative usage, and compact result records. Thinking blocks, provider metadata, and diagnostic stdout cannot displace the final answer.

Normal completion and cancellation sweep the child's process group before releasing the concurrency slot. Cleanup is bounded: a descendant that escaped the group and keeps inherited stdio open cannot defer settlement past the deadline. An escaped descendant can still outlive the sweep; its effects are outside the managed boundary. Graceful cancellation runs child extension shutdown hooks on POSIX; Windows cancellation is force-only, so those hooks may not run. No profiles, workflow scheduler, recursive delegation, session persistence, or managed worktree creation is included.

A successful child must produce terminal assistant output. Failures, cancellation, timeouts, and token-limit termination (`incomplete`) remain distinguishable in retained status. Process cancellation and deadlines take precedence over earlier assistant errors. `run` and `wait` return native tool errors with retained details for failed or incomplete children; a mixed wait still includes its successful reports and running children. Failure causes precede partial output so report truncation cannot hide the reason. A child publishes its latest visible assistant text as it goes, so a deadline or cancellation retains findings produced before the final report. `status` remains available to inspect retained state, including a bounded failure cause and partial output for terminal failures. `stop` reports the resulting state without treating requested cancellation as a tool failure.

Reports remain bounded rather than spilling to disk. Batch budgets reserve every child's identity and status, then redistribute space that smaller reports do not need. Task labels and diagnostic excerpts get space before report output. `outputTruncation` records whether text was shortened and its original/retained UTF-8 byte counts; expansion also shows this in the TUI. A completion excerpt can point to a longer retained report, but text beyond the retention limit is not recoverable.

**Parent death.** Children run detached in their own process groups, so they do not die with the parent by default. Each child is watched by a detached supervisor that holds a pipe from the parent: when that pipe closes—graceful shutdown, crash, or `SIGKILL`—the watcher terminates the child's process group. On Windows there is no equivalent without a native job object, so only graceful shutdown, the leader process, and a best-effort `taskkill /T` sweep are guaranteed there.

Tool allowlists and subprocesses are **not sandboxes**. A child with shell access can produce effects outside the managed process group. Parent permission state is not an inherited security boundary.

Environment variables are allowlisted, with standard model credentials, `$VAR` references from Pi's `models.json`, and `*_API_KEY`/`*_TOKEN` variables forwarded. Other variables require `PI_SUBAGENT_PASSTHROUGH_ENV` (comma-separated exact names or globs). `*` explicitly forwards all environment variables. Credentials saved through `pi /login` remain available through the child's Pi configuration.

## Release notes

`0.0.x` is pre-release: the tool schema, behavior, and exported `ChildResult` shape are not promised across patch releases. Read this file, not the version number, for what changed.

- **0.0.11**: keep structured `timeoutPhase` through bounded result envelopes; measure execution-timeout elapsed from the ready frame instead of process spawn; render a running child’s phase once. Found in live 0.0.10 testing.
- **0.0.10**: redesign the parent-facing lifecycle. Inbox completion delivery is the default; `notify: "turn"` preserves pushed notices. Children get short `sa-<n>` handles from a fresh session range. Startup and execution deadlines are separate, `executionTimeoutMs` starts at the ready frame, and `run` accepts `joinTimeoutMs`. Default tools are read/search/web; mutation tools must be requested. Results gain `phase` and structured `errorKind`, and `/subagents` lists retained children. See the 0.0.10 migration notes below.
- **0.0.9**: settle timed-out and cancelled runs even when an escaped descendant keeps stdio open; stop the execution deadline at leader exit so cleanup cannot fabricate a timeout; report terminating signals, credential hints, and terminal failure causes in `status`; retain partial output from interrupted real children; do not evict a child referenced by the response's own tool calls.
- **0.0.8**: add per-task `executionTimeoutMs` for `run`/`spawn`, separate from wait budgets. Timeout reports retain partial output and name elapsed runtime and the applied deadline. Validate SDK children and packed artifacts against Pi 1.2.0.
- **0.0.7**: preserve unread reports when parent cancellation prevents completion delivery. Committed notices suppress duplicates without making unseen reports evictable; a subsequent successful assistant response or explicit join acknowledges them. Resume without duplicate notices, and reclaim acknowledged handles before tools need admission.
- **0.0.6**: count completed compaction usage; preserve UTF-8 diagnostics and failure causes under batch budgets; identify omitted launch context with `omittedFields`. Isolate execution snapshots from session state and tighten foreground progress and watchdog cleanup. Pi 1.0.4 remains supported.
- **0.0.5**: require Pi 1.0.4; return structured codemode results, including failed child reports; allow explicit selection of parent-callable tools; preserve reasoning-token usage. Children load Pi's canonical CLI built-ins with exact nested tool allowlists. POSIX children wait for a ready parent-death watchdog before starting tasks. See the Pi 1.0.4 migration section below.
- **0.0.4**: wait for several children at once and set per-child thinking effort. Children now use Pi's SDK and project-trust policy instead of the CLI runner; completion notices arrive only at active parent-turn boundaries, and child usage is added to parent totals on the next tool result. See the migration sections below for changed arguments and runtime requirements.
- **0.0.2**: `run` joins within a foreground budget and then continues as background work; `ChildResult` carries `state` instead of `exitCode`/`termination`; prompts travel on stdin instead of a temporary file; a blocking join claims the result it delivers; a crashed or killed parent now stops its children; stderr keeps both ends.
- **0.0.1**: task-first child lifecycle.

## Migration to 0.0.10

- **Default tool set is read-only**: `read`, `grep`, `find`, `ls`, and the research tools. Pass `tools` explicitly with `bash`, `edit`, or `write` for mutating work.
- **Completion defaults to the inbox**: background results no longer force a parent turn. The next top-level non-subagent tool result advertises unread handles, `/subagents` lists them, and `wait` reads them. Pass `notify: "turn"` to keep the old pushed-notice behavior.
- **Handles are short and reusable in calls**: `wait`, `status`, and `stop` accept `sa-<n>` as well as the full UUID. The UUID remains in details; the numeric range is fresh per session.
- **`executionTimeoutMs` starts at ready**, not at spawn. Add `startupTimeoutMs` for readiness; the default is 30 seconds. `run` also accepts `joinTimeoutMs`, and `PI_SUBAGENT_FOREGROUND_MS` remains the default join budget.
- **Results add `handle`, `phase`, `errorKind`, `timeoutPhase`, and `notify`**. `phase` is present only while running; `timeoutPhase` names the expired deadline; `errorKind` distinguishes startup, provider, protocol, deadline, cancelled, and unknown failures.
- **`/subagents`** reports retained children and unread results. It is human-facing; it does not consume reports.
- `spawn` rejects `joinTimeoutMs`. `run`/`spawn` reject `timeoutMs`; that field belongs to `wait`.

## Migration to Pi 1.0.4

- Pi 1.0.4 is now the minimum supported host. Earlier SDK versions are no longer supported.
- Children load the selected installation's CLI built-ins, respecting disabled or replacement extensions. You no longer need a separate extension to supply codemode or MCP to SDK children.
- `tools` remains an exact list, not Pi CLI wildcard patterns. Include every tool the child may call, including through codemode; omitted MCP tools are no longer implicitly callable. Explicit selections may now name parent-callable tools that are not active; defaults use active read/search/web tools only.
- Codemode callers now receive the structured `{ command, results, waitExpired? }` envelope instead of text. Inspect child states and output fields directly; do not parse the prose summary. Native `isError` results retain this data, so a failed child does not reject the script call.
- Direct callers of the extension's `execute()` receive `{ isError: true, content, details }` for failed child reports rather than a rejected promise. Invalid requests and cancelled waits still throw. Pi presents both as native tool errors.

## Migration from single-child waits

- `{"command":"wait","id":"…"}` → `{"command":"wait","ids":["…"]}`. `id` remains the argument for `status` and `stop`; `wait` requires `ids` even for one child.
- A wait returns when any selected child finishes and includes all currently ready reports. Do not pass completed ids again unless you need to reread their retained reports.
- Wait budgets now default to five minutes, at most ten. Expiry or cancellation still leaves children running.
- `thinking` is an optional launch parameter. Changing `model` without setting `thinking` now uses that model's Pi defaults, not the parent's effort. Set both explicitly when you need a particular combination.
- `ChildResult.thinking` records the effective startup effort; wait details add `waitExpired`. Custom developer runners must speak private protocol version 2 and report effective thinking in their readiness frame.

## Migration from CLI-backed children

- Children now require Node and an installed Pi SDK; launching another Pi CLI through `PI_SUBAGENT_BIN` or `PI_BIN` is no longer supported. Unset these overrides. `PI_SUBAGENT_RUNNER` is a developer-only override for a compatible protocol runner, not a CLI path.
- Use exact `provider/model-id` values. Missing child tools/models fail before the task rather than falling back or silently disappearing.
- `ChildResult` adds optional `stdout` and `outputTruncation` fields. Handle the new terminal outcome `incomplete` for model output limits; its partial report remains available.
- Completion delivery in `notify: "turn"` mode is batched, read-aware, and limited to active-turn boundaries; inbox delivery advertises unread results on the next top-level non-subagent tool result. Idle parents are never woken automatically. Use `wait` when a child blocks finishing your task. There is no redundant follow-up for a result already returned by `run`, `wait`, or `stop`.

## Migration from the profile/workflow API

This package replaces the profile/workflow API rather than maintaining a second interface:

- `{agent, task}` → `{command: "run", prompt: task, tools?: [...]}`. Include useful profile instructions in the task prompt.
- `background.action: "start"` → `command: "spawn"`; `runId` → `id`; `result` → `wait`.
- Parallel batches → separate `spawn` calls. Chains and workflows → parent-issued calls after inspecting prior results; no `{previous}` substitution.
- Agent discovery, `agentScope`, role Markdown files, profile schemas, and recursive policies are no longer consumed. Existing user files are left untouched. Validate structured results in the parent when required.

Restart or reload after updating. Old handles do not migrate. Update any personal instructions that still describe named agents or workflow modes; this package does not edit your settings or profiles.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

Pi loads the TypeScript extension directly; there is no build step. The child bootstrap uses the same installation's SDK and TypeScript loader. Checks use pinned Pi 1.3.0 packages; CI also runs the full check against Pi 1.0.4. They exercise real CLI/RPC parents, SDK children, packed artifacts, project trust, compaction usage, cancellation, and abrupt parent death with local mock providers. No live model calls are needed. The process-tree and death-watchdog tests are POSIX-only and skip on Windows.

Pi 1.2.0 does not publicly export its project-trust resolver or CLI built-in extension registry. The bootstrap reuses the selected installation's internal implementations rather than duplicating discovery or trust policy. The pinned version and packed-artifact tests gate both dependencies.

The subprocess boundary is kept separate from session ownership so a future native Pi child API can replace it. Upstream's experimental Pico3/micro runtime is not a supported backend; this extension targets the normal coding-agent CLI.

MIT licensed.
