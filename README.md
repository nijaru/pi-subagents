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

`run` is the synchronous convenience: it starts and joins. `spawn` is the background form. A `run` whose join expires returns a running handle; it does not stop the child. Cancelling a `run` call cancels its child and joins cleanup, even beyond the join budget; cancelling a `wait` leaves children running.

Task prompts are wrapped in a `Task:` envelope and steering messages in a `Steering instruction:` envelope before they reach RPC. This prevents RPC from interpreting a leading `/command`, `/skill:...`, or `/template` as a child command. The task content itself is otherwise unchanged.

## Completion delivery

Unread completions request a handle announcement and continuation at the next successful active boundary. The next top-level non-subagent tool result also advertises unread handles. Each child gets at most one boundary announcement attempt per parent run; a later extension may discard the draft. An idle parent is never woken.

Notices contain handles, not reports, and never consume them. Use `wait` to retrieve reports after a notice. A completed `run`, `wait`, or `stop` marks its returned terminal reports collected locally; `status` does not. Collected reports become eligible for clearing or eviction. Collection does not confirm that a later tool-result transformation preserved the report, that it reached model context, or that the model read it. Unread results remain discoverable in the inbox even if a continuation was aborted or its notice was dropped.

An assistant error, an unsuccessful boundary, or an observed abort suppresses boundary announcements for the rest of that parent run, even if an automatic retry later succeeds. Explicit retrieval and inbox advertisements remain available. A new parent run rearms announcement attempts. The no-idle-wake policy is deliberate: Pi can trigger an idle turn, but does not expose a reliable late idle-abort signal to revoke that work safely.

`/subagents` lists retained children and unread results. `/subagents clear` drops completed, read handles.

## Time budgets

| Budget | Default | Scope |
| --- | --- | --- |
| `startupTimeoutMs` | 30s (`PI_SUBAGENT_STARTUP_TIMEOUT_MS`) | RPC process, model selection, tool probe, and readiness |
| `executionTimeoutMs` | Off; `PI_SUBAGENT_TIMEOUT_MS` opts in | Task preflight and model/tool work, starting when the task is submitted |
| `joinTimeoutMs` | 60s (`PI_SUBAGENT_FOREGROUND_MS`) | How long one `run` blocks; at most 10m |
| `timeoutMs` | 5m | How long one `wait` joins; never changes a child deadline |

Execution deadlines are off by default. Set `executionTimeoutMs` for a task-specific cutoff, or `PI_SUBAGENT_TIMEOUT_MS` for an opt-in global default; explicit arguments take precedence. Configured limits must be positive integer milliseconds, at most two hours. Invalid execution-limit environment values fail before task submission; unset the variable to disable that default. Without a limit, a child can keep running, spending, and occupying its admission slot until it finishes, is stopped, or its parent shuts down. Pi/provider request, connection, idle, and retry limits still apply.

`joinTimeoutMs` is a foreground join budget, not an execution deadline. It is capped at 10 minutes; an out-of-range `PI_SUBAGENT_FOREGROUND_MS` value falls back to the 60-second default.

`status` exposes `lastActivityAt` (parent-observed Unix milliseconds) and, while work is active, `activity` (`model`, `thinking`, `text`, `tool`, `retry`, or `compaction`) and `currentTool` (one observed tool-call name; calls can overlap). Model/token, tool, retry, and compaction lifecycle events refresh the timestamp, including thinking before visible text. `retry` means observed Pi retry backoff, not hidden provider-internal retries; `compaction` means observed summarization work. Metadata contains no reasoning text, tool arguments, or tool results. Current activity clears when execution stops; the last timestamp survives failure and cleanup. Successful reports omit activity timestamps; running and failed reports retain them. These are observations, not stall detection: a quiet tool or provider can still be working.

Interrupted execution also retains `interruption`: the observed `activity`, an `activeToolCount` of calls with a start but no observed end, and one `currentTool` name when available. This snapshot is frozen before cleanup; it contains no arguments or results. A start event does not prove a tool executed, and a missing end does not prove its effects failed. Reports warn to reconcile workspace/external state before retrying when this count is nonzero. The count and sampled name are not a complete side-effect ledger. Batch metadata is bounded too: details may omit a session path with `omittedFields: ["sessionFile"]`, never return a truncated resume target. Inspect that child alone with `status` to retrieve it.

Every armed phase exposes its effective `deadline`: `{ phase, startedAt, expiresAt }`, with Unix millisecond timestamps after defaults and environment settings are resolved. Startup protection and its metadata clear when a task is submitted without an execution limit. An explicitly configured execution deadline—or a failed-startup deadline—remains in terminal details; running and failed text reports show it too. Activity never extends the cutoff. The library does not automatically retry, extend the budget, or send a wrap-up prompt: queued steering cannot interrupt a long model request or tool call.

At startup/execution expiry the child is stopped and its result retains bounded visible assistant text across messages, including unfinished text. Completed text blocks replace their interim deltas even if the whole assistant message never finishes. Successful results retain completed assistant reports from that execution, including answers before and after steering or follow-ups; tool-use narration is excluded. The combined report is byte-bounded, with a retained prefix and explicit truncation metadata. Join/wait expiry leaves the child running. `errorKind` distinguishes `startup`, `provider`, `protocol`, `deadline`, `cancelled`, and `cleanup`; `timeoutPhase` names the expired deadline. Reported runtime excludes process-tree cleanup; `cleanupMs` records the excluded portion.

## Child execution

- **Public RPC boundary.** The child is spawned as `pi --mode rpc`; the parent speaks only the documented JSONL protocol. No `jiti`, no SDK bootstrap, and no private Pi module imports.
- **Exact startup checks.** After session restoration and extension startup, the parent explicitly sets the requested model, then effort, through RPC. Unsupported explicit effort fails before model work. A private readiness command and typed custom session entry verify the active tool set; a final `get_state` verifies the effective model and explicit effort before the task is submitted. The child probe also blocks calls outside the allowlist. Tool registration shares the caller's startup deadline, with no separate ten-second cap. Missing tools exhaust startup without submitting the task.
- **Task preflight.** Pi can compact saved history and run extension hooks before acknowledging a task prompt. This work uses the optional execution deadline, not a separate 30-second control-acknowledgment cutoff.
- **Full Pi configuration.** The child loads its own settings, extensions, skills, MCP servers, and project instructions. A fresh conversation does not mean an empty system prompt.
- **Isolation.** Each child runs in its own detached process group. A detached watchdog terminates the group if the parent dies without running shutdown hooks. Normal completion closes child stdin and waits for orderly Pi shutdown before ending the watchdog and sweeping descendants; cancellation and timeouts stop the tree promptly. The concurrency slot is held through confirmed cleanup; an unconfirmed cleanup keeps it reserved.
- **Steering.** Steering messages use the RPC `steer` command and are delivered after the current assistant turn's tool calls. A call made during startup joins the same readiness outcome; it does not introduce another timeout. Cancelling the call stops waiting, not the child. Once sent, an instruction cannot be recalled through this tool. A cancelled or lost acknowledgment has unknown acceptance: the instruction may already have taken effect, so do not resend automatically. Queue acceptance does not mean delivery: a deadline can stop the child first, and undelivered steering is not restored by resuming a saved conversation.
- **Persistence.** New children save their session by default; `persist: false` disables retention. The session is stored under the agent directory (`~/.pi/agent/subagents/sessions/<id>.jsonl` by default) and returns `sessionFile`. `resume: "sa-4821"` continues a stopped child's saved conversation with a new handle and defaults to its original `cwd`. `resume: "<path>"` supports recovery after handles are cleared or the parent restarts. Explicit paths require the session's original `cwd`; a mismatched workspace or the active parent session is rejected before launch. Relative resume paths resolve against the parent cwd. The path appears in the model-facing `run`/`spawn`/`wait`/`status` text as well as details, including on failure. After the child stops, continue with a focused prompt. Resume follows normal launch rules for tools, model, effort, and trust; it does not inherit those options from the old handle. `persist` and `resume` cannot be supplied together. Inspect saved history and any external tool effects before resuming failed mutating work; a saved conversation does not roll those effects back. A tool can apply a mutation and be interrupted before its result is saved. Pi may supply a synthetic missing-result error on resume to satisfy provider message ordering; this does not establish whether the operation happened. Saved Pi conversations may contain sensitive prompts and tool results and are not full token traces; failed startup can return a path before any session file exists.
- **Trust.** RPC mode cannot show Pi's project-trust prompt. Project-local resources are skipped unless a saved decision applies or the call sets `trustProject: true`, which passes `--approve` to the child. Parent permission state is not inherited.

Children inherit the parent process environment, including credentials and tool configuration. Parent session-identity variables are removed and child identity is set explicitly. This is ordinary subprocess inheritance, not credential filtering.

The child is a full Pi process, so extensions and a child with shell access can produce effects outside the managed process group. Tool allowlists and subprocesses are **not sandboxes**.

### Session ownership

Persisted and resumed sessions have an exclusive, cooperative `<sessionFile>.subagent-lock` held from before launch through cleanup. Competing subagent parents reject contention rather than queueing. These locks do not protect against an ordinary Pi process opening the same file; do not open a session elsewhere while a child owns it.

Normal completion, cancellation, and failed startup release ownership only after confirmed cleanup; leader exit alone is insufficient. A hard parent crash or unconfirmed cleanup leaves the lock in place. Confirmation covers the managed root group and captured descendants, not all possible external effects. If the leader exits before its descendant tree can be observed, cleanup is unconfirmed rather than assumed safe. Locks never expire automatically: verify that the old child has stopped before manually removing an orphaned lock. The lock records the parent PID and child run ID. This conservative recovery avoids allowing two writers while an old child is still alive.

Terminal reports expose `cleanup.status`: `confirmed` or `unconfirmed`. Unconfirmed cleanup retains the admission slot and any session lease, even after the report is collected. Such handles cannot be resumed, cleared, or evicted in that parent session. `cleanup.taskOutcome` preserves the outcome before cleanup; a completed task becomes a failed execution if cleanup cannot be confirmed, while timeout/provider causes remain primary. Reconcile process and workspace state before recovery; a new parent session clears handle reservations, not orphaned lock files.

## Tools and context

Defaults are the parent's active tools among `read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, and `query-docs`. Mutation tools (`bash`, `edit`, `write`) must be requested explicitly. `tools: []` is reasoning-only.

Explicit tools must be active or callable in the parent and are passed to the child as an exact allowlist. All unselected tools are also passed through `--exclude-tools`, so nested/codemode calls cannot reach them. The child probe must report the same active set before the task starts and blocks tool calls outside the allowlist, including nested `executeTool()` calls. Children are leaves: the `subagent` tool cannot be passed to a child, and nested calls are rejected.

`model` is an exact `provider/model-id`; otherwise the parent's model is inherited. `thinking` selects a reasoning effort supported by that model. An explicit unsupported level fails before prompting. A different model uses its own Pi defaults when `thinking` is omitted.

`cwd` defaults to the parent cwd, except handle-based resume uses the child's original cwd. A fresh child starts a new conversation; the prompt must carry scope, evidence, constraints, expected output, and checks. Parent history, runtime-only tools, and permission-hook state are not copied.

## Limits

| Resource | Limit |
| --- | --- |
| Admission slots | 4 per parent session, including cleanup-unconfirmed children; excess starts are rejected |
| Retained handles | 32; oldest completed, read handles are evicted first; unread results are never evicted |
| Startup | 30 seconds by default, up to 5 minutes |
| Execution deadline | Off by default; optional configured cutoff up to 2 hours |
| One wait | 5 minutes by default, at most 10 |
| Task prompt | 100 KiB |
| Tool response and details | 50 KiB each |
| Child stderr | 50 KiB, keeping both ends |

Child reports remain bounded in memory; they are not spilled to disk. Text, structured results, and renderer details derive from the same budgeted report view. `outputTruncation` records shortened UTF-8 output. Launch metadata omitted for space is absent and listed in `omittedFields`, not replaced with empty values. Session paths are whole or absent; inspect one child with `status` for an omitted path. A persisted session is separate from that report.

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

- **0.0.20**:
  - Execution deadlines are off by default. Set `executionTimeoutMs` or `PI_SUBAGENT_TIMEOUT_MS` to opt in; task preflight follows the same policy. Startup protection and join budgets remain separate.
  - Resume a saved conversation by handle or path, and retain completed answers across steering. Model and effort are explicitly established and verified before task submission.
  - Child execution has one lifecycle owner. Cleanup uncertainty retains admission and session ownership without hiding the task outcome; RPC queues and public reports are bounded.
  - **Migration:** remove `notify`, `stdout`, and synthetic `state.exitCode` usage. Result omissions and cleanup disposition are explicit; see [Migration](#migration).
- **0.0.19**:
  - **Migration:** children now save recoverable conversations by default, including prompts and tool results; use `persist: false` for ephemeral work.
  - **Recovery:** results expose effective deadlines and interruption observations. Failed reports retain earlier visible work and authoritative completed text blocks, with truthful Unicode/truncation accounting. Activity distinguishes Pi retry backoff and compaction. Oversized batch details may explicitly omit session paths; inspect an individual child with `status` for its full path.
  - **Compatibility:** support Pi 1.5 schemas and host keybindings while retaining Pi 1.3 support; preserve provider-billed usage totals and provenance.
  - Hard execution limits are unchanged. No automatic wrap-up, retry, or budget extension is added.
- **0.0.13**: replace the custom SDK child bootstrap with Pi's public RPC protocol. Add `steer`, persisted/resumable child sessions (`persist`, `resume`), and opt-in `trustProject`. Remove `jiti`, private Pi imports, and the custom fd-3 child protocol. Add an active-tool probe so missing tools fail before prompting. Wrap prompts and steering to prevent RPC command expansion, exclude all unselected tools from nested calls, preserve orderly child shutdown hooks, ignore oversized `agent_end` history, retain the latest partial report, and expose persisted session paths in model-facing text. Notices announce handles without consuming reports. Persisted sessions have exclusive ownership, startup operations share one deadline, and children inherit the ordinary process environment.

## Migration

### 0.0.20

- Execution deadlines are now opt-in. Omit `executionTimeoutMs` and leave `PI_SUBAGENT_TIMEOUT_MS` unset for no execution cutoff. Valid environment configuration still provides a global default; explicit arguments override it. Invalid execution-limit environment values now fail instead of falling back silently. Startup, foreground handoff, wait, and cleanup budgets are unchanged.
- Initial task preflight no longer has a separate 30-second RPC acknowledgment cutoff; optional execution deadlines govern preflight as well as model/tool work.

- Result consumers must stop reading synthetic `state.exitCode` and unused `stdout`; use `state.outcome`, `errorKind`, and `stderr`. Optional `cleanup` describes resource disposition separately from the task outcome.
- Budget-omitted `prompt`, `cwd`, and `tools` are now absent rather than empty placeholders. `omittedFields` identifies omitted launch metadata or session paths. Model text and structured results use the same report excerpt.
- Cleanup-unconfirmed children retain admission and session ownership even after collection. They are not resumable or eligible for clearing/eviction in that parent session.

- Remove `notify` from calls. All unread completions now use active-boundary announcements with inbox fallback, without waking idle parents. Notices still require `wait` to collect reports.
- Successful `output` may contain several completed answers from one execution, separated by blank lines, rather than only the last answer after steering. It remains bounded; inspect `outputTruncation` for loss.
- `resume` accepts a retained `sa-N` handle or an explicit session path. Handle resume creates a new handle in the original workspace by default and leaves the earlier report readable. Explicit `persist` (including `false`) cannot be combined with `resume`.

### From the SDK child

- `PI_SUBAGENT_RUNNER`, `PI_SUBAGENT_BIN`, and `PI_BIN` are no longer used. The child requires the installed Pi CLI.
- Children now use a real Pi RPC process. Project trust follows RPC rules; pass `trustProject: true` for a one-shot `--approve` or save a trust decision.
- Child sessions are saved by default; `persist: false` opts out, and `resume: "<sessionFile>"` continues one. Existing SDK child handles do not migrate.
- `steer` is available only while a child is running. After completion, resume its persisted session to continue the conversation.
- Tool availability is checked by a public extension probe before the prompt; a missing built-in or MCP tool exhausts startup without starting model work.
- Completion notices no longer embed reports or implicitly acknowledge them. Retrieve reports with `wait`; `status` remains observational.
- `PI_SUBAGENT_PASSTHROUGH_ENV` is retired. Child processes inherit ordinary environment configuration; session-identity variables are replaced, not copied.
