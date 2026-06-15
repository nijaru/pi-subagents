# pi-subagents

Agent delegation for pi. Define agents as markdown files, then spawn them individually, in chains with quality gates, or in parallel.

## Installation

```bash
pi install git:github.com/nijaru/pi-subagents
```

## Usage

The extension registers a `subagent` tool with three execution modes.

### Single

Spawn one agent with a task. Blocks until done.

```
subagent(agent="worker", task="Fix the failing test in src/auth.ts")
```

Override the agent's model:

```
subagent(agent="worker", task="Fix the failing test", model="openrouter/deepseek/deepseek-v4-flash")
```

### Chain

Sequential execution. Each step gets the previous step's output as `{previous}`. Quality gates validate between steps.

```
subagent(chain=[
  { agent: "explore", task: "Map the auth flow in src/" },
  { agent: "architect", task: "Design a fix based on: {previous}" },
  { agent: "worker", task: "Implement: {previous}", gate: "echo \"$SUBAGENT_OUTPUT\" | grep -q 'TODO'", onFail: "retry" }
])
```

Gate options: `gate` (shell command, exit 0 = pass), `gateTimeout` (ms, default 30000), `onFail` (`abort`, `retry`, `skip`).

### Parallel

Concurrent execution, up to 8 tasks.

```
subagent(tasks=[
  { agent: "researcher", task: "Find all auth-related files" },
  { agent: "reviewer", task: "Review src/auth.ts for security issues" }
])
```

### Background

Non-blocking execution. Returns a run ID immediately.

```
subagent(agent="worker", task="Refactor the auth module", background=true)
```

Check status or wait for result:

```
subagent(action="status", id="<run-id>")
subagent(action="wait", id="<run-id>")
```

Resume a completed run with a follow-up:

```
subagent(action="resume", id="<run-id>", task="Now add tests for the changes")
```

## Agent Definitions

Markdown files with YAML frontmatter. Place in `agents/` (project) or `~/.pi/agents/` (global).

```markdown
---
name: reviewer
description: Code reviewer — validates correctness, safety, and quality
tools: read, write, edit, bash, grep, find, ls
---

Review code for correctness, safety, and style. Report findings with file:line references.
```

Required fields: `name`, `description`. Optional: `tools` (comma-separated), `model` (actual model name).

If no model is specified, the agent inherits the parent's model. The parent can override at spawn time with the `model` parameter.

### Included Agents

| Agent | Purpose |
|-------|---------|
| architect | Design systems, produce implementation plans |
| explore | Codebase reconnaissance |
| profiler | Performance analysis |
| researcher | External docs, web, library lookup |
| reviewer | Code review, build, test |
| security-auditor | Security review, trust boundaries |
| worker | General-purpose (default) |

## Bounded Depth

Subagents can spawn subagents, up to 3 levels deep. Controlled via `PI_SUBAGENT_DEPTH` environment variable.

## License

MIT
