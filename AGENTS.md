# pi-subagents

Clean declarative agent delegation for pi. Define agents, chain them, run them.

## Architecture

- Single extension, ~800 lines
- Entry: `extensions/pi-subagents/index.ts`
- Agent defs: `agents/*.md` (YAML frontmatter)
- Three patterns: single, chain, parallel
- Quality gates between chain steps
- Background execution with persistence
- Bounded depth (default 3)

## Stack

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`)
- Pi TUI (`@earendil-works/pi-tui`)
- Typebox (parameter schemas)

## Testing

```bash
bun test
```

## Key Files

```
extensions/pi-subagents/index.ts   # extension entry point
agents/*.md                        # agent definitions
skills/pi-subagents/SKILL.md       # skill definition
DESIGN.md                          # API design and implementation notes
README.md                          # user-facing docs
```
