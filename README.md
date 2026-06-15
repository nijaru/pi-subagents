# pi-subagents

Agent delegation for pi. Define agents as markdown files, then spawn them individually, in chains with quality gates, or in parallel.

## Installation

```bash
pi install git:github.com/nijaru/pi-subagents
```

## Usage

The extension registers a `subagent` tool with three execution modes and lifecycle management.

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

Sequential execution. Each step gets the previous step's output as `{previous}`, the original request as `{task}`, and named outputs as `{outputs.name}`. Quality gates validate between steps.

```
subagent(chain=[
  { agent: "explore", task: "Map the auth flow in src/", as: "auth" },
  { agent: "architect", task: "Design a fix based on: {previous}" },
  { agent: "worker", task: "Implement: {previous}", gate: "npm test", onFail: "retry" }
])
```

Named outputs let later steps reference specific earlier results:

```
subagent(chain=[
  { agent: "explore", task: "Find auth code", as: "auth_files" },
  { agent: "reviewer", task: "Review {outputs.auth_files} for security issues" }
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

Lifecycle management:

```
subagent(action="status", id="<run-id>")      # check status
subagent(action="wait", id="<run-id>")         # block until done
subagent(action="resume", id="<run-id>", task="Now add tests")  # follow-up
subagent(action="interrupt", id="<run-id>")    # cancel running agent
```

### Context Fork

Inherit the parent session's conversation history:

```
subagent(agent="reviewer", task="Review what we just discussed", context="fork")
```

Default is `context: "fresh"` (agent gets only the task text).

### Acceptance Contracts

Verify agent output with shell commands. Auto-retries on failure:

```
subagent(
  agent="worker",
  task="Fix the failing test",
  acceptance={
    criteria: ["All tests pass", "No new warnings"],
    verify: ["npm test", "npm run lint"],
    maxAttempts: 3
  }
)
```

### Agent Management

Create, update, and delete agent definitions at runtime:

```
subagent(action="create", agent="linter", task="Fix linting issues", prompt="You are a code linter.", taskType="code")
subagent(action="update", agent="worker", model="openrouter/deepseek/deepseek-v4-pro")
subagent(action="delete", agent="old-agent")
```

## Agent Definitions

Markdown files with YAML frontmatter. Place in `agents/` (project) or `~/.pi/agents/` (global).

```markdown
---
name: reviewer
description: Code reviewer — validates correctness, safety, and quality
model: parasail/parasail-kimi-k27-code
task-type: review
tools: read, write, edit, bash, grep, find, ls
---

Review code for correctness, safety, and style. Report findings with file:line references.
```

### Supported Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Agent identifier used in `agent` param |
| `description` | yes | Shown in `action=list` output |
| `model` | no | Default model (overrides task-type routing) |
| `task-type` | no | Routes to model tier (see below) |
| `execution` | no | `inline` (default) or `subprocess`. Inline uses in-process execution, shared memory, EventBus access. Subprocess for crash isolation. |
| `tools` | no | Comma-separated tool list. Omit to inherit all tools |

### Task-Type Model Routing

When no explicit `model` is set, agents are routed by `task-type`:

| Task Type | Model Tier | Use For |
|-----------|-----------|---------|
| `simple`, `search`, `explore` | deepseek-v4-flash | Fast, cheap tasks |
| `code`, `implement`, `debug` | mimo-v2.5-pro | Default code work |
| `reasoning` | deepseek-v4-pro | Complex analysis |
| `review`, `architecture` | kimi-k27-code | High-quality review |

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
