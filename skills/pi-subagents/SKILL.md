---
name: pi-subagents
description: |
  Delegate work to subagents with single-agent, chain, and parallel workflows.
  Use for review, implementation handoffs, research, and multi-step tasks.
---

# Pi Subagents

Delegate tasks to specialized subagents with isolated context.

## When to Use

Concrete triggers — delegate when any of these apply:

- **New feature touching 3+ files** → architect designs, worker implements, reviewer reviews
- **Auth/security/crypto/input-validation change** → security-auditor reviews before commit
- **Bug you can't reproduce in 2 attempts** → explore gets fresh eyes
- **Large refactor** → explore maps impact, worker executes, reviewer validates
- **PR-ready code** → reviewer does adversarial review
- **Performance issue with measurable target** → profiler profiles and recommends
- **Need external docs/API patterns/examples** → researcher searches and synthesizes
- **Unknown codebase or scope** → explore maps structure

## When NOT to Delegate

- Reading specific files with known paths — read directly
- Small changes (< 3 files, clear scope) — handle in main session
- Quick targeted fixes — no delegation overhead
- Iterative refinement — main session needs ongoing context

## Agent Discovery

Agents are loaded in priority order (highest wins):

1. **Bundled** — ships with the extension (`agents/*.md` in the extension directory)
2. **User-level** — `~/.pi/agents/*.md` (always loaded, overrides bundled)
3. **Project-level** — `.pi/agents/*.md` or `agents/*.md` walking up from cwd (overrides user)

To customize agents: place `.md` files in `~/.pi/agents/` (global) or `.pi/agents/` (project). Same name overrides the bundled definition.

To override models for bundled agents: use `settings.json` `subagents.agentOverrides` — don't modify the bundled `.md` files.

## Included Agents

| Agent | Use when | Default model |
|-------|----------|---------------|
| architect | Designing a feature before implementation, need a plan | *(inherits parent)* |
| explore | Scope unknown, need to map codebase structure | *(inherits parent)* |
| profiler | Have a measurable perf target, need evidence-based optimization | *(inherits parent)* |
| researcher | Need external docs, API patterns, library examples | *(inherits parent)* |
| reviewer | Finished code needs adversarial review before merge | *(inherits parent)* |
| security-auditor | Touching auth, crypto, input validation, trust boundaries | *(inherits parent)* |
| worker | No specialist needed, general implementation | *(inherits parent)* |

All agents inherit the parent session's model by default. Override per-agent via `~/.pi/agents/<name>.md` frontmatter or `settings.json` `subagents.agentOverrides`.

## Tool Modes

| Mode | Parameters | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task (blocks until done) |
| Single + model | `{ agent, task, model }` | Override agent's default model |
| Single + bg | `{ agent, task, background: true }` | Non-blocking, returns run ID |
| Single + fork | `{ agent, task, context: "fork" }` | Child inherits parent's session history |
| Single + execution | `{ agent, task, execution: "subprocess" }` | Override execution mode |
| Single + acceptance | `{ agent, task, acceptance: {...} }` | Verify output with shell commands, retry on failure |
| Chain | `{ chain: [...] }` | Sequential with `{previous}`, `{task}`, `{outputs.name}` placeholders |
| Parallel | `{ tasks: [...] }` | Concurrent execution (max 8) |
| Parallel + concurrency | `{ tasks: [...], concurrency: N }` | Limit concurrent agents (default 4) |

### Execution Modes

- **inline** (default): in-process, shared memory, faster. Use when agent doesn't need crash isolation.
- **subprocess**: isolated, crash-safe, ~230MB per agent. Use for background runs or untrusted code.
- **context: "fork"**: agent inherits parent's conversation history. Use when agent needs prior context (e.g., "review what we just discussed").

### Background vs Blocking

- **blocking** (default): parent waits for result. Use for short tasks or when result is needed immediately.
- **background**: returns run ID immediately. Use for long-running tasks (refactors, large reviews). Check with `action: "status"`, wait with `action: "wait"`.

## Lifecycle Actions

| Action | Parameters | Description |
|--------|-----------|-------------|
| list | — | Show available agents with models and tools |
| status | `{ id }` | Show run status, output, cost, duration |
| wait | `{ id }` | Block until background run completes |
| resume | `{ id, task }` | Send follow-up message to completed/failed run |
| interrupt | `{ id }` | Cancel a running background agent (SIGTERM) |
| create | `{ agent, task, prompt }` | Create a new agent definition |
| update | `{ agent, ... }` | Update agent fields (task, model, prompt) |
| delete | `{ agent }` | Delete an agent definition |

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
model: openrouter/anthropic/fable-5
execution: inline
tools: read, grep, find, ls, bash
---

System prompt for the agent.
```

### Supported Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| name | yes | Unique identifier |
| description | yes | What this agent does |
| model | no | Model for this agent (inherits parent if omitted) |
| execution | no | `inline` (default) or `subprocess`. Inline uses in-process execution, shared memory. Subprocess for crash isolation. |
| tools | no | Comma-separated list of allowed tools |



**Locations:**
- `~/.pi/agents/*.md` — User-level (always loaded)
- `agents/*.md` — Project-level (overrides user)
- `.pi/agents/*.md` — Project-level (alternative location)

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
subagent(action="create", agent="linter", task="Run and fix linting issues", prompt="You are a code linter. Fix all lint issues.", model="openrouter/anthropic/fable-5")
subagent(action="update", agent="worker", model="openrouter/anthropic/fable-5")
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
