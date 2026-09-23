# pi-subagents

Delegate a self-contained task to a fresh [Pi](https://github.com/earendil-works/pi) child, either foreground or background. The parent supplies the task—not a named role or workflow.

## Install

```bash
pi install npm:@nijaru/pi-subagents
```

Requires a Node/npm installation of Pi 0.87.x with its SDK files, and Node 22.19+ available to launch children. Standalone Pi binaries are not supported. Restart Pi or use `/reload`. The package registers one tool, `subagent`.

## Usage

Ask Pi to delegate a specific task, or use these tool-call shapes:

```json
{"command":"run","prompt":"Review the parser changes. Report concrete regressions with file/line and evidence. Do not edit files.","tools":["read"]}
```

`run` joins the child within a foreground budget (60 seconds by default) and returns its final result. If the budget expires first, the child keeps working in the background and reports completion like `spawn`. For independent work while the parent continues:

```json
{"command":"spawn","prompt":"Implement the parser regression test in tests/parser.test.ts. Own only that file, run its tests, and report changes and results.","cwd":"../parser-worktree"}
{"command":"status"}
{"command":"wait","id":"<child-id>","timeoutMs":30000}
{"command":"stop","id":"<child-id>"}
```

Unread background results arrive at the next successful active-turn boundary. Results ready together share one completion message and continuation. **Completions never wake an idle parent.** Results finishing after the last boundary, or during parent errors or cancellation, remain unread until another natural turn or an explicit `wait`. The TUI status indicator shows the unread count. This avoids undoing a late abort that Pi 0.87 cannot expose to extensions.

Use `wait` before finishing a task that depends on a child's result. It returns the retained final result, or reports that the child is still running when its wait budget expires. Cancelling a wait does **not** cancel the child; `stop` cancels it and waits for cleanup. Cancelling `run` cancels its child.

`run`, `wait`, and `stop` mark the result they return as read, suppressing its pending automatic notice even if the child finished before the call. `status` only inspects state; it does not consume a report. Completion notices carry results inline and point at `wait` only when an excerpt was truncated. Once a report has entered the parent's transcript, explicitly reading it again still returns the retained copy but does not generate another notice.

Handles belong to the current parent session. All children stop on quit, reload, or session replacement. Background work requires a live parent process; a one-shot print invocation is not a persistent worker host.

The TUI hides agent-facing text — delegated prompts and child reports — behind expansion. Each child is one status line: live work and status listings carry a one-line task label, finished children show only outcome and duration, with the error message added for failures. Expand for the full prompt and report, full IDs, diagnostics, working directory, tools, and usage. Short IDs are display-only; tool calls still require the full ID. Completion notices occupy one line, with results available on expansion.

### Usage accounting

Child usage includes assistant calls and usage reported by child tools. After cleanup finishes, each child's usage is added once to the next parent tool result, including failed results. Repeated `status`, `wait`, or `stop` calls do not charge it again. Pi includes this usage in its footer, `/session`, and RPC totals.

Pi 0.87 cannot attach usage to a custom completion message. Background costs therefore enter native totals only when another parent tool finishes; until then, they remain visible in the child details. Quit, reload, or session replacement discards any unreported usage, including usage from children stopped during shutdown. No extra tool call or model turn is created just to report costs.

### Tools and context

- Defaults are the parent's active tools among `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, and `query-docs`. Research tools require their extensions; they are not supplied by this package.
- `tools` selects an explicit allowlist, restricted to tools active in the parent. `tools: []` is reasoning-only. An empty default selection is rejected rather than silently launching an unusable coding child.
- Children are leaves. The `subagent` tool cannot be passed to them, and nested calls are rejected.
- `model` optionally selects an exact `provider/model-id`; otherwise the parent's model is inherited. Fuzzy CLI model patterns are not accepted. Thinking effort inherits the parent's session level.
- `cwd` defaults to the parent cwd; relative paths resolve against it.
- Every child starts a new conversation. The prompt should include scope, relevant evidence, constraints, expected output, and verification. Parent conversation history is not copied.

The subprocess loads its own Pi configuration, extensions, skills, and applicable `AGENTS.md` files. **Fresh context does not mean an empty system prompt.** Runtime-only tools, providers, credentials, and permission-hook state are not cloned from the parent; required integrations must also be configured in child Pi. Before submitting the task, the child verifies the requested model and tools against its own loaded integrations. An unavailable tool or model fails startup instead of silently reducing the child's capabilities. Project resources follow Pi's noninteractive trust policy, including saved decisions and global `project_trust` hooks; parent-only trust decisions are not copied.

`tools` filters tool names, not extension code: child Pi still loads its configured extensions, so unrelated extension behavior (commands, hooks, providers) keeps running even when its tools are excluded. Use `tools: []` to give the model no tools; that is not a sandbox.

### When to delegate

Use `spawn` for independent work alongside useful, non-overlapping parent work. Use `run` when a fresh perspective or context-heavy investigation is worth waiting for. Keep routine lookups and tightly coupled edits local. The parent owns integration and verification; do not repeat the child's assignment while it runs.

Children are separate processes that share your working tree. The extension counts concurrency slots; it does not arbitrate write ownership, and it cannot guard the parent's own edits. Give concurrent writers distinct worktrees rather than relying on children to stay out of each other's way. Read-only children may overlap, but reading files while another process changes them does not provide a consistent snapshot.

## Limits and safety

| Resource | Limit |
|---|---|
| Active children | 4 per parent session; excess starts are rejected |
| Retained handles | 32; oldest completed, delivered handles are evicted first; unread results block admission rather than disappearing |
| Foreground `run` | 60 seconds by default; `PI_SUBAGENT_FOREGROUND_MS` changes it, and expiry hands the child to background work |
| Child execution | 30 minutes by default; `PI_SUBAGENT_TIMEOUT_MS` may set up to 2 hours |
| One wait call | 30 seconds by default, at most 120 seconds; never extends the child deadline |
| Task prompt | 100 KiB |
| Tool response and result details | 50 KiB each |
| Child stdout and stderr | 50 KiB each, keeping both ends; diagnostics cannot be interpreted as result frames |
| Background completion excerpt | At most 8 KiB per child within a 50 KiB aggregate message |

All children use one packaged SDK runner in a detached Node subprocess, with an in-memory Pi session. The task and configuration travel in a bounded JSON request on stdin, not in command arguments or a temporary file. Task text is submitted literally: a leading slash does not invoke a command or expand a prompt template. A private pipe carries versioned readiness, progress, cumulative usage, and compact result records. Thinking blocks, provider metadata, and diagnostic stdout cannot displace the final answer.

Normal completion and cancellation sweep the child's process group before releasing the concurrency slot. Graceful cancellation runs child extension shutdown hooks; hung cleanup is subject to the same forced process-tree termination. No profiles, workflow scheduler, recursive delegation, session persistence, or managed worktree creation is included.

A successful child must produce terminal assistant output. Failures, cancellation, timeouts, and token-limit termination (`incomplete`) remain distinguishable in retained status. Process cancellation and deadlines take precedence over earlier assistant errors. `run` and completed `wait` throw tool errors for failed or incomplete children; `status` remains available to inspect them. `stop` reports the resulting state without treating requested cancellation as a tool failure.

Reports remain bounded rather than spilling to disk. `outputTruncation` records whether text was shortened and its original/retained UTF-8 byte counts; expansion also shows this in the TUI. A completion excerpt can point to a longer retained report, but text beyond the retention limit is not recoverable.

**Parent death.** Children run detached in their own process groups, so they do not die with the parent by default. Each child is watched by a detached supervisor that holds a pipe from the parent: when that pipe closes—graceful shutdown, crash, or `SIGKILL`—the watcher terminates the child's process group. On Windows there is no equivalent without a native job object, so only graceful shutdown, the leader process, and a best-effort `taskkill /T` sweep are guaranteed there.

Tool allowlists and subprocesses are **not sandboxes**. A child with shell access can produce effects outside the managed process group. Parent permission state is not an inherited security boundary.

Environment variables are allowlisted, with standard model credentials, `$VAR` references from Pi's `models.json`, and `*_API_KEY`/`*_TOKEN` variables forwarded. Other variables require `PI_SUBAGENT_PASSTHROUGH_ENV` (comma-separated exact names or globs). `*` explicitly forwards all environment variables. Credentials saved through `pi /login` remain available through the child's Pi configuration.

## Release notes

`0.0.x` is pre-release: the tool schema is stable, but behavior and the exported `ChildResult` shape are not promised across patch releases. Read this file, not the version number, for what changed.

- **0.0.2**: `run` joins within a foreground budget and then continues as background work; `ChildResult` carries `state` instead of `exitCode`/`termination`; prompts travel on stdin instead of a temporary file; a blocking join claims the result it delivers; a crashed or killed parent now stops its children; stderr keeps both ends.
- **0.0.1**: task-first child lifecycle.

## Migration from CLI-backed children

- Children now require Node and an installed Pi SDK; launching another Pi CLI through `PI_SUBAGENT_BIN` or `PI_BIN` is no longer supported. Unset these overrides. `PI_SUBAGENT_RUNNER` is a developer-only override for a compatible protocol runner, not a CLI path.
- Use exact `provider/model-id` values. Missing child tools/models fail before the task rather than falling back or silently disappearing.
- `ChildResult` adds optional `stdout` and `outputTruncation` fields. Handle the new terminal outcome `incomplete` for model output limits; its partial report remains available.
- Completion delivery is batched, read-aware, and limited to active-turn boundaries. Idle parents are no longer woken automatically. Use `wait` when a child blocks finishing your task. There is no redundant follow-up for a result already returned by `run`, `wait`, or `stop`.

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

Pi loads the TypeScript extension directly; there is no build step. The child bootstrap uses the same installation's SDK and TypeScript loader. Checks use pinned Pi 0.87.1 packages and exercise real CLI/RPC parents, SDK children, packed artifacts, project trust, cancellation, and abrupt parent death with local mock providers. No live model calls are needed. The process-tree and death-watchdog tests are POSIX-only and skip on Windows.

Pi 0.87 does not publicly export its project-trust resolver. The bootstrap reuses that installation's internal resolver rather than duplicating policy or accepting the SDK's trusted-by-default setting. The pinned version and packed-artifact tests are the compatibility gate for this dependency.

The subprocess boundary is kept separate from session ownership so a future native Pi child API can replace it. Upstream's experimental Pico3/micro runtime is not a supported backend; this extension targets the normal coding-agent CLI.

MIT licensed.
