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

Supported frontmatter fields:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Agent identifier used in `agent` param |
| `description` | yes | Shown in `action=list` output |
| `model` | no | Default model for this agent (parent can override) |
| `tools` | no | Comma-separated tool list. Omit to inherit all tools |

All other frontmatter fields are ignored.

### Included Agents

| Agent | Purpose | Default Model |
|-------|---------|---------------|
| architect | Design systems, produce implementation plans | kimi-k27-code |
| explore | Codebase reconnaissance | deepseek-v4-flash |
| profiler | Performance analysis | mimo-v2.5-pro |
| researcher | External docs, web, library lookup | mimo-v2.5-pro |
| reviewer | Code review, build, test | kimi-k27-code |
| security-auditor | Security review, trust boundaries | kimi-k27-code |
| worker | General-purpose (default) | inherits parent |

## Bounded Depth

Subagents can spawn subagents, up to 3 levels deep. Controlled via `PI_SUBAGENT_DEPTH` environment variable.

## License

MIT
