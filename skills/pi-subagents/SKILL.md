---
name: pi-subagents
description: Use when delegating a self-contained task to a fresh Pi child, choosing foreground versus background execution, or managing a child with status, wait, and stop. Not for persistent agent teams or workflow graphs.
---

# Pi Subagents

Use one child for one concrete task. Keep routine or tightly coupled work local. A child is useful when independent execution or context separation outweighs the handoff cost.

## Choose the lifecycle

- **run**: join the child within a foreground budget (60 seconds by default) and get its final result. If the budget expires the child keeps working as background work; never relaunch it. Completion follows the same boundary-only delivery as `spawn`. Cancelling the call cancels the child and joins cleanup.
- **spawn**: return a child id and continue useful non-overlapping work. Spawn independent tasks before waiting. Unread results are batched at successful active-turn boundaries; they never wake an idle parent or queue a redundant follow-up after you read them. Use `wait` before finishing if your task depends on the result.
- **status**: inspect one id, or omit id to list retained children.
- **wait**: pass `ids: ["<child-id>", ...]`, not `id`. Wake when any selected child finishes, return all ready reports, and identify children still running. One shared `timeoutMs` budget defaults to five minutes, at most ten; longer waits still wake immediately on completion. Expiry or cancellation does not stop children. Returned terminal reports are marked read and their notices suppressed. Wait again only on remaining ids when blocked; do not poll or reread received reports unless you need a longer retained excerpt.
- **stop**: cancel the child and join cleanup. Safe to repeat.

```json
{"command":"spawn","prompt":"Investigate the retry failure in src/client.ts. Return a reproduction and a concrete fix recommendation; do not edit files.","tools":["read"]}
{"command":"wait","ids":["<child-id>"]}
```

The prompt must carry the relevant evidence, decisions, scope, constraints, expected output, and checks. No parent conversation history is copied, but the child's own Pi configuration, skills, and applicable AGENTS.md files still load. There are no named profiles or personas.

## Assign tools and write ownership

Omitted `tools` selects active parent coding and known research tools. Use an explicit list to narrow access, or `tools: []` for reasoning-only work. Research extensions must be installed in child Pi too; parent runtime-only tools and providers are not copied. `model` must be an exact `provider/model-id` and overrides the inherited parent model. Optional `thinking` selects a supported Pi effort. Omitted effort inherits the parent level for the same model; a different model uses its Pi defaults. Set both for a deliberate model/effort combination. Unsupported explicit effort fails before prompting; reports show the effective startup level. Child startup fails if that model or any requested tool is unavailable in the child's own configuration. Do not retry the same unavailable capability unchanged.

Tools must be active in the parent. `subagent` itself is forbidden: children are leaves. These are access controls, not a sandbox or a transfer of parent permission-hook state. The child loads its own Pi extensions regardless of the tool allowlist, so extension code beyond provider tools still runs in it.

Give concurrent writers distinct worktrees through `cwd`. Children are separate processes sharing one working tree; the extension does not arbitrate write ownership and cannot prevent overlap with parent edits. Do not duplicate the delegated assignment. Inspect returned evidence or patches and own integration and final verification in the parent.

## Failure and recovery

A `run` or `wait` returning a failed child is a tool error. A mixed wait still contains successful reports; use them instead of repeating completed work. Model output limits produce `incomplete`, not success; inspect the partial report and narrow or split the task if more work is needed. Use `status` with its id to inspect the retained failure state. `wait_expired: true` means the wait budget expired with no selected child complete, not that execution timed out; do not launch duplicate replacements. Wait when the result blocks your next step or finishing your task, not in a tight polling loop.

Four children may be active. When admission is rejected, wait for or stop existing work rather than bypassing the limit. Up to 32 handles are retained; oldest completed, delivered handles are evicted. If unread results fill retention, read them with `wait` before starting more children. Quit, reload, or session replacement stops all children and discards handles. Background work needs a live parent process and does not survive restart, but a crashed or killed parent still stops its children rather than leaving them mutating the tree.

Child deadlines default to 30 minutes (`PI_SUBAGENT_TIMEOUT_MS`, at most two hours). Prompts are capped at 100 KiB, responses and result details at 50 KiB each, and completion excerpts at 8 KiB; the prompt travels on the child's stdin, never in command arguments or a temporary file. A completion notice already contains the result unless it says the excerpt was truncated. To read a longer excerpt, wait on that child alone. A single-child response may still be shortened to fit the response budget; repeating it will not recover more text. Text beyond the report retention limit is not recoverable; `outputTruncation` describes the loss. Task text is literal, so a leading slash does not execute a Pi command. See the README migration section for SDK installation requirements and removed CLI overrides.
