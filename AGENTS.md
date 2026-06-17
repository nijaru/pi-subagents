# pi-subagents

Pi extension for declarative agent delegation. Single file, 7 built-in agents.

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

## Agent Definitions

Markdown + YAML frontmatter in `agents/` (project) or `~/.pi/agents/` (global). Required: `name`, `description`. Optional: `model`, `execution`, `tools`.

```markdown
---
name: reviewer
description: Code review for correctness and quality
model: parasail/parasail-kimi-k27-code
execution: inline
tools: read,write,edit,bash,grep,find,ls
---
```

## Key Patterns

- Two execution paths: `runAgentInLine` (inline, default) and subprocess. Know which you're modifying.
- `session.prompt()` returns `Promise<void>`. Output is in `session.messages` after await.
- Model resolution: `resolveModel` → `findModel` → `ctx.modelRegistry.find(provider, modelId)`.
- Agent discovery walks up from cwd, stops at first project root (`.git`, `package.json`, `Cargo.toml`, `go.mod`).
- Background always uses subprocess. `contextOpts` is subprocess-only (inline shares parent memory).
