# pi-subagents

Agent delegation for pi. Define agents as markdown files, then delegate work to them — individually, in sequence with quality gates, or in parallel.

## Installation

```bash
pi install git:github.com/nijaru/pi-subagents
```

## Included Agents

Seven agents, ready to use:

| Agent | Does |
|-------|------|
| architect | Design systems, implementation plans |
| explore | Codebase reconnaissance |
| profiler | Performance analysis |
| researcher | External docs, web, library lookup |
| reviewer | Code review, build, test |
| security-auditor | Security review, trust boundaries |
| worker | General-purpose (default) |

Each agent is a markdown file with a system prompt. Add your own in `agents/` (project) or `~/.pi/agents/` (global).

## License

MIT
