# pi-subagents

Clean declarative agent delegation. Define agents, chain them, run them.

## Why

The existing pi-subagents (nicobailon, 2.1K stars) has the right ideas but wrong execution: 200+ files, 66 open issues, overlapping concerns. We want the same patterns in ~900 lines.

## Agent Definitions

Markdown files with YAML frontmatter. Place in `agents/` (project) or `~/.pi/agents/` (global). Project-level agents are discovered by walking up from cwd, stopping at the first directory containing `.git`, `package.json`, `Cargo.toml`, or `go.mod`.

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
| `execution` | no | `inline` (default) or `subprocess`. Inline uses in-process execution with `createAgentSession()`, shared memory, EventBus access. Subprocess for crash isolation. |
| `tools` | no | Comma-separated tool list. Omit to inherit all tools |

### Task-Type Model Routing

When no explicit `model` is set, agents are routed by `task-type`:

| Task Type | Model Tier | Use For |
|-----------|-----------|---------|
| `simple`, `search`, `explore` | deepseek-v4-flash | Fast, cheap tasks |
| `code`, `implement`, `debug` | mimo-v2.5-pro | Default code work |
| `reasoning` | deepseek-v4-pro | Complex analysis |
| `review`, `architecture` | kimi-k27-code | High-quality review |

If no model or task-type is set, the agent inherits the parent's model. The parent can override at spawn time.

## Execution Modes

Two modes. Inline is default.

| Mode | API | Memory | Isolation | Intercom |
|------|-----|--------|-----------|----------|
| **inline** (default) | `createAgentSession()` + `SessionManager.inMemory()` | Shared parent process | None | EventBus (same process) |
| **subprocess** | `spawn("pi", args)` | 230MB per agent | Full | Cross-process (pid addressing) |

### Inline (default)

Uses SDK's `createAgentSession()` API. Agent runs in the same process as the parent, sharing memory and EventBus.

**Benefits:**
- No 230MB overhead per agent
- EventBus access for intercom messaging
- Real-time event subscription via `session.subscribe()`
- Ephemeral sessions via `SessionManager.inMemory()` (no disk writes)

**Tradeoff:** No crash isolation. A crashing agent takes down the parent. But pi's tool execution already runs in child processes (bash), so this is acceptable.

### Subprocess

Spawns a new `pi` CLI process. Full isolation, 230MB per agent.

**Use cases:**
- Crash isolation for untrusted agents
- Running agents with different pi versions
- Agents that need their own extensions

Set via `execution: "subprocess"` in agent frontmatter or `execution` param in tool call.

## Execution Patterns

### Single Agent

```
subagent(agent="reviewer", task="Review src/auth.ts")
```

### Chain (Sequential)

```
subagent(chain=[
  { agent: "explore", task: "Map the auth flow in src/", as: "auth" },
  { agent: "architect", task: "Design a fix based on: {previous}" },
  { agent: "worker", task: "Implement: {previous}", gate: "npm test", onFail: "retry" }
])
```

Template variables in chain steps:
- `{previous}` — prior step's output (empty on first step)
- `{task}` — the original request from the parent
- `{outputs.name}` — named output from a step with `as` field

### Parallel

```
subagent(tasks=[
  { agent: "researcher", task: "Find all auth-related files" },
  { agent: "reviewer", task: "Review src/auth.ts for security issues" }
])
```

Results collected in order. If any fails, the parallel call fails.

## Context Modes

| Mode | Behavior |
|------|----------|
| `fresh` (default) | Child gets only the task text. Clean slate. |
| `fork` | Child inherits parent's session history via pi's `--fork` flag. |

```
subagent(agent="reviewer", task="Review what we discussed", context="fork")
```

## Quality Gates

Shell commands between chain steps. The step's output is available in `$SUBAGENT_OUTPUT`.

```
gate: "echo \"$SUBAGENT_OUTPUT\" | grep -q 'success'"
```

Gate options:
- `gate` — shell command, exit 0 = pass
- `gateTimeout` — timeout in ms (default 30000)
- `onFail` — `abort` (default), `retry` (up to 3 times), `skip`

## Acceptance Contracts

Verify agent output with shell commands. Auto-retries on failure.

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

- `criteria` — informational, reported in output
- `verify` — shell commands, all must exit 0
- `maxAttempts` — retry count (default 1, no retries)

## Background Execution

Non-blocking execution with persistence.

```
subagent(agent="worker", task="Refactor auth module", background=true)
```

Lifecycle management:

```
subagent(action="status", id="<run-id>")       # check status
subagent(action="wait", id="<run-id>")          # block until done
subagent(action="resume", id="<run-id>", task="Now add tests")  # follow-up
subagent(action="interrupt", id="<run-id>")     # cancel running agent (SIGTERM)
```

Run metadata persists to `~/.pi/agent/subagent-runs.json`. On startup, stale runs are reconciled.

## Agent Management

Create, update, and delete agent definitions at runtime:

```
subagent(action="create", agent="linter", task="Fix linting issues", prompt="You are a code linter.", taskType="code")
subagent(action="update", agent="worker", model="openrouter/deepseek/deepseek-v4-pro")
subagent(action="delete", agent="old-agent")
```

## Bounded Depth

Subagents can spawn subagents, up to 3 levels deep. Controlled via `PI_SUBAGENT_DEPTH` environment variable.

## Session Files

Each subagent runs in its own pi session. Session files are in `/tmp/pi-subagent-*/`. The extension reads output from session JSONL files as a fallback if stdout parsing misses.

## Included Agents

| Agent | Purpose | Default Model |
|-------|---------|---------------|
| architect | Design systems, produce plans | kimi-k27-code |
| explore | Codebase reconnaissance | deepseek-v4-flash |
| profiler | Performance analysis | mimo-v2.5-pro |
| researcher | External docs, web, library lookup | mimo-v2.5-pro |
| reviewer | Code review, build, test | kimi-k27-code |
| security-auditor | Security review, trust boundaries | kimi-k27-code |
| worker | General-purpose (default) | inherits parent |

## What This Doesn't Do

- **No VM sandbox** — agents use pi's existing tool execution
- **No workflow orchestration** — that's pi-workflows
- **No optimization loops** — that's pi-goal
- **No custom code execution** — agents use pi's built-in tools only

## Differences from Existing pi-subagents

| Aspect | Existing | This |
|--------|----------|------|
| File count | 200+ | ~900 lines |
| Open issues | 66 | 0 (clean slate) |
| Agent definitions | Code (TypeScript) | Markdown (YAML frontmatter) |
| Bounded depth | Yes | Yes (configurable) |
| Quality gates | Yes (hooks) | Yes (shell commands) |
| Context isolation | Optional | Default (fresh, fork on demand) |
| Task-type routing | No | Yes (model tier mapping) |
| Acceptance contracts | No | Yes (verify + retry) |
| Named outputs | No | Yes (`as` + `{outputs.name}`) |
| Agent management | No | Yes (create/update/delete) |
| Builtin agents | 8 hardcoded | User-defined in agents/ |
| Dependencies | Many | Zero (uses pi's built-ins) |
