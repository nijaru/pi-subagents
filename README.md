# pi-subagents

Agent delegation for pi. Define agents as markdown files, then delegate work to them — individually, in sequence with quality gates, or in parallel.

Use for tasks that benefit from specialization — code review, design, research, and implementation handled by separate agents with their own models and system prompts.

## Installation

```bash
pi install git:github.com/nijaru/pi-subagents
```

## Execution Patterns

The extension registers a `subagent` tool with four modes:

**Single** — one agent, one task, blocks until done.

**Chain** — sequential steps with quality gates between them. Each step gets the previous step's output. Gates are shell commands that must exit 0 to proceed.

**Parallel** — up to 8 agents concurrently. Useful for research, review, and profiling in one shot.

**Background** — non-blocking. Returns a run ID. Check status or wait for the result later.

## Agent Definitions

Agents are markdown files with YAML frontmatter. Place in `agents/` (project) or `~/.pi/agents/` (global).

```markdown
---
name: reviewer
description: Code reviewer
model: openrouter/anthropic/fable-5
tools: read, write, edit, bash
---

Review code for correctness, safety, and style.
```

## Included Agents

| Agent | Does |
|-------|------|
| architect | Design systems, implementation plans |
| explore | Codebase reconnaissance |
| profiler | Performance analysis |
| researcher | External docs, web, library lookup |
| reviewer | Code review, build, test |
| security-auditor | Security review, trust boundaries |
| worker | General-purpose (default) |

## License

MIT
