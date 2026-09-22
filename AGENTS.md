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
- `children.ts`: session-owned handles, synchronous admission, wait/stop, unread/offered/delivered result state, usage accounting, retention, shutdown fencing.
- `delivery.ts`: active-turn boundary batching; never wake idle parents. Boundary drafts remain provisional until confirmed in the transcript; no busy-parent follow-up queue.
- `supervisor.ts`: the single child execution boundary used by both run and spawn; it fills derived output/usage/diagnostics and returns an execution outcome. No session registry here, and no lifecycle state ownership.
- `child-bootstrap.mjs`, `child-runner.ts`, `child-protocol.ts`: selected-installation SDK loading, canonical noninteractive project trust, model/tool verification, literal prompting, and versioned compact records over fd 3.
- `subprocess.ts`: Node invocation, stdin bootstrap transport, bounded private-pipe framing and stdout/stderr diagnostics, process-tree cancellation and normal-exit sweep, and the parent-death watchdog.
- `params.ts`: command/tool policy and working-directory resolution.
- `env.ts`, `bounds.ts`, `limits.ts`, `types.ts`, `render.ts`: environment policy, output/resource bounds, result contracts, rendering helpers.
- `tests/`: deterministic lifecycle tests plus real subprocess protocol regression tests.

Children are leaves. Do not add a second scheduler, profile discovery layer, workflow framework, recursive delegation, or persistent registry without an explicit product decision. A future native Pi child API belongs behind the existing execution boundary, not beside a competing runner.

Admission must happen before asynchronous setup or extension callbacks. Keep the active slot until process-tree cleanup finishes, not merely until terminal assistant output arrives. Session shutdown fences notifications before aborting and joining children; no completion may enter a replacement session.

Default tools are known coding/research tools active in the parent; explicit tools can only select active parent tools. Tool lists, effect metadata, and subprocesses are not sandboxes: a child with shell access can produce effects outside the managed process group. Concurrent writers, including parent-versus-child writers, need separate worktrees; admission counts slots and does not arbitrate write ownership. Child Pi reloads its own integrations; runtime-only parent tools, credentials, providers, and permission hooks are not cloned.

Preserve bounded output/protocol framing, truthful truncation metadata, meaningful failure states (including `incomplete`), deadlines, and process-tree cleanup. Process timeout/cancellation outranks assistant outcomes. SDK children must not inherit the SDK's trusted-by-default project setting: reuse the selected Pi installation's canonical resolver, currently a pinned internal dependency in `child-bootstrap.mjs`, and test saved/default/global-hook trust policy. A completed join owns the result it delivers, even if completion preceded the call. Results stay retractable until an active-turn boundary. Never wake idle parents: Pi 0.87 cannot expose late aborts reliably. Never evict unread reports or restart an aborted/error parent just to announce completion. Only `SessionChildren` may publish lifecycle state; the supervisor returns an outcome. Changes to removed v0 APIs must update the migration section and agent-facing skill together; do not add silent aliases.

Process-tree guarantees are POSIX-first. Windows has no equivalent of the detached pipe watchdog without a native job object, so only graceful shutdown, the leader process, and a best-effort `taskkill /T` sweep are guaranteed there; keep the documentation and the skipped regression test honest about that.

Development dependencies target Pi 0.87.0 and the full subprocess/lifecycle suite is the compatibility gate. New Pi/pico documentation is design evidence until the corresponding API exists and is verified; do not claim compatibility based on proposed interfaces.
