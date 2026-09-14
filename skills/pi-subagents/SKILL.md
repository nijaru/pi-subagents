---
name: pi-subagents
description: Use when delegating a self-contained task to a fresh Pi child, choosing foreground versus background execution, or managing a child with status, wait, and stop. Not for persistent agent teams or workflow graphs.
---

# Pi Subagents

Use one child for one concrete task. Keep routine or tightly coupled work local. A child is useful when independent execution or context separation outweighs the handoff cost.

## Choose the lifecycle

- **run**: join the child within a foreground budget (60 seconds by default) and get its final result. If the budget expires the child keeps working as background work and sends a completion notice, so never relaunch it. Cancelling the call cancels the child and joins cleanup.
- **spawn**: return a child id and continue useful non-overlapping work. Completion sends a notice and requests a follow-up parent turn.
- **status**: inspect one id, or omit id to list retained children.
- **wait**: retrieve the final result, waiting up to `timeoutMs` (default 30 seconds, maximum 120 seconds). Expiry or cancellation does not stop the child. A blocking wait or run claims the result it delivers, so it suppresses a redundant completion notice; do not call `wait` again for a result you already received.
- **stop**: cancel the child and join cleanup. Safe to repeat.

```json
{"command":"spawn","prompt":"Investigate the retry failure in src/client.ts. Return a reproduction and a concrete fix recommendation; do not edit files.","tools":["read"]}
{"command":"wait","id":"<child-id>"}
```

The prompt must carry the relevant evidence, decisions, scope, constraints, expected output, and checks. No parent conversation history is copied, but the child's own Pi configuration, skills, and applicable AGENTS.md files still load. There are no named profiles or personas.

## Assign tools and write ownership

Omitted `tools` selects active parent coding and known research tools. Use an explicit list to narrow access, or `tools: []` for reasoning-only work. Research extensions must be installed in child Pi too; parent runtime-only tools and providers are not copied. `model` overrides the inherited parent model; thinking effort inherits the parent session level.

Tools must be active in the parent. `subagent` itself is forbidden: children are leaves. These are access controls, not a sandbox or a transfer of parent permission-hook state. The child loads its own Pi extensions regardless of the tool allowlist, so extension code beyond provider tools still runs in it.

Give concurrent writers distinct worktrees through `cwd`. Children are separate processes sharing one working tree; the extension does not arbitrate write ownership and cannot prevent overlap with parent edits. Do not duplicate the delegated assignment. Inspect returned evidence or patches and own integration and final verification in the parent.

## Failure and recovery

A failed `run` or completed `wait` is a tool error. Use `status` with its id to inspect the retained failure state. A wait-budget expiry means only that the child is still running; do not launch a duplicate replacement. Wait only when the result blocks your next step, not in a tight polling loop.

Four children may be active. When admission is rejected, wait for or stop existing work rather than bypassing the limit. Up to 32 handles are retained; oldest completed handles are evicted. Quit, reload, or session replacement stops all children and discards handles. Background work needs a live parent process and does not survive restart, but a crashed or killed parent still stops its children rather than leaving them mutating the tree.

Child deadlines default to 30 minutes (`PI_SUBAGENT_TIMEOUT_MS`, at most two hours). Prompts are capped at 100 KiB, responses and result details at 50 KiB each, and completion excerpts at 8 KiB; the prompt travels on the child's stdin, never in command arguments or a temporary file. A completion notice already contains the result unless it says the excerpt was truncated.
