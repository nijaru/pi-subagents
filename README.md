# pi-subagents

Agent delegation for pi. Define agents as markdown files, spawn them individually, in chains with quality gates, or in parallel. In-process by default — no 230MB subprocess overhead per agent.

## Installation

```bash
pi install git:github.com/nijaru/pi-subagents
```

## Usage

### Single

```
subagent(agent="worker", task="Fix the failing test in src/auth.ts")
```

### Chain

Sequential with quality gates. `{previous}` is the prior step's output, `{task}` is the original request.

```
subagent(chain=[
  { agent: "explore", task: "Map the auth flow in src/", as: "auth" },
  { agent: "architect", task: "Design a fix based on: {previous}" },
  { agent: "worker", task: "Implement: {previous}", gate: "npm test", onFail: "retry" }
])
```

Gate options: `gate` (shell cmd, exit 0 = pass), `gateTimeout` (ms), `onFail` (`abort`, `retry`, `skip`).

### Parallel

```
subagent(tasks=[
  { agent: "researcher", task: "Find all auth-related files" },
  { agent: "reviewer", task: "Review src/auth.ts for security issues" }
])
```

### Background

```
subagent(agent="worker", task="Refactor the auth module", background=true)
subagent(action="wait", id="<run-id>")
```

### Context

Inherit parent session history with `context: "fork"`. Default is `fresh` (agent gets only the task).

```
subagent(agent="reviewer", task="Review what we just discussed", context="fork")
```

## Agent Definitions

Markdown files with YAML frontmatter. Place in `agents/` (project) or `~/.pi/agents/` (global).

```markdown
---
name: reviewer
description: Code reviewer
model: parasail/parasail-kimi-k27-code
task-type: review
tools: read, write, edit, bash
---

Review code for correctness, safety, and style.
```

Fields: `name`, `description` (required). `model`, `task-type`, `execution`, `tools` (optional).

Task-type routes to model tiers automatically: `simple`/`search`/`explore` → flash, `code`/`implement`/`debug` → default, `reasoning` → pro, `review`/`architecture` → kimi.

## Included Agents

| Agent | Purpose |
|-------|---------|
| architect | Design systems, implementation plans |
| explore | Codebase reconnaissance |
| profiler | Performance analysis |
| researcher | External docs, web, library lookup |
| reviewer | Code review, build, test |
| security-auditor | Security review, trust boundaries |
| worker | General-purpose (default) |

## License

MIT
