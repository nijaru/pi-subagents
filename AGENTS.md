# pi-subagents

Pi extension for declarative agent delegation. Single file (~800 lines), 7 built-in agents.

## Stack

TypeScript, Bun. Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`), Typebox.

## Build & Test

```bash
bun test
```

No build step — pi loads the extension directly from `extensions/pi-subagents/index.ts`.

## Key Files

```
extensions/pi-subagents/index.ts   # everything (~800 lines)
agents/*.md                        # agent definitions (YAML frontmatter)
skills/pi-subagents/SKILL.md       # agent-facing tool reference
tests/agents.test.ts               # unit tests (14)
```

## Agent Definitions

Markdown + YAML frontmatter in `agents/` (project) or `~/.pi/agents/` (global). Required: `name`, `description`. Optional: `model`, `task-type`, `execution`, `tools`.

## Conventions

- Inline execution is default. Subprocess only for background or crash isolation.
- Agent discovery stops at project root (`.git`, `package.json`, `Cargo.toml`, `go.mod`).
- Max depth 3, max parallel 8, max output 100KB.
- Background runs persist to `~/.pi/agent/subagent-runs.json`.
- `contextOpts` is subprocess-only (inline shares parent memory).

## Gotchas

- `session.prompt()` returns `Promise<void>` — output is in `session.messages` after await.
- Model resolution: string → split on `/` → `ctx.modelRegistry.find(provider, modelId)`.
- `npmCommand: ["bun"]` is set in `~/.pi/agent/settings.json` to work around npm `min-release-date` issue.
