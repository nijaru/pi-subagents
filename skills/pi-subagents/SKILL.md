---
name: pi-subagents
description: Use when delegating a self-contained task to a fresh Pi child over RPC, choosing foreground versus background execution, steering a running child, or continuing a saved child session. Not for persistent agent teams or workflow graphs.
---

# Pi Subagents

Requires Pi 1.3.0+ from a Node/npm installation with the `pi` CLI and Node 22.19+. Delegate when independent execution or context separation outweighs the handoff cost. Keep routine or tightly coupled work local; the parent owns integration and verification.

## Normal workflow

1. Give each child a concrete task with evidence, scope, constraints, expected output, and checks. Fresh children do not receive parent conversation history; their own Pi configuration, skills, and applicable AGENTS.md files still load.
2. Use **run** for a result, or **spawn** for independent work alongside useful local work. Spawn independent tasks before waiting.
3. Use **wait** with `ids` containing handles (`sa-4821`) when results block progress. It wakes when any selected child finishes, returns ready reports, and identifies remaining children. Wait again only on remaining handles; do not poll or duplicate running work.
4. Inspect reports and changes, integrate, and verify in the parent.

```json
{"command":"spawn","prompt":"Investigate the retry failure in src/client.ts. Report concrete regressions with file/line and evidence. Do not edit files.","tools":["read"]}
{"command":"steer","id":"sa-4821","message":"Also check the empty-input case."}
{"command":"wait","ids":["sa-4821"]}
```

**steer** queues an instruction after the running child's current assistant turn and tool calls. During startup it joins readiness. It cannot interrupt a model request or tool batch; acceptance is not proof of delivery. Cancelling steering stops waiting, not the child, and cannot recall an instruction already sent. Successful output retains completed answers before and after steering, excluding tool-use narration.

**status** inspects one handle or lists retained children without collecting reports. **stop** cancels a child and joins cleanup; safe to repeat. `status`, `wait`, `stop`, and `steer` also accept full UUIDs.

Unread completions announce handles at successful active boundaries and on later top-level non-subagent tool results. Notices never contain or collect reports; retrieve them with `wait`. Idle parents are never woken. Boundary announcements are attempted once per child per parent run and suppressed after an error or abort, even if a retry succeeds. Do not rely on an extra turn to collect work.

## Tools and write ownership

Omitted `tools` selects active parent read/search/web tools. Request mutation tools (`bash`, `edit`, `write`) explicitly; `tools: []` is reasoning-only. Explicit names must be active or callable in the parent. Selecting codemode does not grant omitted tools: include every tool it may call. Merely registered or hidden tools are ineligible. Children are leaves; `subagent` cannot be delegated.

The child verifies the exact active set before model work and blocks calls outside it, including nested calls. Runtime-only parent tools/providers and permission-hook state are not copied. Missing tools exhaust startup without submitting the task. Children inherit ordinary environment configuration, including credentials, but not parent session identity. Tool allowlists and subprocesses are not sandboxes; installed extensions still execute.

Give concurrent writers separate worktrees through `cwd`, including parent-versus-child writers. Processes share the selected workspace; the extension does not arbitrate write ownership. Do not duplicate delegated work.

`model` is an exact `provider/model-id`, defaulting to the parent's model. Omitted `thinking` inherits parent effort for the same model; a different model uses its Pi defaults. Explicit unsupported effort fails before prompting. Startup sets and verifies the requested configuration; reports show effective effort.

## Continue a stopped child

New children save their conversation by default; use `persist: false` for sensitive or ephemeral work. Results include `sessionFile`, also on failure; startup may fail before creating the file. Saved conversations may contain prompts/tool results and are not complete token traces.

Use `run` or `spawn` with a focused prompt and `resume: "sa-4821"`. This creates a new handle, defaults to the original cwd, and leaves the old report readable. It requires a stopped child with a saved session. Tools, model, effort, and trust follow normal launch rules, not the old handle's options.

After handles are cleared or the parent restarts, use `resume: "<sessionFile>"` with the original `cwd`. Relative paths resolve against the parent cwd. The active parent session and mismatched workspaces are rejected. Do not combine `persist` with `resume`.

Persisted sessions have exclusive cooperative ownership through cleanup. Ordinary Pi processes do not honor the lock; do not open an owned session elsewhere. A hard crash or unconfirmed cleanup can leave `<sessionFile>.subagent-lock`; verify the old child has stopped before removing it. Locks never expire automatically.

RPC cannot show project-trust prompts. Set `trustProject: true` for one-shot `--approve` when project resources are needed; parent trust is not inherited.

## Budgets and recovery

| Option | Default | Meaning |
| --- | --- | --- |
| `startupTimeoutMs` | 30s | Process/configuration/tool readiness; maximum 5m |
| `executionTimeoutMs` | 30m | Model/tool work after task submission; maximum 2h |
| `joinTimeoutMs` | 60s | One `run` join; maximum 10m |
| `timeoutMs` | 5m | One `wait` join; maximum 10m |

Environment defaults: `PI_SUBAGENT_STARTUP_TIMEOUT_MS`, `PI_SUBAGENT_TIMEOUT_MS`, and `PI_SUBAGENT_FOREGROUND_MS`. Join/wait expiry leaves children running and does not change execution deadlines. Never relaunch because a join expired. Cancelling `run` cancels its child; cancelling `wait` leaves children running.

Failed `run`/`wait` reports are tool errors. Codemode still returns `{ command, results, waitExpired? }`: inspect each `state`, `errorKind`, `timeoutPhase`, and `output`. Mixed waits retain successful reports; do not repeat that work. Invalid requests and cancelled waits reject. `incomplete` means a model output limit, not success. `waitExpired: true` means no selected child completed within the wait budget, not an execution timeout.

On timeout or failure, inspect retained output, timing, and saved history before choosing recovery. `deadline` records the effective phase cutoff; activity never extends it. `lastActivityAt` and live `activity`/`currentTool` distinguish model, thinking, text, tool, Pi retry, and compaction observations without exposing private payloads. Neither silence nor activity proves a stall or useful progress; deadline expiry does not establish its cause.

Before continuing interrupted mutations, reconcile workspace/external effects. `interruption` records observed activity and tool starts without observed ends, not a complete effects ledger. A tool may apply a mutation without saving its result; missing or synthetic results do not prove failure. Resume is not rollback and never justifies blind replay. Resend still-needed steering explicitly; undelivered queues are not saved history.

## Limits and retention

Four active children and 32 retained handles per parent. Wait for or stop work when admission is full; read unread reports before starting more. Only explicit `run`/`wait`/`stop` retrieval collects terminal reports. Oldest completed, collected handles may be evicted; unread reports never are. `/subagents` lists children; `/subagents clear` drops completed, collected handles, not session files.

Prompts are capped at 100 KiB; responses and details at 50 KiB each. Reports retain bounded UTF-8 prefixes with `outputTruncation`; larger text requires a saved session. If batch details list `sessionFile` in `omittedFields`, inspect that child alone with `status` for its full path. Never resume from a shortened prose path. Task/steering envelopes keep leading slash commands literal.

Quit, reload, or session replacement stops all children and discards handles. Background work requires a live parent; the parent-death watchdog stops the child process group after a hard crash.
