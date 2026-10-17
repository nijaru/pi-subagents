# pi-subagents

Task-first delegation for Pi. A parent session starts a fresh Pi child over the public RPC protocol, optionally joins it, and keeps working while it runs.

The child is a real `pi --mode rpc` process with its own session, tools, model, extensions, and working directory. The extension does not load Pi's SDK internals or ship a second runtime.

## Install

```bash
pi install npm:@nijaru/pi-subagents
```

Requires Pi 1.3.0+ from a Node/npm installation (with the `pi` CLI) and Node.js 22.19+. Standalone Pi binaries are not supported. Restart Pi or use `/reload`.

## Tool

One tool, `subagent`, with six commands:

| Command | Purpose |
| --- | --- |
| `run` | Start a child and join it for up to `joinTimeoutMs` (60 seconds by default). If the join expires, the child continues in the background. |
| `spawn` | Start a child and return its handle immediately. |
| `wait` | Join one or more children. Wakes when any selected child finishes. |
| `status` | Inspect one child or list retained children. Does not consume results. |
| `stop` | Cancel a child and join its cleanup. |
| `steer` | Queue a steering message into a running child. Delivered after its current assistant turn and tool calls. |

Every child gets a short session-scoped handle (`sa-<n>`). `wait`, `status`, `stop`, and `steer` accept the handle or the full UUID.

```json
{"command":"run","prompt":"Review the parser changes. Report concrete regressions with file/line and evidence. Do not edit files.","tools":["read"]}
```

```json
{"command":"spawn","prompt":"Implement the parser regression test. Own only tests/parser.test.ts and run it.","tools":["read","edit","bash"],"persist":true}
{"command":"steer","id":"sa-4821","message":"Also check the empty-input case."}
{"command":"wait","ids":["sa-4821"]}
```

`run` is the synchronous convenience: it starts and joins. `spawn` is the background form. A `run` whose join expires returns a running handle; it does not stop the child. Cancelling a `run` call cancels its child; cancelling a `wait` leaves children running.

Task prompts are wrapped in a `Task:` envelope and steering messages in a `Steering instruction:` envelope before they reach RPC. This prevents RPC from interpreting a leading `/command`, `/skill:...`, or `/template` as a child command. The task content itself is otherwise unchanged.

## Completion delivery

`notify` controls how a finished child reaches the parent:

- **`inbox`** (default): the next top-level non-subagent tool result advertises unread handles. An idle parent is never woken; `wait` retrieves the reports.
- **`turn`**: Pi offers one continuation turn at an active boundary when the child finishes. Aborts, provider errors, and dropped notices leave the report unread for `wait`.

`/subagents` lists retained children and unread results. `/subagents clear` drops completed, read handles.

## Time budgets

| Budget | Default | Scope |
| --- | --- | --- |
| `startupTimeoutMs` | 30s (`PI_SUBAGENT_STARTUP_TIMEOUT_MS`) | RPC process, model selection, tool probe, and readiness |
| `executionTimeoutMs` | 30m (`PI_SUBAGENT_TIMEOUT_MS`) | Model/tool work, starting when Pi accepts the prompt |
| `joinTimeoutMs` | 60s (`PI_SUBAGENT_FOREGROUND_MS`) | How long one `run` blocks |
| `timeoutMs` | 5m | How long one `wait` joins; never changes a child deadline |

At expiry the child is stopped and its result retains partial assistant output. `errorKind` distinguishes `startup`, `provider`, `protocol`, `deadline`, and `cancelled`; `timeoutPhase` names the expired deadline. Reported runtime excludes process-tree cleanup; `cleanupMs` records the excluded portion.

## Child execution

- **Public RPC boundary.** The child is spawned as `pi --mode rpc`; the parent speaks only the documented JSONL protocol. No `jiti`, no SDK bootstrap, and no private Pi module imports.
- **Exact startup checks.** The parent verifies the child's effective model and thinking level with `get_state`, and a packaged probe extension reports the active tool set before the prompt is submitted and blocks calls outside the allowlist. A missing requested tool fails startup instead of silently running with fewer capabilities.
- **Full Pi configuration.** The child loads its own settings, extensions, skills, MCP servers, and project instructions. A fresh conversation does not mean an empty system prompt.
- **Isolation.** Each child runs in its own detached process group. A detached watchdog terminates the group if the parent dies without running shutdown hooks. Normal completion closes child stdin and waits for orderly Pi shutdown before ending the watchdog and sweeping descendants; cancellation and timeouts stop the tree promptly. The concurrency slot is held until cleanup finishes.
- **Steering.** Steering messages use the RPC `steer` command and are delivered after the current assistant turn's tool calls. Steering is only available while the child is running.
- **Persistence.** `persist: true` stores the child session under the agent directory (`~/.pi/agent/subagents/sessions/<id>.jsonl` by default) and returns `sessionFile`. `resume: "<path>"` continues an existing child session instead of starting fresh. The path appears in the model-facing `run`/`spawn`/`wait`/`status` text as well as details, so the parent can resume it later with `run` or `spawn`; do not resume a session while another child is still using it.
- **Trust.** RPC mode cannot show Pi's project-trust prompt. Project-local resources are skipped unless a saved decision applies or the call sets `trustProject: true`, which passes `--approve` to the child. Parent permission state is not inherited.

The child is a full Pi process, so a child with shell access can produce effects outside the managed process group. Tool allowlists and subprocesses are **not sandboxes**.

## Tools and context

Defaults are the parent's active tools among `read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, and `query-docs`. Mutation tools (`bash`, `edit`, `write`) must be requested explicitly. `tools: []` is reasoning-only.

Explicit tools must be active or callable in the parent and are passed to the child as an exact allowlist. All unselected tools are also passed through `--exclude-tools`, so nested/codemode calls cannot reach them. The child probe must report the same active set before the task starts and blocks tool calls outside the allowlist, including nested `executeTool()` calls. Children are leaves: the `subagent` tool cannot be passed to a child, and nested calls are rejected.

`model` is an exact `provider/model-id`; otherwise the parent's model is inherited. `thinking` selects a reasoning effort supported by that model. An explicit unsupported level fails before prompting. A different model uses its own Pi defaults when `thinking` is omitted.

`cwd` defaults to the parent cwd. Every child starts a new conversation; the prompt must carry scope, evidence, constraints, expected output, and checks. Parent history, runtime-only tools, and permission-hook state are not copied.

## Limits

| Resource | Limit |
| --- | --- |
| Active children | 4 per parent session; excess starts are rejected |
| Retained handles | 32; oldest completed, read handles are evicted first; unread results are never evicted |
| Startup | 30 seconds by default, up to 5 minutes |
| Execution | 30 minutes by default, up to 2 hours |
| One wait | 5 minutes by default, at most 10 |
| Task prompt | 100 KiB |
| Tool response and details | 50 KiB each |
| Child stderr | 50 KiB, keeping both ends |
| Background completion excerpt | 8 KiB per child |

Child reports remain bounded in memory; they are not spilled to disk. `outputTruncation` records shortened UTF-8 output. A persisted session is separate from that report.

## Usage

Child usage includes assistant calls, completed compaction summaries, and usage reported by child tools. After cleanup, each child's usage is added once to the next parent tool result, including failed results. Repeated `status`, `wait`, or `stop` calls do not charge it again.

Pi cannot attach usage to a custom completion message. Background costs enter native totals on the next parent tool result; until then they remain visible in child details. Quit, reload, or session replacement discards unreported usage.

## Parent shutdown

All children stop on quit, reload, or session replacement. Background work requires a live parent process. On POSIX, the parent-death watchdog enforces cleanup even after `SIGKILL`; Windows cancellation is force-only and has no equivalent job-object guarantee.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

Pi loads the TypeScript extension directly; there is no build step. Checks use a fake RPC child for deterministic lifecycle tests and a real Pi CLI with a local mock provider for the public-protocol integration test. No live model calls are needed.

## Release notes

`0.0.x` is pre-release: tool schema and result shape are not promised across patch releases.

- **0.0.13**: replace the custom SDK child bootstrap with Pi's public RPC protocol. Add `steer`, persisted/resumable child sessions (`persist`, `resume`), and opt-in `trustProject`. Remove `jiti`, private Pi imports, and the custom fd-3 child protocol. Add an active-tool probe so missing tools fail before prompting. Wrap prompts and steering to prevent RPC command expansion, exclude all unselected tools from nested calls, preserve orderly child shutdown hooks, ignore oversized `agent_end` history, retain the latest partial report, and expose persisted session paths in model-facing text.

## Migrating from the SDK child

- `PI_SUBAGENT_RUNNER`, `PI_SUBAGENT_BIN`, and `PI_BIN` are no longer used. The child requires the installed Pi CLI.
- Children now use a real Pi RPC process. Project trust follows RPC rules; pass `trustProject: true` for a one-shot `--approve` or save a trust decision.
- `persist: true` keeps a child session; `resume: "<sessionFile>"` continues one. Existing SDK child handles do not migrate.
- `steer` is available only while a child is running. After completion, resume its persisted session to continue the conversation.
- Tool availability is checked by a public extension probe before the prompt; a missing built-in or MCP tool fails startup.
