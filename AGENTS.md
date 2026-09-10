# pi-subagents

Pi extension for task-first delegation to fresh child subprocesses. One tool exposes `run`, `spawn`, `status`, `wait`, and `stop`.

## Stack and checks

TypeScript, Bun, Pi extension/TUI APIs, TypeBox. Pi loads the extension directly; no build step.

```bash
bun run check
```

Merge only a coherent, independently usable slice. Keep dependent scaffolding on feature branches. Before merging, run the checks and inspect the complete diff.

## Ownership and contracts

- `extensions/pi-subagents/index.ts`: registration, parent session lifecycle, completion notices, command dispatch, rendering.
- `children.ts`: session-owned handles, synchronous admission, wait/stop, retention, shutdown fencing.
- `supervisor.ts`: the single child execution boundary used by both run and spawn; prompt files, progress, terminal result validation, cleanup.
- `subprocess.ts`: Pi invocation, bounded JSON framing, process-tree cancellation and normal-exit sweep.
- `params.ts`: command/tool policy and working-directory resolution.
- `env.ts`, `bounds.ts`, `limits.ts`, `types.ts`, `render.ts`: environment policy, output/resource bounds, result contracts, rendering helpers.
- `tests/`: deterministic lifecycle tests plus real subprocess protocol regression tests.

Children are leaves. Do not add a second scheduler, profile discovery layer, workflow framework, recursive delegation, or persistent registry without an explicit product decision. A future native Pi child API belongs behind the existing execution boundary, not beside a competing runner.

Admission must happen before asynchronous setup or extension callbacks. Keep the active slot until process-tree cleanup finishes, not merely until terminal assistant output arrives. Session shutdown fences notifications before aborting and joining children; no completion may enter a replacement session.

Default tools are known coding/research tools active in the parent; explicit tools can only select active parent tools. Tool lists, effect metadata, and subprocesses are not sandboxes: a child with shell access can produce effects outside the managed process group. Concurrent writers, including parent-versus-child writers, need separate worktrees; admission counts slots and does not arbitrate write ownership. Child Pi reloads its own integrations; runtime-only parent tools, credentials, providers, and permission hooks are not cloned.

Preserve private prompt-file transport, bounded output/protocol framing, meaningful failure states, deadlines, and process-tree cleanup. Changes to removed v0 APIs must update the migration section and agent-facing skill together; do not add silent aliases.

Development dependencies target Pi 0.84.3. New Pi/pico documentation is design evidence until the corresponding API exists and is verified; do not claim compatibility based on proposed interfaces.
