# pi-subagents

Clean declarative agent delegation. Define agents, chain them, run them.

## Why

The existing pi-subagents (nicobailon, 2.1K stars) has the right ideas but wrong execution: 200+ files, 66 open issues, overlapping concerns. We want the same patterns in ~800 lines.

## Agent Definitions

Markdown files with YAML frontmatter. Place in `agents/` (project) or `~/.pi/agents/` (global). Project-level agents are discovered by walking up from cwd, stopping at the first directory containing `.git`, `package.json`, `Cargo.toml`, or `go.mod`.

```markdown
---
name: reviewer
description: Code reviewer — validates correctness, safety, and quality
tools: read, write, edit, bash, grep, find, ls
---

Review code for correctness, safety, and style. Report findings with file:line references.
```

Required: `name`, `description`. Optional: `tools` (comma-separated), `model` (actual model name).

If no model is specified, the agent inherits the parent's model. The parent can override at spawn time.

### Supported frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Agent identifier used in `agent` param |
| `description` | yes | Shown in `action=list` output |
| `model` | no | Default model for this agent (parent can override) |
| `tools` | no | Comma-separated tool list. Omit to inherit all tools |

All other fields in the frontmatter are ignored by the extension.

## Execution Patterns

### Single Agent

```
subagent(agent="reviewer", task="Review src/auth.ts")
```

### Chain (Sequential)

```
subagent(chain=[
  { agent: "explore", task: "Map the auth flow in src/" },
  { agent: "architect", task: "Design a fix based on: {previous}" },
  { agent: "worker", task: "Implement: {previous}", gate: "echo \"$SUBAGENT_OUTPUT\" | grep -q 'TODO'", onFail: "retry" }
])
```

Each step gets the previous step's output as `{previous}`. The chain stops if any step fails.

### Parallel

```
subagent(tasks=[
  { agent: "researcher", task: "Find all auth-related files" },
  { agent: "reviewer", task: "Review src/auth.ts for security issues" }
])
```

Results collected in order. If any fails, the parallel call fails.

## Quality Gates

Shell commands between chain steps. The step's output is available in `$SUBAGENT_OUTPUT`.

```
gate: "echo \"$SUBAGENT_OUTPUT\" | grep -q 'success'"
```

Gate options:
- `gate` — shell command, exit 0 = pass
- `gateTimeout` — timeout in ms (default 30000)
- `onFail` — `abort` (default), `retry` (up to 3 times), `skip`

## Background Execution

Non-blocking execution with persistence.

```
subagent(agent="worker", task="Refactor auth module", background=true)
```

Returns a run ID. Check status or wait:

```
subagent(action="status", id="<run-id>")
subagent(action="wait", id="<run-id>")
```

Resume a completed run:

```
subagent(action="resume", id="<run-id>", task="Now add tests")
```

Run metadata persists to `~/.pi/agent/subagent-runs.json`. On startup, stale runs are reconciled.

## Bounded Depth

Subagents can spawn subagents, up to 3 levels deep. Controlled via `PI_SUBAGENT_DEPTH` environment variable.

## Session Files

Each subagent runs in its own pi session. Session files are in `/tmp/pi-subagent-*/`. The extension reads output from session JSONL files as a fallback if stdout parsing misses.

## Included Agents

| Agent | Purpose | Context |
|-------|---------|---------|
| architect | Design systems, produce plans | fork |
| explore | Codebase reconnaissance | fresh |
| profiler | Performance analysis | fork |
| researcher | External docs, web, library lookup | fresh |
| reviewer | Code review, build, test | fresh |
| security-auditor | Security review, trust boundaries | fresh |
| worker | General-purpose (default) | fresh |

## What This Doesn't Do

- **No VM sandbox** — agents use pi's existing tool execution
- **No workflow orchestration** — that's pi-workflows
- **No optimization loops** — that's pi-goal
- **No custom code execution** — agents use pi's built-in tools only

## Differences from Existing pi-subagents

| Aspect | Existing | This |
|--------|----------|------|
| File count | 200+ | ~800 lines |
| Open issues | 66 | 0 (clean slate) |
| Agent definitions | Code (TypeScript) | Markdown (YAML frontmatter) |
| Bounded depth | Yes | Yes (configurable) |
| Quality gates | Yes (hooks) | Yes (shell commands) |
| Context isolation | Optional | Default (fresh by default) |
| Builtin agents | 8 hardcoded | User-defined in agents/ |
| Dependencies | Many | Zero (uses pi's built-ins) |
