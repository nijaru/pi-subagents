# pi-subagents

Pi extension for task-first delegation to fresh child Pi processes over the public RPC protocol. One tool exposes `run`, `spawn`, `status`, `wait`, `stop`, and `steer`.

## Stack and checks

TypeScript, Bun, Pi extension/TUI APIs, TypeBox. Pi loads the extension directly; no build step.

```bash
bun run check
```

Before merging, inspect the complete diff and run the checks. Release through the manual `publish` workflow, never from a working tree. Verify the packed artifact with `npm pack`, extract it, and run a real delegation before dispatching.

## Versioning

Stay on `0.0.x` while this is pre-release and effectively single-user: bump only the patch component and put breaking changes in the README migration section. Move to `0.x.0` once another consumer depends on compatibility. Never rely on a `0.0.x` range to warn about a break.

## Ownership and contracts

- `extensions/pi-subagents/index.ts`: registration, parent session lifecycle, command dispatch, completion notices, rendering.
- `children.ts`: session-owned handles, admission, wait/stop/steer, completion ownership, usage accounting, retention, shutdown fencing.
- `delivery.ts`: active-turn boundary batching; never wake idle parents. Boundary drafts remain provisional until confirmed; no busy-parent follow-up queue.
- `supervisor.ts`: the single execution boundary. It spawns `pi --mode rpc`, speaks the public JSONL protocol, wraps prompts/steering to keep them literal, verifies model/thinking, runs the readiness command handshake, applies all-unselected tool exclusions, streams events, ignores oversized `agent_end` history, applies deadlines, and returns after orderly shutdown or bounded process-group cleanup. No session registry here.
- `probe-extension.ts`, `probe-protocol.ts`: loaded only in children. A private readiness command appends one typed custom session entry after a bounded startup window, and a tool-call guard blocks direct/nested calls outside the requested allowlist. Public extension API only; no tools.
- `process-tree.ts`: detached process-group cancellation, normal-exit sweep, and parent-death watchdog.
- `env.ts`: bounded environment inheritance for configured providers and tools.
- `params.ts`: command/tool policy, tool selection, resume/persist validation, and cwd resolution.
- `reports.ts`: bounded model-facing summaries shared by joins and notices, including persisted session paths.
- `result-schema.ts`, `types.ts`: parent-facing schema, schema-derived types, snapshots, usage, and validators.
- `bounds.ts`, `limits.ts`, `render.ts`: output/resource bounds and TUI rendering.
- `tests/`: deterministic fake-RPC lifecycle tests plus a real Pi CLI/public-protocol integration test with a local mock provider.

Children are leaves. Do not add a second scheduler, profile/workflow framework, recursive delegation, tmux dependency, or persistent supervisor daemon without an explicit product decision. `steer` is the supported mid-run control; persisted sessions support later `resume`.

Tool calls may execute in parallel. Admission must happen before asynchronous setup or callbacks. Keep the active slot until process-group cleanup finishes, not merely until assistant output arrives. Multi-child waits use one deadline, wake on any selected completion, and acknowledge only returned terminal reports; detach listeners on completion, expiry, or cancellation. Session shutdown fences notifications before aborting and joining children.

Default tools are known coding/research tools active in the parent; explicit tools may select active or callable parent tools (`ctx.tools`). The parent rejects ineligible names, excludes all unselected tools from nested reachability, then the child probe must report the exact requested active set and block calls outside it. Structured tool results and renderer details share one bounded envelope; child reports remain text. Tool allowlists and subprocesses are not sandboxes. Concurrent writers need separate worktrees; admission counts slots and does not arbitrate write ownership.

Preserve bounded output/protocol framing, truthful truncation metadata, meaningful failure states (including `incomplete`), startup/execution deadlines, and process-tree cleanup. Process timeout/cancellation outranks assistant outcomes. RPC mode cannot show the project-trust prompt; `trustProject` is the explicit one-shot `--approve`, and parent trust is not inherited. Never wake idle parents: Pi cannot expose late idle aborts reliably. Never evict unread reports. Only `SessionChildren` may publish lifecycle state; the supervisor returns execution facts.

Pi 1.3.0 is the minimum supported host; development dependencies target it. The child requires a Node/npm Pi installation and the `pi` CLI, not a standalone binary. Keep host-provided peer ranges at `*` per Pi's package contract.
