# pi-subagents

Agent delegation for pi. Define agents as markdown files, then delegate work to them — individually, in sequence with quality gates, or in parallel.

## Why

You're running multiple pi sessions — one exploring, one coding, one reviewing. Pi-subagents lets you delegate to specialized agents from a single session:

- **Specialist routing** — Code review goes to a reviewer, design work goes to an architect. Each agent has its own model, tools, and system prompt.
- **Sequential pipelines** — Chain agents together with quality gates. The reviewer validates the architect's plan before the worker implements it.
- **Parallel fan-out** — Run up to 4 agents concurrently. Research, review, and profile in one shot.
- **In-process execution** — Agents run in the same process by default. No 230MB subprocess per agent.

## Installation

```bash
pi install git:github.com/nijaru/pi-subagents
```

## What's included

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
