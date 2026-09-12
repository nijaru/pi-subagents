# pi-subagents

Delegate a self-contained task to a fresh [Pi](https://github.com/earendil-works/pi) child, either foreground or background. The parent supplies the task—not a named role or workflow.

## Install

```bash
pi install git:github.com/nijaru/pi-subagents
```

Restart Pi or use `/reload`. The package registers one tool, `subagent`.

## Usage

Ask Pi to delegate a specific task, or use these tool-call shapes:

```json
{"command":"run","prompt":"Review the parser changes. Report concrete regressions with file/line and evidence. Do not edit files.","tools":["read"]}
```

`run` waits for the final result. For independent work while the parent continues:

```json
{"command":"spawn","prompt":"Implement the parser regression test in tests/parser.test.ts. Own only that file, run its tests, and report changes and results.","cwd":"../parser-worktree"}
{"command":"status"}
{"command":"wait","id":"<child-id>","timeoutMs":30000}
{"command":"stop","id":"<child-id>"}
```

Background children send a completion notice and request a follow-up parent turn. `wait` returns the retained final result, or reports that the child is still running when its wait budget expires. Cancelling a wait does **not** cancel the child; `stop` cancels it and waits for cleanup. Cancelling `run` cancels its child.

Handles belong to the current parent session. All children stop on quit, reload, or session replacement. Background work requires a live parent process; a one-shot print invocation is not a persistent worker host.

The TUI shows each prompt once, short IDs, and up to five visible output lines. Expand tool output for full IDs, working directory, tools, and usage. Short IDs are display-only; tool calls still require the full ID. Completion notices occupy one line, with results available on expansion. A notice already queued while Pi is busy can still arrive after `wait` returns.

### Tools and context

- Defaults are the parent's active tools among `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, and `query-docs`. Research tools require their extensions; they are not supplied by this package.
- `tools` selects an explicit allowlist, restricted to tools active in the parent. `tools: []` is reasoning-only. An empty default selection is rejected rather than silently launching an unusable coding child.
- Children are leaves. The `subagent` tool cannot be passed to them, and nested calls are rejected.
- `model` optionally selects `provider/model-id`; otherwise the parent's model is inherited. Thinking effort inherits the parent's session level.
- `cwd` defaults to the parent cwd; relative paths resolve against it.
- Every child starts a new conversation. The prompt should include scope, relevant evidence, constraints, expected output, and verification. Parent conversation history is not copied.

The subprocess loads its own Pi configuration, extensions, skills, and applicable `AGENTS.md` files. **Fresh context does not mean an empty system prompt.** Runtime-only tools, providers, credentials, and permission-hook state are not cloned from the parent; required integrations must also be configured in child Pi. A tool active only in the parent may therefore be unavailable in the child.

### When to delegate

Use `spawn` for independent work alongside useful, non-overlapping parent work. Use `run` when a fresh perspective or context-heavy investigation is worth waiting for. Keep routine lookups and tightly coupled edits local. The parent owns integration and verification; do not repeat the child's assignment while it runs.

Children are separate processes that share your working tree. The extension counts concurrency slots; it does not arbitrate write ownership, and it cannot guard the parent's own edits. Give concurrent writers distinct worktrees rather than relying on children to stay out of each other's way. Read-only children may overlap, but reading files while another process changes them does not provide a consistent snapshot.

## Limits and safety

| Resource | Limit |
|---|---|
| Active children | 4 per parent session; excess starts are rejected |
| Retained handles | 32; oldest completed handles are evicted first |
| Child execution | 30 minutes by default; `PI_SUBAGENT_TIMEOUT_MS` may set up to 2 hours |
| One wait call | 30 seconds by default, at most 120 seconds; never extends the child deadline |
| Task prompt | 100 KiB |
| Tool response and result details | 50 KiB each |
| Background completion excerpt | 8 KiB |

All children use the same subprocess runner: `pi --mode json -p --no-session`. Prompts travel through temporary mode-0600 files, not command arguments. Normal completion and cancellation sweep the child's process group before releasing the concurrency slot. No profiles, workflow scheduler, recursive delegation, session persistence, or managed worktree creation is included.

A successful child must produce terminal assistant output. Failures, cancellation, and timeouts remain distinguishable in retained status. `run` and completed `wait` throw tool errors for failed children; `status` remains available to inspect them. `stop` reports the resulting state without treating requested cancellation as a tool failure.

Tool allowlists and subprocesses are **not sandboxes**. A child with shell access can produce effects outside the managed process group. Parent permission state is not an inherited security boundary.

Environment variables are allowlisted, with standard model credentials, `$VAR` references from Pi's `models.json`, and `*_API_KEY`/`*_TOKEN` variables forwarded. Other variables require `PI_SUBAGENT_PASSTHROUGH_ENV` (comma-separated exact names or globs). `*` explicitly forwards all environment variables. Credentials saved through `pi /login` remain available through the child's Pi configuration.

## Migration from 0.0.1

Version 0.1 replaces the profile/workflow API rather than maintaining a second interface:

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

Pi loads the TypeScript extension directly; there is no build step. Node 22.19+ is required. Checks use the pinned Pi 0.85.1 packages, including real CLI foreground delegation and background RPC notification tests against a local fake model endpoint. No live model calls are needed.

The subprocess boundary is kept separate from session ownership so a future native Pi child API can replace it; unreleased pico designs are not a supported backend.

MIT licensed.
