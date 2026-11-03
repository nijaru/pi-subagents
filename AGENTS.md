# pi-subagents

Pi extension for task-first delegation to fresh child Pi processes over the public RPC protocol. One tool exposes `run`, `spawn`, `status`, `wait`, `stop`, and `steer`.

## Stack and checks

TypeScript, Bun, Pi extension/TUI APIs, TypeBox. Pi loads the extension directly; no build step.

```bash
bun run check
```

Before merging, inspect the complete diff and run the checks. Release through the manual `publish` workflow, never from a working tree. Verify the packed artifact with `npm pack`, extract it, and run a real delegation before dispatching.

## Versioning

Stay on `0.0.x`: bump only the patch component when preparing an authorized release, and put breaking changes in the README migration section. A stability milestone needs an explicit user decision. Never rely on a `0.0.x` range to warn about a break.

## Ownership and contracts

- `extensions/pi-subagents/index.ts`: registration, parent session lifecycle, command dispatch, completion notices, rendering.
- `execution.ts`: immutable launch specifications, execution-owner interface, lifecycle snapshots, terminal reports, and cleanup disposition.
- `children.ts`: handles, admission, explicit joins/collection, usage accounting, retention, shutdown fencing. Retains an execution reference while active and a detached report afterward; never lends runtime records.
- `delivery.ts`: non-consuming handle announcements at active boundaries; never wake idle parents. One attempt per child per parent run prevents dropped drafts from looping.
- `supervisor.ts`: one execution owns its lifecycle, process/RPC, watchdog, session lease, deadlines, and steering readiness. Its completion resolves after cleanup disposition; no session registry here.
- `startup.ts`: model/effort selection, exact tool probe, and configuration verification under one startup deadline.
- `observations.ts`: pure bounded event reduction for visible reports, usage, and content-free activity; no resource ownership or retained assistant message payloads.
- `rpc.ts`: bounded JSONL framing, pending requests and queued write bytes, correlated typed responses, acceptance uncertainty, event delivery, and stderr retention over an already-owned process.
- `launch.ts`: CLI arguments, canonical session paths, workspace checks, and exclusive cooperative session leases.
- `probe-extension.ts`, `probe-protocol.ts`: loaded only in children. A private readiness command appends one typed custom session entry within the shared startup deadline, and a tool-call guard blocks direct/nested calls outside the requested allowlist. Public extension API only; no tools.
- `process-tree.ts`: orderly shutdown, escalation, the independent cleanup deadline, descendant sweep, and parent-death watchdog.
- `env.ts`: ordinary environment inheritance with parent session identity removed and child identity set.
- `params.ts`: command/tool policy, tool selection, resume/persist validation, and cwd resolution.
- `response.ts`: one budgeted view for model text, structured results, and renderer details.
- `reports.ts`: text formatting of that view, including recovery paths and cleanup warnings; no independent report excerpt selection.
- `result-schema.ts`, `types.ts`: parent-facing schema, schema-derived types, snapshots, usage, and validators.
- `transcript.ts`: bounded visible assistant-text history; successful results retain completed answers across steering/follow-ups, excluding tool-use narration; failures retain partial work across messages.
- `bounds.ts`, `limits.ts`, `render.ts`: output/resource bounds and TUI rendering.
- `tests/`: deterministic fake-RPC lifecycle tests plus a real Pi CLI/public-protocol integration test with a local mock provider.

Children are leaves. Do not add a second scheduler, profile/workflow framework, recursive delegation, tmux dependency, or persistent supervisor daemon without an explicit product decision. `steer` is the supported mid-run control; persisted sessions support later `resume`.

Tool calls may execute in parallel. Reserve admission before starting an execution or invoking callbacks, and through confirmed cleanup, not merely assistant output or leader exit. Cleanup uncertainty keeps its slot and lease reserved even after report collection; it must not erase the primary task outcome. Multi-child waits use one deadline, wake on any selected completion, and acknowledge only returned terminal reports; detach listeners on completion, expiry, or cancellation. Only explicit `run`/`wait`/`stop` retrieval acknowledges reports; notices and `status` never do. Session shutdown fences notifications before aborting and joining children.

Default tools are known coding/research tools active in the parent; explicit tools may select active or callable parent tools (`ctx.tools`). The parent rejects ineligible names, excludes all unselected tools from nested reachability, then the child probe must report the exact requested active set and block calls outside it. Text, structured results, and renderer details derive from one bounded view. Omitted launch metadata is absent, never a fabricated empty value; session paths fit whole or are omitted. Tool allowlists and subprocesses are not sandboxes. Concurrent writers need separate worktrees; admission counts slots and does not arbitrate write ownership.

Hold persisted-session leases through cleanup, including for newly created sessions. Never reclaim an orphaned lease by time or PID alone; ordinary Pi processes do not honor these cooperative leases. Reject the active parent session as a resume target.

Preserve bounded output/protocol framing, truthful truncation metadata, meaningful failure states (including `incomplete`), startup/execution deadlines, and process-tree cleanup. Drain buffered stdout before classifying an unexpected exit. Steering joins the child's readiness outcome, not a separate polling deadline. Process timeout/cancellation outranks assistant outcomes. RPC mode cannot show the project-trust prompt; `trustProject` is the explicit one-shot `--approve`, and parent trust is not inherited. Never wake idle parents: Pi cannot expose late idle aborts reliably. Never evict unread reports. Only the execution owner mutates runtime lifecycle; the registry projects detached snapshots and owns collection. A cancelled foreground join still joins cleanup after its join budget expires. RPC cancellation after a write has unknown acceptance; never replay automatically.

Pi 1.3.0 is the minimum supported host; development dependencies pin the current test target. The child requires a Node/npm Pi installation and the `pi` CLI, not a standalone binary. Keep host-provided peer ranges at `*` per Pi's package contract.
