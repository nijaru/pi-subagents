# pi-subagents

Clean declarative agent delegation for pi. Define agents, chain them, run them.

## Design

See DESIGN.md for the full API design and implementation notes.

## Architecture

- Single extension, ~200-300 lines
- Entry: `extensions/pi-subagents/index.ts`
- Agent defs: `.pi/agents/*.md` (YAML frontmatter)
- Three patterns: spawn(), chain(), parallel()
- Context isolation by default (fresh)
- Quality gates between steps
- Bounded depth (default 3)

## Stack

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`)
- Pi TUI (`@earendil-works/pi-tui`)
- Pi AI types (`@earendil-works/pi-ai`)

## Testing

```bash
bun test
```

## Key Patterns

- Markdown agent definitions (YAML frontmatter)
- Fresh context by default, fork on demand
- Quality gates: async functions between steps
- Bounded depth: configurable max nesting
- Intercom: pi's existing messaging
