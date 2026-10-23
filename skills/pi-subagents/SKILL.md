---
name: pi-subagents
description: Use when delegating a self-contained task to a fresh Pi child over RPC, choosing foreground versus background execution, steering a running child, or managing persisted child sessions with status, wait, stop, and resume. Not for persistent agent teams or workflow graphs.
---

# Pi Subagents

Requires Pi 1.3.0+ from a Node/npm installation with the `pi` CLI and Node 22.19+. Use one child for one concrete task. Keep routine or tightly coupled work local. A child is useful when independent execution or context separation outweighs the handoff cost.

## Choose the lifecycle

- **run**: start a child and join it for `joinTimeoutMs` (60 seconds by default). If the join expires, the call returns a running handle and the child continues as background work; never relaunch it. Cancelling the call cancels the child.
- **spawn**: return a child handle immediately. Spawn independent tasks before waiting.
- **steer**: queue a message after the child's current assistant turn and tool calls. Requires `id` and `message`. During startup it waits for the child's readiness under the startup deadline. Cancellation stops waiting, not the child; an instruction already sent cannot be recalled. A settled child must be resumed instead.
- **status**: inspect one handle, or omit it to list retained children.
- **wait**: pass `ids` containing handles (`sa-4821`) or full UUIDs. Wake when any selected child finishes, return all ready reports, and identify those still running. One shared `timeoutMs` budget defaults to five minutes, at most ten; longer waits still wake immediately on completion. Expiry or cancellation does not stop children or change their execution deadlines. Wait again only on remaining ids when blocked.
- **stop**: cancel the child and join cleanup. Safe to repeat.

`notify` controls completion delivery:

- **inbox** (default): no parent turn is spent. Once per parent turn, the next top-level non-subagent tool result advertises unread handles, the footer and `/subagents` show the count, and `wait` reads the reports. Idle parents are never woken.
- **turn**: additionally request a handle announcement and continuation at an active boundary. It never wakes an idle parent. Each child gets at most one attempt per parent run; a later extension may discard the draft.

Notices never contain or acknowledge reports. Call `wait` to retrieve reports after either kind of notice. A completed `run` or `stop` also reads its result; `status` does not. Unread reports remain discoverable in the inbox after aborted continuations or dropped notices.

```json
{"command":"spawn","prompt":"Investigate the retry failure in src/client.ts. Return a reproduction and a concrete fix recommendation; do not edit files.","tools":["read"]}
{"command":"steer","id":"sa-4821","message":"Also check the empty-input case."}
{"command":"wait","ids":["sa-4821"]}
```

The prompt must carry the relevant evidence, decisions, scope, constraints, expected output, and checks. No parent conversation history is copied, but the child's own Pi configuration, skills, and applicable AGENTS.md files still load. There are no named profiles or personas.

## Persist and resume

`persist: true` stores the child Pi session under the agent directory (`~/.pi/agent/subagents/sessions/<id>.jsonl` by default) and returns `sessionFile`; the path is included in `run`, `spawn`, `wait`, and `status` text. Reuse it later with `run` or `spawn` and `resume: "<path>"` to continue that conversation instead of starting fresh; resume in the original `cwd`. Relative paths resolve against the parent cwd. The active parent session cannot be a resume target. `persist` and `resume` are mutually exclusive. Persisted sessions are not the same as retained handles; `/subagents clear` only drops in-memory handles.

Persisted and resumed sessions are exclusively owned through cleanup. Competing subagent parents fail rather than queue. Ordinary Pi processes do not honor this cooperative lock: do not open an owned session elsewhere. A hard parent crash or unconfirmed cleanup leaves `<sessionFile>.subagent-lock` behind. Verify that the old child has stopped before manually removing an orphaned lock; it never expires automatically.

RPC mode cannot show Pi's project-trust prompt. Project-local resources are skipped unless a saved decision applies or the call sets `trustProject: true`, which passes `--approve` for that child. Parent trust and permission-hook state are not inherited.

## Assign tools and write ownership

Omitted `tools` selects active parent read/search/web tools (`read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, `query-docs`). Mutation tools (`bash`, `edit`, `write`) must be requested explicitly. Use an explicit list to narrow access, or `tools: []` for reasoning-only work. Parent runtime-only tools and providers are not copied; research extensions must be installed in child Pi too. `model` must be an exact `provider/model-id` and overrides the inherited parent model. Optional `thinking` selects a supported Pi effort. Omitted effort inherits the parent level for the same model; a different model uses its Pi defaults. Set both for a deliberate model/effort combination. Unsupported explicit effort fails before prompting; reports show the effective startup level.

Explicit tools must be active or callable in the parent and listed by exact name, not wildcard patterns. The child starts with that exact allowlist; all unselected tools are explicitly excluded, so nested calls cannot reach them. A typed readiness probe verifies the active set before the prompt and blocks calls outside the allowlist. A missing requested tool exhausts the startup deadline without submitting model work. Codemode/deferred tools can be callable without being active; merely registered or hidden tools are not eligible. Selecting codemode does not grant omitted tools; include every tool it may call. `subagent` itself is forbidden: children are leaves. These are access controls, not a sandbox or a transfer of parent permission-hook state. The child loads its own Pi extensions regardless of the tool allowlist, so extension code beyond provider tools still runs in it. Children inherit the ordinary parent environment, including credentials and tool configuration; parent session-identity variables are replaced, not copied.

Give concurrent writers distinct worktrees through `cwd`. Children are separate processes sharing one working tree; the extension does not arbitrate write ownership and cannot prevent overlap with parent edits. Do not duplicate the delegated assignment. Inspect returned evidence or patches and own integration and final verification in the parent.

## Time budgets

| Budget | Default | Scope |
| --- | --- | --- |
| `startupTimeoutMs` | 30 seconds (`PI_SUBAGENT_STARTUP_TIMEOUT_MS`) | RPC process, model selection, tool probe, and readiness before the task starts |
| `executionTimeoutMs` | 30 minutes (`PI_SUBAGENT_TIMEOUT_MS`) | Model/tool work, starting when the task is submitted |
| `joinTimeoutMs` | 60 seconds (`PI_SUBAGENT_FOREGROUND_MS`) | How long a `run` call blocks before returning a running handle; at most 10 minutes |
| `timeoutMs` | 5 minutes | How long one `wait` call joins; never changes a child deadline |

`startupTimeoutMs` and `executionTimeoutMs` are run/spawn options within 5 minutes and 2 hours respectively. `joinTimeoutMs` applies only to `run` and is capped at 10 minutes; an out-of-range `PI_SUBAGENT_FOREGROUND_MS` value falls back to the 60-second default. At startup/execution expiry the child is stopped and keeps partial output; `timeoutPhase` names startup or execution, and the cause carries elapsed runtime and the applied deadline. Cancelling `wait` leaves children running; use `stop` to cancel one.

## Failure and recovery

A `run` or `wait` returning a failed child is a tool error. Codemode callers receive `{ command, results, waitExpired? }` for both successful and failed reports: inspect `results[].state`, `phase` (`starting`, `running`, or `stopping` while live), `errorKind`, `timeoutPhase`, `sessionFile`, and `output`, not the prose summary. A resolved script call does not prove the child succeeded. Invalid requests and cancelled waits still reject. A mixed wait still contains successful reports; use them instead of repeating completed work. Model output limits produce `incomplete`, not success; inspect the partial report and narrow or split the task. A `timed_out` result means the child hit its startup or execution deadline: partial output and the timeout phase/runtime/deadline are retained; reported runtime excludes cleanup, so narrow or split the task and rerun with an adequate deadline instead of relaunching it unchanged. `wait_expired: true` means the wait budget expired with no selected child complete, not that execution timed out; do not launch duplicate replacements.

Four children may be active. When admission is rejected, wait for or stop existing work rather than bypassing the limit. Up to 32 handles are retained; oldest completed, read handles are evicted. If unread results fill retention, read them with `wait` before starting more children. Quit, reload, or session replacement stops all children and discards handles. Background work needs a live parent process and does not survive restart, but a crashed or killed parent still stops its child process group.

Prompts are capped at 100 KiB and responses and result details at 50 KiB each. Completion notices carry handles only. Task and steering text is wrapped in a `Task:`/`Steering instruction:` envelope before RPC submission, so a leading slash cannot execute a child command, skill, or prompt template. Text beyond the report retention limit is not recoverable; `outputTruncation` describes the loss. `/subagents` is a human-facing list of retained children and unread results; `/subagents clear` drops completed read handles. It does not consume reports.
