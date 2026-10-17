---
name: pi-subagents
description: Use when delegating a self-contained task to a fresh Pi child, choosing foreground versus background execution, or managing a child with status, wait, and stop. Not for persistent agent teams or workflow graphs.
---

# Pi Subagents

Requires a Node/npm Pi 1.0.4+ installation with its SDK and Node 22.19+. Use one child for one concrete task. Keep routine or tightly coupled work local. A child is useful when independent execution or context separation outweighs the handoff cost.

## Choose the lifecycle

- **run**: start a child and join it for `joinTimeoutMs` (60 seconds by default). If the join expires, the call returns a running handle and the child continues as background work; never relaunch it. Cancelling the call cancels the child.
- **spawn**: return a child handle immediately. Spawn independent tasks before waiting.
- **status**: inspect one handle, or omit it to list retained children.
- **wait**: pass `ids` containing handles (`sa-1`) or full UUIDs. Wake when any selected child finishes, return all ready reports, and identify those still running. One shared `timeoutMs` budget defaults to five minutes, at most ten; longer waits still wake immediately on completion. Expiry or cancellation does not stop children or change their execution deadlines. Wait again only on remaining ids when blocked.
- **stop**: cancel the child and join cleanup. Safe to repeat.

`notify` controls completion delivery:

- **inbox** (default): no parent turn is spent. The next tool result advertises unread handles, the footer and `/subagents` show the count, and `wait` reads the reports. Idle parents are never woken.
- **turn**: request one parent continuation at an active boundary when the child finishes. Use this only when the result should resume the parent immediately. Aborts, provider errors, and dropped notices leave the report unread for `wait`.

```json
{"command":"spawn","prompt":"Investigate the retry failure in src/client.ts. Return a reproduction and a concrete fix recommendation; do not edit files.","tools":["read"]}
{"command":"wait","ids":["sa-1"]}
```

The prompt must carry the relevant evidence, decisions, scope, constraints, expected output, and checks. No parent conversation history is copied, but the child's own Pi configuration, skills, and applicable AGENTS.md files still load. There are no named profiles or personas.

## Assign tools and write ownership

Omitted `tools` selects active parent read/search/web tools (`read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `web_research`, `resolve-library-id`, `query-docs`). Mutation tools (`bash`, `edit`, `write`) must be requested explicitly. Use an explicit list to narrow access, or `tools: []` for reasoning-only work. Parent runtime-only tools and providers are not copied; research extensions must be installed in child Pi too. `model` must be an exact `provider/model-id` and overrides the inherited parent model. Optional `thinking` selects a supported Pi effort. Omitted effort inherits the parent level for the same model; a different model uses its Pi defaults. Set both for a deliberate model/effort combination. Unsupported explicit effort fails before prompting; reports show the effective startup level. Child startup fails if that model or any requested tool is unavailable in the child's own configuration.

Explicit tools must be active or callable in the parent and listed by exact name, not wildcard patterns. Codemode/deferred tools can be callable without being active; merely registered or hidden tools are not eligible. Selecting codemode does not grant omitted tools; include every tool it may call. Explicit MCP tools get up to ten seconds to register before startup fails. `subagent` itself is forbidden: children are leaves. These are access controls, not a sandbox or a transfer of parent permission-hook state. The child loads its own Pi extensions regardless of the tool allowlist, so extension code beyond provider tools still runs in it.

Give concurrent writers distinct worktrees through `cwd`. Children are separate processes sharing one working tree; the extension does not arbitrate write ownership and cannot prevent overlap with parent edits. Do not duplicate the delegated assignment. Inspect returned evidence or patches and own integration and final verification in the parent.

## Time budgets

| Budget | Default | Scope |
| --- | --- | --- |
| `startupTimeoutMs` | 30 seconds (`PI_SUBAGENT_STARTUP_TIMEOUT_MS`) | Process, watchdog, SDK, extensions, and MCP readiness before the task starts |
| `executionTimeoutMs` | 30 minutes (`PI_SUBAGENT_TIMEOUT_MS`) | Model/tool work, starting at the ready frame |
| `joinTimeoutMs` | 60 seconds (`PI_SUBAGENT_FOREGROUND_MS`) | How long a `run` call blocks before returning a running handle |
| `timeoutMs` | 5 minutes | How long one `wait` call joins; never changes a child deadline |

`startupTimeoutMs` and `executionTimeoutMs` are run/spawn options within 5 minutes and 2 hours respectively. `joinTimeoutMs` applies only to `run`. At expiry the child is stopped and keeps partial output, with the cause naming the phase, elapsed runtime, and applied deadline. Cancelling `wait` leaves children running; use `stop` to cancel one.

## Failure and recovery

A `run` or `wait` returning a failed child is a tool error. Codemode callers receive `{ command, results, waitExpired? }` for both successful and failed reports: inspect `results[].state`, `phase`, `errorKind`, and `output`, not the prose summary. A resolved script call does not prove the child succeeded. Invalid requests and cancelled waits still reject. A mixed wait still contains successful reports; use them instead of repeating completed work. Model output limits produce `incomplete`, not success; inspect the partial report and narrow or split the task. A `timed_out` result means the child hit its startup or execution deadline: partial output and the phase/runtime/deadline are retained, so narrow or split the task and rerun with an adequate deadline instead of relaunching it unchanged. `wait_expired: true` means the wait budget expired with no selected child complete, not that execution timed out; do not launch duplicate replacements. Wait when the result blocks your next step or finishing your task, not in a tight polling loop.

Four children may be active. When admission is rejected, wait for or stop existing work rather than bypassing the limit. Up to 32 handles are retained; oldest completed, read handles are evicted. If unread results fill retention, read them with `wait` before starting more children. Quit, reload, or session replacement stops all children and discards handles. Background work needs a live parent process and does not survive restart, but a crashed or killed parent still stops its children rather than leaving them mutating the tree.

Prompts are capped at 100 KiB, responses and result details at 50 KiB each, and completion excerpts at 8 KiB; the prompt travels on the child's stdin, never in command arguments or a temporary file. Task text is literal, so a leading slash does not execute a Pi command. Text beyond the report retention limit is not recoverable; `outputTruncation` describes the loss. `/subagents` is a human-facing list of retained children and unread results; it does not consume reports.
