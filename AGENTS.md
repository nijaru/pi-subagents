# pi-subagents

Pi extension for task-first delegation to fresh child subprocesses. One tool exposes `run`, `spawn`, `status`, `wait`, and `stop`.

## Stack and checks

TypeScript, Bun, Pi extension/TUI APIs, TypeBox. Pi loads the extension directly; no build step.

```bash
bun run check
```

Merge only a coherent, independently usable slice. Keep dependent scaffolding on feature branches. Before merging, run the checks and inspect the complete diff.

## Versioning and release

Stay on `0.0.x` while this is pre-release and effectively single-user: bump only the patch component and put breaking changes in the README migration section rather than in the version number. Move to `0.x.0` once something other than the author consumes the package, when the number has to carry compatibility meaning for someone else. `0.0.x` gives ranges no protection (`~0.0.1` would accept a breaking `0.0.2`), so never rely on the version to warn a consumer.

Release through the manual `publish` workflow, never from a working tree. Verify the packed artifact, not just the source tree: `npm pack`, extract, and run a real delegation against the extracted copy before dispatching.

## Ownership and contracts

- `extensions/pi-subagents/index.ts`: registration, parent session lifecycle, completion notices, command dispatch, rendering.
- `children.ts`: session-owned handles, synchronous admission, wait/stop, completion ownership, usage accounting, retention, shutdown fencing.
- `delivery.ts`: active-turn boundary batching; never wake idle parents. Boundary drafts remain provisional until confirmed in the transcript; no busy-parent follow-up queue.
- `supervisor.ts`: the single child execution boundary used by both run and spawn; it accepts an immutable task, owns execution data, and returns detached snapshots and a final result after cleanup. No session registry here, and no lifecycle state ownership.
- `child-bootstrap.mjs`, `child-session.ts`: selected-installation SDK loading, canonical CLI built-ins and noninteractive project trust, exact model/tool verification and readiness, and session teardown.
- `child-runner.ts`, `child-protocol.ts`: literal task execution and versioned compact records over fd 3.
- `subprocess.ts`: Node invocation, stdin bootstrap transport, bounded private-pipe framing and stdout/stderr diagnostics, deadlines, and execution cleanup coordination.
- `process-tree.ts`: process-tree cancellation, normal-exit sweep, and parent-death watchdog startup.
- `params.ts`: command/tool policy and working-directory resolution.
- `reports.ts`: bounded model-facing summaries and reports, shared by joins and completion notices; causes precede partial output and every selected child stays represented.
- `result-schema.ts`, `types.ts`: the parent-facing result schema, schema-derived types, snapshots, usage, and boundary validators. Keep schema runtime imports off the child path; packed children resolve only their selected SDK.
- `env.ts`, `bounds.ts`, `limits.ts`, `render.ts`: environment policy, output/resource bounds, TUI rendering.
- `tests/`: deterministic lifecycle tests plus real subprocess protocol regression tests.

Children are leaves. Do not add a second scheduler, profile discovery layer, workflow framework, recursive delegation, or persistent registry without an explicit product decision. A future native Pi child API belongs behind the existing execution boundary, not beside a competing runner.

Tool calls may execute in parallel. Admission must happen before asynchronous setup or extension callbacks. Keep the active slot until process-tree cleanup finishes, not merely until terminal assistant output arrives. Multi-child waits use one deadline, wake on any selected completion, and acknowledge only returned terminal reports; detach every listener on completion, expiry, or cancellation. Session shutdown fences notifications before aborting and joining children; no completion may enter a replacement session.

Default tools are known coding/research tools active in the parent; explicit tools may select active or callable parent tools (`ctx.tools`), never arbitrary registered tools. Structured tool results and renderer details share one bounded envelope; child reports remain text. Tool lists, effect metadata, and subprocesses are not sandboxes: a child with shell access can produce effects outside the managed process group. Concurrent writers, including parent-versus-child writers, need separate worktrees; admission counts slots and does not arbitrate write ownership. Child Pi reloads its own integrations; runtime-only parent tools, credentials, providers, and permission hooks are not cloned.

Preserve bounded output/protocol framing, truthful truncation metadata, meaningful failure states (including `incomplete`), deadlines, and process-tree cleanup. Process timeout/cancellation outranks assistant outcomes. SDK children must not inherit the SDK's trusted-by-default project setting: reuse the selected Pi installation's canonical resolver, currently a pinned internal dependency in `child-bootstrap.mjs`, and test saved/default/global-hook trust policy. A completed join owns the result it delivers, even if completion preceded the call. Results stay retractable until an active-turn boundary. Never wake idle parents: Pi cannot expose late idle aborts reliably. Never evict unread reports or restart an aborted/error parent just to announce completion. Only `SessionChildren` may publish lifecycle state; the supervisor returns an outcome. Changes to removed v0 APIs must update the migration section and agent-facing skill together; do not add silent aliases.

Process-tree guarantees are POSIX-first. Windows has no equivalent of the detached pipe watchdog without a native job object, so only graceful shutdown, the leader process, and a best-effort `taskkill /T` sweep are guaranteed there; keep the documentation and the skipped regression test honest about that.

Development dependencies target Pi 1.1.0; the supported API floor remains Pi 1.0.4; the full subprocess/lifecycle suite is the compatibility gate. Keep host-provided peer ranges at `*` per Pi's package contract. The bootstrap's canonical trust resolver and CLI built-in registry are pinned internal dependencies; verify the selected installation and packed artifact when updating Pi. New Pi/pico documentation is design evidence until the corresponding API exists and is verified; do not claim compatibility based on proposed interfaces.
