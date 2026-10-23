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
- **`turn`**: additionally request a readiness announcement and continuation at an active boundary. It never wakes an idle parent. Each child gets at most one announcement attempt per parent run; a later extension may discard the draft.

Notices contain handles, not reports, and never mark results read. Use `wait` to retrieve and acknowledge reports after either kind of notice. A completed `run` or `stop` also reads its result; `status` does not. Unread results remain discoverable in the inbox even if a continuation was aborted or its notice was dropped.

`/subagents` lists retained children and unread results. `/subagents clear` drops completed, read handles.

## Time budgets

| Budget | Default | Scope |
| --- | --- | --- |
| `startupTimeoutMs` | 30s (`PI_SUBAGENT_STARTUP_TIMEOUT_MS`) | RPC process, model selection, tool probe, and readiness |
| `executionTimeoutMs` | 30m (`PI_SUBAGENT_TIMEOUT_MS`) | Model/tool work, starting when the task is submitted |
| `joinTimeoutMs` | 60s (`PI_SUBAGENT_FOREGROUND_MS`) | How long one `run` blocks |
| `timeoutMs` | 5m | How long one `wait` joins; never changes a child deadline |

`status` exposes `lastActivityAt` (parent-observed Unix milliseconds) and, while work is active, `activity` (`model`, `thinking`, `text`, or `tool`) and `currentTool` (an executing tool name; calls can overlap). Model/token and tool lifecycle events refresh the timestamp, including thinking before visible text. Metadata contains no reasoning text, tool arguments, or tool results. Current activity clears when execution stops; the last timestamp survives failure and cleanup. These are observations, not stall detection: a quiet tool or provider can still be working.

At startup/execution expiry the child is stopped and its result retains partial assistant output. Join/wait expiry leaves the child running. `errorKind` distinguishes `startup`, `provider`, `protocol`, `deadline`, `cancelled`, and `cleanup`; `timeoutPhase` names the expired deadline. Reported runtime excludes process-tree cleanup; `cleanupMs` records the excluded portion.

## Child execution

- **Public RPC boundary.** The child is spawned as `pi --mode rpc`; the parent speaks only the documented JSONL protocol. No `jiti`, no SDK bootstrap, and no private Pi module imports.
- **Exact startup checks.** The parent verifies the child's effective model and thinking level with `get_state`, then uses a private readiness command and a typed custom session entry to verify the active tool set before the prompt is submitted. The child probe also blocks calls outside the allowlist. Tool registration shares the caller's startup deadline, with no separate ten-second cap. Missing tools exhaust startup without submitting the task.
- **Full Pi configuration.** The child loads its own settings, extensions, skills, MCP servers, and project instructions. A fresh conversation does not mean an empty system prompt.
- **Isolation.** Each child runs in its own detached process group. A detached watchdog terminates the group if the parent dies without running shutdown hooks. Normal completion closes child stdin and waits for orderly Pi shutdown before ending the watchdog and sweeping descendants; cancellation and timeouts stop the tree promptly. The concurrency slot is held until cleanup finishes.
- **Steering.** Steering messages use the RPC `steer` command and are delivered after the current assistant turn's tool calls. A call made during startup joins the same readiness outcome; it does not introduce another timeout. Cancelling the call stops waiting, not the child. Once sent, a queued instruction cannot be recalled.
- **Persistence.** `persist: true` stores the child session under the agent directory (`~/.pi/agent/subagents/sessions/<id>.jsonl` by default) and returns `sessionFile`. `resume: "<path>"` continues an existing child session instead of starting fresh. Resume in the session's original `cwd`; a mismatched workspace or the active parent session is rejected before launch. Relative resume paths resolve against the parent cwd. The path appears in the model-facing `run`/`spawn`/`wait`/`status` text as well as details, including on failure. Opt into persistence before starting a long task that needs recovery; it is off by default. After the child stops, continue with `resume: "<sessionFile>"` in the same workspace and a focused prompt. Saved Pi conversations may contain sensitive content and are not full token traces; failed startup can return a path before any session file exists.
- **Trust.** RPC mode cannot show Pi's project-trust prompt. Project-local resources are skipped unless a saved decision applies or the call sets `trustProject: true`, which passes `--approve` to the child. Parent permission state is not inherited.

Children inherit the parent process environment, including credentials and tool configuration. Parent session-identity variables are removed and child identity is set explicitly. This is ordinary subprocess inheritance, not credential filtering.

The child is a full Pi process, so extensions and a child with shell access can produce effects outside the managed process group. Tool allowlists and subprocesses are **not sandboxes**.

### Session ownership

Persisted and resumed sessions have an exclusive, cooperative `<sessionFile>.subagent-lock` held from before launch through cleanup. Competing subagent parents reject contention rather than queueing. These locks do not protect against an ordinary Pi process opening the same file; do not open a session elsewhere while a child owns it.

Normal completion, cancellation, and failed startup release ownership after the child exits. A hard parent crash or unconfirmed cleanup leaves the lock in place. Locks never expire automatically: verify that the old child has stopped before manually removing an orphaned lock. The lock records the parent PID and child run ID. This conservative recovery avoids allowing two writers while an old child is still alive.

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

Child reports remain bounded in memory; they are not spilled to disk. `outputTruncation` records shortened UTF-8 output. A persisted session is separate from that report.

## Usage

Child usage includes assistant calls, completed compaction summaries, and usage reported by child tools. Interrupted calls retain the latest reported cumulative usage; updates are not added repeatedly. Providers that report usage only at finalization can leave interrupted usage unknown.

After cleanup, each child's usage is added once to the next parent tool result, including failed results. Repeated `status`, `wait`, or `stop` calls do not charge it again.

Pi cannot attach usage to a custom completion message. Background costs enter native totals on the next parent tool result; until then they remain visible in child details. Quit, reload, or session replacement discards unreported usage.

## Parent shutdown

All children stop on quit, reload, or session replacement. Background work requires a live parent process. On POSIX, the parent-death watchdog enforces cleanup even after `SIGKILL`; Windows cancellation is force-only and has no equivalent job-object guarantee.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

Pi loads the TypeScript extension directly; there is no build step. Checks use a fake RPC child for deterministic lifecycle tests and a real Pi CLI with a local mock provider for the public-protocol integration test. No live model calls are needed.

RPC preserves the normal Pi CLI runtime while supporting steering and session continuation. Print/JSON mode is simpler for one-shot jobs but cannot steer a running task; an SDK worker would require a separate bootstrap, and an in-process session would share the parent's failure domain. Terminal attachment and independent background survival are outside this tool's scope.

## Release notes

`0.0.x` is pre-release: tool schema and result shape are not promised across patch releases.

- **0.0.13**: replace the custom SDK child bootstrap with Pi's public RPC protocol. Add `steer`, persisted/resumable child sessions (`persist`, `resume`), and opt-in `trustProject`. Remove `jiti`, private Pi imports, and the custom fd-3 child protocol. Add an active-tool probe so missing tools fail before prompting. Wrap prompts and steering to prevent RPC command expansion, exclude all unselected tools from nested calls, preserve orderly child shutdown hooks, ignore oversized `agent_end` history, retain the latest partial report, and expose persisted session paths in model-facing text. Notices announce handles without consuming reports. Persisted sessions have exclusive ownership, startup operations share one deadline, and children inherit the ordinary process environment.

## Migrating from the SDK child

- `PI_SUBAGENT_RUNNER`, `PI_SUBAGENT_BIN`, and `PI_BIN` are no longer used. The child requires the installed Pi CLI.
- Children now use a real Pi RPC process. Project trust follows RPC rules; pass `trustProject: true` for a one-shot `--approve` or save a trust decision.
- `persist: true` keeps a child session; `resume: "<sessionFile>"` continues one. Existing SDK child handles do not migrate.
- `steer` is available only while a child is running. After completion, resume its persisted session to continue the conversation.
- Tool availability is checked by a public extension probe before the prompt; a missing built-in or MCP tool exhausts startup without starting model work.
- Completion notices no longer embed reports or implicitly acknowledge them. Retrieve reports with `wait`; `status` remains observational.
- `PI_SUBAGENT_PASSTHROUGH_ENV` is retired. Child processes inherit ordinary environment configuration; session-identity variables are replaced, not copied.
