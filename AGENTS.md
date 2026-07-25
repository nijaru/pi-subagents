# pi-subagents

Pi extension for declarative agent delegation. Single, parallel, and sequential-chain delegation with seven bundled agents.

## Stack

TypeScript, Bun. Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`), Typebox.

## Testing

```bash
bun run check
```

No build step — pi loads the extension directly.

## Key Files

```
extensions/pi-subagents/index.ts   # tool schema, subprocess runner, controls, orchestration, rendering
extensions/pi-subagents/agents.ts  # scoped discovery and frontmatter policy
agents/*.md                        # bundled agent definitions
skills/pi-subagents/SKILL.md       # agent-facing tool reference
tests/                              # deterministic discovery, runner, and tool tests
```

## Agent Definitions

Markdown + YAML frontmatter in `~/.pi/agent/agents/` (user) or `.pi/agents/` (project). Bundled definitions ship in `agents/`. Required: `name`, `description`. Optional: `model`, explicit `tools`, `delegation`, and `capability`.

```markdown
---
name: reviewer
description: Code review for correctness and quality
capability: read
tools: read,grep,find,ls
---
```

Missing `tools` means `--no-tools`, never all tools. `delegation` defaults false; only `delegation: true` permits the `subagent` tool. `capability` is effect metadata, not a sandbox: `read` or `write`; omission is treated as potentially mutating when parallel tasks share a canonical cwd. A `read` profile must use only known read-only tools (`read`, `grep`, `find`, `ls`, `code_search`, `web_search`, or `fetch_content`) and cannot delegate; unknown or mutation-capable tools invalidate the definition. Bundled `architect` and `worker` may delegate; other bundled agents are leaves.

Project agents are opt-in, require pi project trust, and receive a confirmation in UI sessions; headless sessions reject them. Their task cwd must remain inside the trusted project root. Delegation always runs in a fresh subprocess with `--no-session`; nested calls are bounded by depth 3, a root-wide 32-descendant budget, a shared four-process limit, and a propagated deadline/control file.

Task and system-prompt contents use mode-0600 temporary files. Child env is allowlisted: standard pi model credential variables and all `$VAR` refs from `~/.pi/agent/models.json` are passed, including JSONC configs and nested model/header references. Custom tool or application variables require `PI_SUBAGENT_PASSTHROUGH_ENV` with exact names or globs (`OPENAI_*`, `*`). Use `*` to pass all env (insecure). Best is to store keys via `pi /login` in `~/.pi/agent/auth.json` — then children need no env passthrough. The package does not implement persistent sessions, background registries, or managed worktrees; those are future explicit opt-ins.

The implementation relies on the current pi CLI/API (`--mode json`, `--no-session`, `--tools`/`--no-tools`, and `@file`) and does not claim compatibility with older pi versions.
