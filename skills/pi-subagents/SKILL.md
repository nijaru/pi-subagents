---
name: pi-subagents
description: |
  Delegate work to subagents with single-agent, chain, and parallel workflows.
  Use for review, implementation handoffs, research, and multi-step tasks.
---

# Pi Subagents

Delegate tasks to specialized subagents with isolated context.

## When to Use

- **Code review**: fresh-context reviewer for adversarial review
- **Implementation**: explore → architect → worker chain
- **Research**: parallel exploration of multiple topics
- **Multi-step workflows**: chain with `{previous}` handoff
- **Acceptance testing**: agent runs, verify commands check output

## Tool Modes

| Mode | Parameters | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task (blocks until done) |
| Single + model | `{ agent, task, model }` | Override agent's default model |
| Single + bg | `{ agent, task, background: true }` | Non-blocking, returns run ID |
| Single + fork | `{ agent, task, context: "fork" }` | Child inherits parent's session history |
| Single + acceptance | `{ agent, task, acceptance: {...} }` | Verify output with shell commands, retry on failure |
| Chain | `{ chain: [...] }` | Sequential with `{previous}`, `{task}`, `{outputs.name}` placeholders |
| Parallel | `{ tasks: [...] }` | Concurrent execution (max 8, 4 concurrent) |

## Lifecycle Actions

| Action | Parameters | Description |
|--------|-----------|-------------|
| list | — | Show available agents with models and tools |
| status | `{ id }` | Show run status, output, cost, duration |
| wait | `{ id }` | Block until background run completes |
| resume | `{ id, task }` | Send follow-up message to completed/failed run |
| interrupt | `{ id }` | Cancel a running background agent (SIGTERM) |
| create | `{ agent, task, prompt }` | Create a new agent definition |
| update | `{ agent, ... }` | Update agent fields (task, model, taskType, prompt) |
| delete | `{ agent }` | Delete an agent definition |

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
model: openrouter/deepseek/deepseek-v4-flash
task-type: code
tools: read, grep, find, ls, bash
---

System prompt for the agent.
```

### Supported Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| name | yes | Unique identifier |
| description | yes | What this agent does |
| model | no | Default model (overrides task-type routing) |
| task-type | no | Routes to model tier: simple, search, explore, code, implement, debug, reasoning, review, architecture |
| tools | no | Comma-separated list of allowed tools |

### Task-Type Model Routing

When no explicit `model` is set, agents are routed by `task-type`:

| Task Type | Model Tier | Use For |
|-----------|-----------|---------|
| simple, search, explore | deepseek-v4-flash | Fast, cheap tasks |
| code, implement, debug | mimo-v2.5-pro | Default code work |
| reasoning | deepseek-v4-pro | Complex analysis |
| review, architecture | kimi-k27-code | High-quality review |

**Locations:**
- `~/.pi/agents/*.md` — User-level (always loaded)
- `agents/*.md` — Project-level (overrides user)
- `.pi/agents/*.md` — Project-level (alternative location)

## Included Agents

| Agent | Purpose | Default Model |
|-------|---------|--------------|
| architect | Design systems, produce implementation plans | kimi-k27-code |
| explore | Codebase reconnaissance | deepseek-v4-flash |
| profiler | Performance analysis | mimo-v2.5-pro |
| researcher | External docs, web, library lookup | mimo-v2.5-pro |
| reviewer | Code review, build, test | kimi-k27-code |
| security-auditor | Security review, trust boundaries | kimi-k27-code |
| worker | General-purpose (default) | *(inherits parent)* |

## Usage Examples

### Single agent
```
Use explore to find all authentication code
```

### Chain with named outputs
```
subagent(chain=[
  { agent: "explore", task: "Find auth code", as: "auth" },
  { agent: "reviewer", task: "Review {outputs.auth} for issues" }
])
```

### Chain with quality gates
```
subagent(chain=[
  { agent: "worker", task: "Add tests", gate: "npm test", onFail: "retry" },
  { agent: "reviewer", task: "Review {previous}" }
])
```

### Parallel exploration
```
Run 2 researchers in parallel: one for OAuth docs, one for session management
```

### Background with lifecycle
```
subagent(agent="worker", task="Refactor auth module", background=true)
subagent(action="status", id="<run-id>")
subagent(action="wait", id="<run-id>")
subagent(action="interrupt", id="<run-id>")  # cancel if needed
subagent(action="resume", id="<run-id>", task="Now add tests")
```

### Context fork (inherit parent session)
```
subagent(agent="reviewer", task="Review what we just discussed", context="fork")
```

### Acceptance contract
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

### Agent management
```
subagent(action="create", agent="linter", task="Run and fix linting issues", prompt="You are a code linter. Fix all lint issues.", taskType="code")
subagent(action="update", agent="worker", model="openrouter/deepseek/deepseek-v4-pro")
subagent(action="delete", agent="old-agent")
```

## Key Patterns

- **Context isolation**: each agent gets fresh context by default (use `context: "fork"` to inherit)
- **{previous}**: chain steps receive prior step output (empty on first step)
- **{task}**: chain steps can reference the original request
- **{outputs.name}**: chain steps can reference named outputs from earlier steps (set `as` on steps)
- **Quality gates**: shell commands between chain steps, `$SUBAGENT_OUTPUT` has step output
- **Acceptance contracts**: verify agent output with shell commands, auto-retry on failure
- **Task-type routing**: agents without explicit model get routed to cost-appropriate tier
- **Bounded depth**: max 3 levels of nesting
- **Run persistence**: background runs persist to `~/.pi/agent/subagent-runs.json`, reconciled on startup

## Best Practices

- Prefer specific tasks: `Review auth.ts for null-check gaps` > `Review everything`
- Use chains for multi-step workflows
- Use parallel for independent exploration
- Use `as` on chain steps when later steps need specific earlier output
- Use acceptance contracts for verifiable tasks (tests pass, lint clean)
- Use `context: "fork"` when the agent needs to see the conversation so far
- Keep writes single-threaded unless using parallel reads
