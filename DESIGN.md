# pi-subagents

Clean declarative agent delegation. Define agents, chain them, run them.

## Why

The existing pi-subagents (nicobailon, 2.1K stars) has the right ideas but wrong execution: 200+ files, 66 open issues, overlapping concerns. We want the same patterns in ~200 lines.

Pi already has:
- Intercom (messaging between sessions)
- Subagent spawning (pi's built-in)
- Extensions system (hooks, tools, slash commands)

What's missing is a clean way to:
- Define agent roles with model/config defaults
- Chain agents with structured handoffs
- Run parallel agents with result collection
- Gate quality between steps

## Agent Definitions

Markdown files with YAML frontmatter (Claude Code/Gemini/Codex pattern):

```markdown
---
name: reviewer
model: big
context: fresh          # fresh context, don't inherit parent's
description: Reviews code for correctness and style
tools: read, bash       # restrict available tools
---

You are a code reviewer. Look for:
- Correctness issues
- Style violations
- Missing error handling
- Performance problems

Be specific. Cite line numbers. Don't fix, just report.
```

Agents live in `.pi/agents/` (project-local) or `~/.pi/agents/` (global). Git-committable, inspectable, editable.

## Execution Patterns

### Single Agent

```js
const result = await spawn("reviewer", {
  task: "Review src/auth.ts",
  model: "medium",       // override definition default
});
```

### Chain (Sequential)

```js
const result = await chain([
  { agent: "researcher", task: "Find auth patterns in the codebase" },
  { agent: "planner", task: "Design auth implementation based on: {previous}" },
  { agent: "implementer", task: "Implement: {previous}" },
  { agent: "reviewer", task: "Review: {previous}" },
]);
```

Each step gets the previous step's output as `{previous}`. The chain stops if any step fails.

### Parallel

```js
const [frontend, backend] = await parallel([
  { agent: "researcher", task: "Analyze frontend auth flow" },
  { agent: "researcher", task: "Analyze backend auth flow" },
]);
```

Results collected in order. If any fails, the parallel call fails.

### Fan-out/Fan-in

```js
const files = await spawn("researcher", { task: "List all auth-related files" });

const analyses = await parallel(
  files.map(f => ({ agent: "analyzer", task: `Analyze ${f}` }))
);

const synthesis = await spawn("synthesizer", {
  task: `Synthesize findings:\n${analyses.join("\n")}`,
});
```

## Context Isolation

Each agent gets its own context by default (`context: fresh`). This means:
- No parent conversation history
- Clean slate for the task
- Returns a summary, not raw context

This prevents context bloat and keeps each agent focused. The parent decides what context to pass via the `task` parameter.

For cases where context inheritance is useful (continuing a conversation):
```js
const result = await spawn("continuer", {
  task: "Continue the implementation",
  context: "fork",  // inherit parent context
});
```

## Quality Gates

Hooks between steps for validation:

```js
const result = await chain([
  { agent: "implementer", task: "Implement auth" },
  // Gate: check implementation before reviewing
  {
    gate: async (result) => {
      const tests = await bash("npm test");
      return tests.exitCode === 0;
    },
    onFail: "retry",  // or "skip", "abort", "ask"
  },
  { agent: "reviewer", task: "Review implementation" },
]);
```

Gate outcomes:
- `retry` — retry the previous step (with feedback)
- `skip` — skip to next step
- `abort` — stop the chain
- `ask` — ask the user what to do

## Bounded Depth

Default nesting depth of 3. A subagent can spawn subagents, but only 3 levels deep.

```js
// Level 0: parent
// Level 1: spawned by parent
// Level 2: spawned by level 1
// Level 3: max depth — cannot spawn further
```

Configurable via extension config (`maxDepth: 5` for complex workflows).

## Model Routing

Each agent definition specifies a default model tier. Can be overridden at spawn time:

```yaml
# .pi/agents/reviewer.md
---
name: reviewer
model: big        # default: use pro model
task-type: review  # for automatic routing
---
```

```js
// Override at spawn time
await spawn("reviewer", { task: "...", model: "medium" });

// Or use task-type routing
await spawn("reviewer", { task: "...", taskType: "review" });
```

Tiers map to the user's configured models (same as pi-workflows):
- `small` — flash model (exploration, reading)
- `medium` — primary model (default)
- `big` — pro model (architecture, complex reasoning)

### Task-Type Routing

Agent definitions can specify `task-type` in YAML frontmatter. The runtime routes to the appropriate model:

| Task Type | Description | Default Tier |
|-----------|-------------|--------------|
| `simple` | Text generation, summarization | small |
| `code` | Code generation, refactoring | medium |
| `reasoning` | Complex analysis, architecture | big |
| `search` | Codebase exploration | small |
| `review` | Code review, critique | big |
| `implement` | Feature implementation | medium |

If both `model` and `task-type` are specified, `model` takes precedence.

## Intercom Integration

Agents communicate via pi's existing intercom:

```js
// In agent definition, can use intercom
// Agent sends progress updates to parent
intercom.send(parentId, "Found 3 auth issues");

// Parent can query agent status
const status = await intercom.ask(agentId, "What's your progress?");
```

This is pi's existing feature. Subagents just makes it cleaner to use.

## Background Execution

Long-running agents can run in background:

```js
const agentId = await spawn("researcher", {
  task: "Deep analysis of auth patterns",
  background: true,
});

// Do other work...

const result = await wait(agentId);
```

Background agents show in the TUI panel with status, progress, and cost.

## Session Persistence

Each subagent is a separate pi session. Pi's session system handles persistence — the parent can read child session history through pi's session API. The subagents extension doesn't duplicate this.

Workers return structured results as return values:
```js
const result = await spawn("researcher", { task: "Analyze auth patterns" });
// result.output = the agent's output
// result.cost = token cost
// result.duration = wall-clock time
```

Results flow through as return values. If the parent needs to reference a result later, it holds it in context or writes it to a file. No separate storage system needed.

## What This Doesn't Do

- **No VM sandbox** — agents use pi's existing tool execution
- **No workflow orchestration** — that's pi-workflows
- **No optimization loops** — that's pi-goal
- **No custom code execution** — agents use pi's built-in tools only

## Differences from Existing pi-subagents

| Aspect | Existing | This |
|--------|----------|------|
| File count | 200+ | ~200 lines |
| Open issues | 66 | 0 (clean slate) |
| Agent definitions | Code (TypeScript) | Markdown (YAML frontmatter) |
| Bounded depth | Yes | Yes (configurable) |
| Quality gates | Yes (hooks) | Yes (gates between steps) |
| Context isolation | Optional | Default (fresh by default) |
| Intercom | Yes | Yes (pi's existing) |
| Builtin agents | 8 hardcoded | User-defined in .pi/agents/ |
| Dependencies | Many | Zero (uses pi's built-ins) |

## Implementation Notes

- Single extension, ~200-300 lines
- Agent definitions: markdown files with YAML frontmatter
- Chain/parallel/spawn use pi's existing subagent spawning
- Quality gates are async functions evaluated between steps
- Model routing via pi's existing provider config
- Background via pi's existing background execution
- TUI panel via pi's existing widget/panel system
