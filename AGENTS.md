# pi-subagents

Pi extension for declarative agent delegation. Single file (~800 lines), 7 built-in agents.

## Stack

TypeScript, Bun. Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`), Typebox.

## Testing

```bash
bun test
```

No build step — pi loads the extension directly.

## Key Files

```
extensions/pi-subagents/index.ts   # everything
agents/*.md                        # agent definitions (YAML frontmatter)
skills/pi-subagents/SKILL.md       # agent-facing tool reference
tests/agents.test.ts               # unit tests
```

## Key Patterns

- **Inline default**: `runAgentSync` routes to `runAgentInLine` unless `execution: "subprocess"`. Two execution paths — know which one you're modifying.
- **Output extraction**: `session.prompt()` returns `Promise<void>`. Output is in `session.messages` after await — last assistant message's `TextContent` blocks.
- **Model resolution**: `resolveModel` (string) → `findModel` (registry lookup) → `ctx.modelRegistry.find(provider, modelId)`.
- **Agent discovery**: walks up from cwd, stops at first project root (`.git`, `package.json`, `Cargo.toml`, `go.mod`).
- **Background is always subprocess**: can't poll an in-process session from the tool handler.
- **contextOpts is subprocess-only**: inline agents share parent memory, fork mode doesn't apply.

## Agent Definitions

Markdown + YAML frontmatter in `agents/` (project) or `~/.pi/agents/` (global). Required: `name`, `description`. Optional: `model`, `task-type`, `execution`, `tools`.
