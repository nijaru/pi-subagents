# pi-subagents

Clean declarative agent delegation for pi. Define agents, chain them, run them.

## Architecture

- Single extension, ~800 lines
- Entry: `extensions/pi-subagents/index.ts`
- Agent defs: `agents/*.md` (YAML frontmatter)
- Three modes: single, chain, parallel
- Quality gates between chain steps (shell cmd, exit 0 = pass)
- Background execution (subprocess only, detached)
- Bounded depth (default 3)

## Stack

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`)
- Pi TUI (`@earendil-works/pi-tui`)
- Typebox (parameter schemas)

## Key SDK APIs

```typescript
import { createAgentSession, AgentSession, SessionManager, ExtensionContext } from "@earendil-works/pi-coding-agent";
```

- `createAgentSession({ cwd, sessionManager, tools?, model? })` — creates an in-process agent session
  - Returns `{ session: AgentSession }`
  - `session.prompt(task)` → `Promise<void>` (output in `session.messages`)
  - `session.messages` → array of `{ role, content, usage? }` messages
  - `session.abort()` — cancel running agent
  - `session.dispose()` — cleanup
  - `session.sessionId` — unique ID, works with intercom
- `SessionManager.inMemory()` — ephemeral session storage (no disk writes)
- `ctx.modelRegistry.find(provider, modelId)` → Model object for `createAgentSession`

## Execution Modes

**Inline (default)** — in-process via `createAgentSession()`. Shared memory, no subprocess overhead (~0MB additional). Works with intercom (same EventBus). Default for all agents.

**Subprocess** — detached pi process. ~230MB per agent. Required for background execution. Isolated — agent crash doesn't affect parent.

Agent .md: `execution: inline|subprocess`. Tool param: `execution` overrides at call time.

## Model Resolution

Priority: tool param `model` > agent .md `model` field > agent .md `task-type` field (mapped via `TASK_TYPE_MODELS`).

Resolution: string like `"openrouter/deepseek/deepseek-v4-flash"` → split on `/` → `ctx.modelRegistry.find(provider, modelId)`.

## Agent Definitions

Markdown with YAML frontmatter in `agents/` (project) or `~/.pi/agents/` (global).

```markdown
---
name: reviewer
description: Code review for correctness and quality
model: parasail/parasail-kimi-k27-code
task-type: review
execution: inline
tools: read,write,edit,bash,grep,find,ls
---

You are a code reviewer. ...
```

Required: `name`, `description`. Optional: `model`, `task-type`, `execution`, `tools`.

## Testing

```bash
bun test           # unit tests (frontmatter parsing, config)
```

For integration tests: use the `subagent` tool directly (single, chain, parallel modes). Verify with real file I/O, not trivial math.

## Key Files

```
extensions/pi-subagents/index.ts   # extension entry point (~800 lines)
agents/*.md                        # 7 agent definitions
skills/pi-subagents/SKILL.md       # skill definition (agent-facing)
README.md                          # user-facing docs
tests/agents.test.ts               # unit tests (14 tests)
```

## Decisions

- **In-process default**: User stated "by default in process is almost definitely better." SDK `createAgentSession()` shares parent memory, enables EventBus for intercom. Subprocess opt-in for crash isolation.
- **`session.prompt()` returns `Promise<void>`**: Output extracted from `session.messages` after await. Last assistant message's `TextContent` blocks form the output.
- **`SessionManager.inMemory()`**: No disk writes. Ephemeral sessions appropriate for subagents.
- **Intercom works inline**: Same EventBus, same process. Subprocess agents can't use intercom without parent session ID.
- **Concurrency default 8**: Inline agents are cheap (same process, shared memory). Bumped from 4.
- **`npmCommand: ["bun"]`**: User-level pi setting in `~/.pi/agent/settings.json` to work around npm `min-release-date` issue with `@earendil-works` packages.
