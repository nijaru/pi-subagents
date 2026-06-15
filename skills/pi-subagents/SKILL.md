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

## Tool Modes

| Mode | Parameters | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task (blocks until done) |
| Single + model | `{ agent, task, model }` | Override agent's default model |
| Single + bg | `{ agent, task, background: true }` | Non-blocking, returns run ID |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder and optional quality gates |
| Parallel | `{ tasks: [...] }` | Concurrent execution (max 8, 4 concurrent) |

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls, bash
---

System prompt for the agent.
```

**Locations:**
- `~/.pi/agents/*.md` — User-level (always loaded)
- `agents/*.md` — Project-level (overrides user)
- `.pi/agents/*.md` — Project-level (alternative location)

## Included Agents

| Agent | Purpose |
|-------|---------|
| architect | Design systems, produce implementation plans |
| explore | Codebase reconnaissance |
| profiler | Performance analysis |
| researcher | External docs, web, library lookup |
| reviewer | Code review, build, test |
| security-auditor | Security review, trust boundaries |
| worker | General-purpose (default) |

## Usage Examples

### Single agent
```
Use explore to find all authentication code
```

### Chain workflow
```
subagent chain: explore finds auth code, architect creates plan, worker implements
```

### Parallel exploration
```
Run 2 researchers in parallel: one for OAuth docs, one for session management
```

### Background
```
subagent(agent="worker", task="Refactor auth module", background=true)
subagent(action="status", id="<run-id>")
subagent(action="wait", id="<run-id>")
subagent(action="resume", id="<run-id>", task="Now add tests")
```

## Key Patterns

- **Context isolation**: each agent gets fresh context by default
- **{previous}**: chain steps receive prior step output (empty string on first step)
- **Quality gates**: shell commands between chain steps, `$SUBAGENT_OUTPUT` has step output
- **Bounded depth**: max 3 levels of nesting
- **Model inheritance**: agent can specify model, parent can override, otherwise inherits parent's model
- **Run persistence**: background runs persist to `~/.pi/agent/subagent-runs.json`, reconciled on startup

## Best Practices

- Prefer specific tasks: `Review auth.ts for null-check gaps` > `Review everything`
- Use chains for multi-step workflows
- Use parallel for independent exploration
- Keep writes single-threaded unless using parallel reads
