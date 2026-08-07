import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXTENSION = path.join(import.meta.dir, "..", "extensions", "pi-subagents", "index.ts");
const tempDirs: string[] = [];

interface Tool {
  name: string;
  parameters: any;
  execute: (...args: any[]) => Promise<any>;
  renderCall: (...args: any[]) => any;
  renderResult: (...args: any[]) => any;
}

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-execute-"));
  tempDirs.push(directory);
  return directory;
}
function writeAgent(root: string, name = "test-agent", source = ".pi/agents") {
  const directory = path.join(root, source);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), `---\nname: ${name}\ndescription: Test agent\ncapability: read\n---\nYou are a test agent.\n`);
}
function writeFakePi(): string {
  const directory = tempDir();
  const script = path.join(directory, "fake-pi");
  fs.writeFileSync(script, `#!/bin/sh
printf '%s\\n' "$@" > "$0.args"
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"fake result"}],"api":"test","provider":"fake","model":"fake/model","usage":{"input":2,"output":3,"cacheRead":4,"cacheWrite":5,"totalTokens":9,"cost":{"input":0.1,"output":0.2,"cacheRead":0.3,"cacheWrite":0.4,"total":1}},"stopReason":"stop","timestamp":0}}'
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeWorkflowBranchPi(): string {
  const directory = tempDir();
  const script = path.join(directory, "workflow-branch-pi");
  fs.writeFileSync(script, `#!/bin/sh
if [ ! -f "$0.first" ]; then
  touch "$0.first"
  exit 1
fi
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"workflow fallback"}],"model":"fake/model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":0}}'
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeStructuredPi(output: string): string {
  const directory = tempDir();
  const script = path.join(directory, "structured-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(output)} }], model: "fake/model", usage, stopReason: "stop", timestamp: 1 } }));
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeLargeMetadataPi(): string {
  const directory = tempDir();
  const script = path.join(directory, "large-metadata-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "metadata result" }], model: "fake/model", usage, stopReason: "stop", timestamp: 1, providerMetadata: "x".repeat(20 * 1024) } }));
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeStructuredAgent(root: string): void {
  const directory = path.join(root, ".pi", "agents");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "structured.md"), `---
name: structured
description: Structured test agent
outputSchema:
  type: object
  properties:
    summary:
      type: string
    count:
      type: integer
  required:
    - summary
  additionalProperties: false
---
Return the structured report.
`);
}
function writePolicyAgent(root: string, policy: string): void {
  const directory = path.join(root, ".pi", "agents");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "coordinator.md"), `---
name: coordinator
description: Policy test coordinator
delegation: true
capability: write
${policy}
---
Delegate only according to the policy.
`);
}
function writeEnvPi(): string {
  const directory = tempDir();
  const script = path.join(directory, "env-pi");
  fs.writeFileSync(script, `#!/bin/sh
printf '%s\\n' "$PI_SUBAGENTS_TEST_MODEL_KEY" "$pi_subagents_test_lower" "$OPENAI_API_KEY" "$UNRELATED_API_KEY" "$UNRELATED_TOKEN" "$UNRELATED_VALUE" > "$0.env"
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"env result"}],"model":"fake/model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":0}}'
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeEmptyPi(): string {
  const directory = tempDir();
  const script = path.join(directory, "empty-pi");
  fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(script, 0o755);
  return script;
}
function writeToolUseOnlyPi(): string {
  const directory = tempDir();
  const script = path.join(directory, "tool-use-only-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I need a tool" }], model: "fake/model", usage, stopReason: "toolUse", timestamp: 1 } }));
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeHangingPi(): string {
  const directory = tempDir();
  const script = path.join(directory, "hanging-pi");
  fs.writeFileSync(script, `#!/bin/sh
trap 'exit 0' TERM INT
while :; do sleep 1; done
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeRecursivePi(): string {
  const directory = tempDir();
  const script = path.join(directory, "recursive-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
if (process.env.PI_SUBAGENT_DEPTH === "1") {
  const extension = await import(${JSON.stringify(EXTENSION)});
  const tools: any[] = [];
  extension.default({ registerTool(definition: any) { tools.push(definition); } } as any);
  const tool = tools.find((candidate) => candidate.name === "subagent");
  try {
    const nested = await tool.execute("nested", { agent: "worker", task: "nested" }, undefined, undefined, {
      cwd: process.cwd(),
      hasUI: false,
      model: { provider: "parent", id: "parent-model" },
    });
    if (nested?.isError) process.exit(1);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recursive result" }], model: "fake/model", usage, stopReason: "stop", timestamp: 1 } }));
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeDeltaPi(): string {
  const directory = tempDir();
  const script = path.join(directory, "delta-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
for (let index = 0; index < 60; index++) {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(500) } }));
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(30000) }], model: "fake/model", usage, stopReason: "stop", timestamp: 1 }}));
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeLargeToolUpdatePi(): string {
  const directory = tempDir();
  const script = path.join(directory, "large-tool-update-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
console.log(JSON.stringify({ type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: {}, partialResult: "x".repeat(2 * 1024 * 1024) }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final after large tool update" }], model: "fake/model", usage, stopReason: "stop", timestamp: 1 }}));
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeIgnoredLineFloodPi(): string {
  const directory = tempDir();
  const script = path.join(directory, "ignored-line-flood-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
process.stdout.write("ignored protocol line\\n".repeat(300_000));
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final after ignored traffic" }], model: "fake/model", usage, stopReason: "stop", timestamp: 1 }}) + "\\n");
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeSplitUtf8Pi(): string {
  const directory = tempDir();
  const script = path.join(directory, "split-utf8-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const bytes = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "split 😀漢字" }], model: "fake/model", usage, stopReason: "stop", timestamp: 1 }}) + "\\n");
const marker = Buffer.from("😀");
const index = bytes.indexOf(marker);
process.stdout.write(bytes.subarray(0, index + 1));
process.stdout.write(bytes.subarray(index + 1, index + 2));
process.stdout.write(bytes.subarray(index + 2));
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeOversizedUnterminatedLinePi(): string {
  const directory = tempDir();
  const script = path.join(directory, "oversized-unterminated-line-pi");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
process.stdout.write("x".repeat(2 * 1024 * 1024));
process.stdout.write("\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final after oversized line" }], model: "fake/model", usage, stopReason: "stop", timestamp: 1 }}) + "\\n");
`);
  fs.chmodSync(script, 0o755);
  return script;
}
function writeStaleLockHolderPi(): { script: string; marker: string } {
  const directory = tempDir();
  const script = path.join(directory, "stale-lock-holder-pi");
  const marker = path.join(directory, "lock-check");
  fs.writeFileSync(script, `#!/usr/bin/env bun
import * as fs from "node:fs";
const lockPath = process.env.PI_SUBAGENT_CONTROL_FILE + ".lock";
const marker = ${JSON.stringify(marker)};
await fs.promises.mkdir(lockPath);
const holder = Bun.spawn(["sh", "-c", 'sleep 1; if [ -d "$1" ]; then printf safe > "$2"; else printf raced > "$2"; fi', "holder", lockPath, marker], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
await fs.promises.writeFile(lockPath + "/owner", JSON.stringify({ pid: holder.pid, startedAt: Date.now() }));
const old = new Date(Date.now() - 10_000);
await fs.promises.utimes(lockPath, old, old);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "lock holder result" }], model: "fake/model", usage, stopReason: "stop", timestamp: 1 }}));
`);
  fs.chmodSync(script, 0o755);
  return { script, marker };
}
function writeLingeringPi(): { script: string; marker: string } {
  const directory = tempDir();
  const script = path.join(directory, "lingering-pi");
  const marker = path.join(directory, "swept");
  fs.writeFileSync(script, `#!/bin/sh
( trap 'printf swept > ${marker}; exit 0' TERM; while :; do sleep 1; done ) &
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"model":"fake/model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":0}}'
exit 0
`);
  fs.chmodSync(script, 0o755);
  return { script, marker };
}
async function waitForFile(file: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function loadTool(): Promise<Tool> {
  const tools: Tool[] = [];
  const api = { registerTool(definition: Tool) { tools.push(definition); } } as any;
  const module = await import(`${EXTENSION}?test=${Math.random()}`);
  module.default(api);
  const tool = tools.find((candidate) => candidate.name === "subagent");
  if (!tool) throw new Error("subagent was not registered");
  return tool;
}
function ctx(cwd: string, extra: Record<string, unknown> = {}) {
  return {
    cwd,
    hasUI: false,
    model: { provider: "parent", id: "parent-model" },
    ui: { confirm: async () => true },
    isProjectTrusted: () => true,
    ...extra,
  };
}
async function call(tool: Tool, params: any, context: any, signal?: AbortSignal, onUpdate?: (value: any) => void) {
  try {
    return await tool.execute("call", params, signal, onUpdate, context);
  } catch (error) {
    const failure = error as { message?: unknown; details?: unknown };
    return {
      content: [{ type: "text", text: typeof failure.message === "string" ? failure.message : String(error) }],
      details: failure.details ?? { mode: "single", agentScope: params.agentScope ?? "user", projectAgentsDir: null, results: [] },
      isError: true,
    };
  }
}

afterEach(() => {
  delete process.env.PI_SUBAGENT_BIN;
  delete process.env.PI_SUBAGENT_DEPTH;
  for (const key of ["PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_PARENT_ID", "PI_SUBAGENT_ROOT_ID", "PI_SUBAGENT_CONTROL_FILE", "PI_SUBAGENT_DEADLINE_MS", "PI_SUBAGENT_BUDGET_REMAINING", "PI_SUBAGENT_DELEGATION_POLICY", "PI_SUBAGENT_TIMEOUT_MS"]) delete process.env[key];
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("tool contract", () => {
  let tool: Tool;
  beforeEach(async () => { tool = await loadTool(); });

  test("has only the clean delegation schema", () => {
    const names = Object.keys(tool.parameters.properties);
    expect(names).toContain("agentScope");
    expect(names).toContain("model");
    expect(names).toContain("tasks");
    expect(names).toContain("chain");
    expect(names).toContain("workflow");
    for (const removed of ["background", "execution", "context", "acceptance", "gate", "prompt", "concurrency", "id"]) {
      expect(names).not.toContain(removed);
    }
  });

  test("lists bundled agents without a project", async () => {
    const root = tempDir();
    const result = await call(tool, { action: "list" }, ctx(root));
    expect(result.content[0].text).toContain("reviewer");
    expect(result.content[0].text).toContain("tools=read,write,edit,bash,grep,find,ls");
    expect(result.content[0].text).toContain("query-docs");
    expect(result.details.action).toBe("list");
    expect(result.details.results).toEqual([]);
    const rendered = tool.renderResult(result, { expanded: false }, { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any, {});
    expect(rendered.render(120).join("\n")).toBe("");
  });

  test("does not list project prompts headlessly", async () => {
    const root = tempDir();
    writeAgent(root, "local");
    const result = await call(tool, { action: "list", agentScope: "project" }, ctx(root, { hasUI: false }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("interactive confirmation");
  });

  test("filters nested agent listings by inherited allowedAgents", async () => {
    process.env.PI_SUBAGENT_DELEGATION_POLICY = JSON.stringify({ allowedAgents: ["worker"] });
    const result = await call(tool, { action: "list" }, ctx(tempDir()));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("worker:");
    expect(result.content[0].text).not.toContain("reviewer:");
  });

  test("confirms before a project agent runs", async () => {
    const root = tempDir();
    writeAgent(root, "local");
    let confirmations = 0;
    const result = await call(tool, { agent: "local", task: "run", agentScope: "project" }, ctx(root, {
      hasUI: true,
      ui: { confirm: async () => { confirmations++; return false; } },
    }));
    expect(confirmations).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not approved");
  });

  test("rejects action/mode combinations instead of silently ignoring the mode", async () => {
    const root = tempDir();
    const result = await call(tool, { action: "list", agent: "test-agent", task: "run" }, ctx(root));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot be combined");
  });

  test("passes cancellation to project-agent confirmation", async () => {
    const root = tempDir();
    writeAgent(root, "local");
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const result = await call(tool, { agent: "local", task: "run", agentScope: "project" }, ctx(root, {
      hasUI: true,
      ui: { confirm: async (_title: string, _message: string, options: { signal?: AbortSignal }) => { seenSignal = options.signal; return false; } },
    }), controller.signal);
    expect(seenSignal).toBe(controller.signal);
    expect(result.isError).toBe(true);
  });

  test("rejects blank model overrides instead of dropping inheritance", async () => {
    const result = await call(tool, { agent: "worker", task: "run", model: "   " }, ctx(tempDir()));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Model overrides must not be blank");
  });

  test("rejects malformed depth values instead of resetting to zero", async () => {
    process.env.PI_SUBAGENT_DEPTH = "not-a-number";
    const root = tempDir();
    writeAgent(root);
    const result = await call(tool, { agent: "test-agent", task: "run" }, ctx(root));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("depth");
    expect(result.details.results).toEqual([]);
  });
});

describe("subprocess behavior", () => {
  let tool: Tool;
  beforeEach(async () => { tool = await loadTool(); });

  test("parses typed messages and usage from a real child process", async () => {
    const root = tempDir();
    writeAgent(root);
    process.env.PI_SUBAGENT_BIN = writeFakePi();
    const updates: string[] = [];
    const result = await call(tool, { agent: "test-agent", task: "run", model: "override/model", agentScope: "project" }, ctx(root, { hasUI: true }), undefined, (update) => {
      updates.push(update.content[0].text);
    });
    const agent = result.details.results[0];
    expect(result.isError).toBeUndefined();
    expect(agent.messages).toHaveLength(1);
    expect(agent.messages[0].role).toBe("assistant");
    expect(agent.usage.input).toBe(2);
    expect(agent.usage.output).toBe(3);
    expect(agent.usage.cost.total).toBe(1);
    expect(agent.stopReason).toBe("stop");
    expect(updates.length).toBeGreaterThan(1);
    const args = fs.readFileSync(`${process.env.PI_SUBAGENT_BIN}.args`, "utf8").split("\n").filter(Boolean);
    expect(args).toContain("--no-session");
    expect(args).toContain("--no-tools");
    expect(args.some((arg) => arg.startsWith("@") && arg.endsWith("/task.md"))).toBe(true);
    expect(args.join(" ")).not.toContain("Task: run");
  });

  test("validates opt-in structured output and exposes the parsed value", async () => {
    const root = tempDir();
    writeStructuredAgent(root);
    process.env.PI_SUBAGENT_BIN = writeStructuredPi(JSON.stringify({ summary: "done", count: 2 }));
    const result = await call(tool, { agent: "structured", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(JSON.stringify({ summary: "done", count: 2 }));
    expect(result.details.results[0].structuredOutput).toEqual({ summary: "done", count: 2 });
  });

  test("does not retain oversized provider metadata in message history", async () => {
    process.env.PI_SUBAGENT_BIN = writeLargeMetadataPi();
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBeUndefined();
    expect(result.details.results[0].output).toBe("metadata result");
    expect(result.details.results[0].messages).toHaveLength(0);
  });

  test("retains valid structured output larger than the diagnostic bound", async () => {
    const root = tempDir();
    writeStructuredAgent(root);
    const summary = "x".repeat(12 * 1024);
    process.env.PI_SUBAGENT_BIN = writeStructuredPi(JSON.stringify({ summary, count: 2 }));
    const result = await call(tool, { agent: "structured", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    expect(result.details.results[0].structuredOutput).toEqual({ summary, count: 2 });
    expect(Buffer.byteLength(JSON.stringify(result.details), "utf8")).toBeLessThanOrEqual(50 * 1024);
  });

  test("rejects malformed or schema-mismatched structured output", async () => {
    const root = tempDir();
    writeStructuredAgent(root);
    process.env.PI_SUBAGENT_BIN = writeStructuredPi("not json");
    const malformed = await call(tool, { agent: "structured", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(malformed.isError).toBe(true);
    expect(malformed.content[0].text).toContain("valid JSON");
    expect(malformed.details.results[0].termination).toBe("failed");

    process.env.PI_SUBAGENT_BIN = writeStructuredPi(JSON.stringify({ count: 2 }));
    const mismatch = await call(tool, { agent: "structured", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0].text).toContain("does not match");
    expect(mismatch.details.results[0].structuredOutput).toBeUndefined();
  });

  test("forwards model refs and credential variables without ambient application values", async () => {
    const root = tempDir();
    const agentDir = tempDir();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SUBAGENTS_TEST_MODEL_KEY = "model-secret";
    process.env.pi_subagents_test_lower = "lower-secret";
    process.env.OPENAI_API_KEY = "standard-model-secret";
    process.env.UNRELATED_API_KEY = "unrelated-api-secret";
    process.env.UNRELATED_TOKEN = "unrelated-token-secret";
    process.env.UNRELATED_VALUE = "unrelated-value";
    fs.writeFileSync(path.join(agentDir, "models.json"), `{
  // Pi accepts JSONC model configuration.
  "providers": {
    "custom": {
      "apiKey": "$PI_SUBAGENTS_TEST_MODEL_KEY",
      "headers": { "x-test": "$pi_subagents_test_lower", },
      "models": [],
    },
  },
}`);
    const fake = writeEnvPi();
    process.env.PI_SUBAGENT_BIN = fake;
    try {
      const result = await call(tool, { agent: "worker", task: "run", model: "custom/model" }, ctx(root));
      expect(result.isError).toBeUndefined();
      expect(fs.readFileSync(`${fake}.env`, "utf8").split("\n")).toEqual([
        "model-secret",
        "lower-secret",
        "standard-model-secret",
        "unrelated-api-secret",
        "unrelated-token-secret",
        "",
        "",
      ]);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      delete process.env.PI_SUBAGENTS_TEST_MODEL_KEY;
      delete process.env.pi_subagents_test_lower;
      if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAIKey;
      delete process.env.UNRELATED_API_KEY;
      delete process.env.UNRELATED_TOKEN;
      delete process.env.UNRELATED_VALUE;
    }
  });

  test("handles Pi 0.84 delta updates without changing final output bounds", async () => {
    const root = tempDir();
    writeAgent(root);
    process.env.PI_SUBAGENT_BIN = writeDeltaPi();
    const updates: string[] = [];
    const result = await call(tool, { agent: "test-agent", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }), undefined, (update) => {
      updates.push(update.content[0].text);
    });
    expect(result.isError).toBeUndefined();
    expect(updates.length).toBeGreaterThan(1);
    expect(updates.length).toBeLessThan(100);
    expect(result.content[0].text.length).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(result.details.results[0].output.length).toBe(30_000);
    expect(result.details.results[0].messages[0].content[0].text.length).toBeLessThanOrEqual(16 * 1024);
  });

  test("continues after a large tool update and preserves the final response", async () => {
    process.env.PI_SUBAGENT_BIN = writeLargeToolUpdatePi();
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("final after large tool update");
  });

  test("continues after ignored protocol-line floods", async () => {
    process.env.PI_SUBAGENT_BIN = writeIgnoredLineFloodPi();
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("final after ignored traffic");
  });

  test("preserves UTF-8 characters split across stdout chunks", async () => {
    process.env.PI_SUBAGENT_BIN = writeSplitUtf8Pi();
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("split 😀漢字");
  });

  test("drops an oversized unterminated line and parses the next event", async () => {
    process.env.PI_SUBAGENT_BIN = writeOversizedUnterminatedLinePi();
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("final after oversized line");
  });

  test("sweeps descendants after a root child exits normally", async () => {
    const root = tempDir();
    writeAgent(root);
    const lingering = writeLingeringPi();
    process.env.PI_SUBAGENT_BIN = lingering.script;
    const result = await call(tool, { agent: "test-agent", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    await waitForFile(lingering.marker);
    expect(fs.existsSync(lingering.marker)).toBe(true);
  });

  test("does not remove a stale lock while its recorded owner is alive", async () => {
    if (process.platform === "win32") return;
    const root = tempDir();
    writeAgent(root);
    const staleLock = writeStaleLockHolderPi();
    process.env.PI_SUBAGENT_BIN = staleLock.script;
    const result = await call(tool, { agent: "test-agent", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    await waitForFile(staleLock.marker, 2_000);
    expect(fs.readFileSync(staleLock.marker, "utf8")).toBe("safe");
  });

  test("adds subagent only for an explicitly delegation-capable agent", async () => {
    const root = tempDir();
    writeAgent(root);
    fs.writeFileSync(path.join(root, ".pi", "agents", "test-agent.md"), "---\nname: test-agent\ndescription: Test agent\ndelegation: true\ncapability: write\ntools: read\n---\nPrompt\n");
    const fake = writeFakePi();
    process.env.PI_SUBAGENT_BIN = fake;
    const result = await call(tool, { agent: "test-agent", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    const args = fs.readFileSync(`${fake}.args`, "utf8").split("\n").filter(Boolean);
    expect(args).toContain("--tools");
    expect(args).toContain("read,subagent");
  });

  test("fails closed for malformed inherited control state", async () => {
    process.env.PI_SUBAGENT_DEPTH = "1";
    process.env.PI_SUBAGENT_RUN_ID = "child";
    process.env.PI_SUBAGENT_PARENT_ID = "parent";
    process.env.PI_SUBAGENT_ROOT_ID = "root";
    const controlDirectory = tempDir();
    const controlPath = path.join(controlDirectory, "state.json");
    fs.writeFileSync(controlPath, "{}");
    process.env.PI_SUBAGENT_CONTROL_FILE = controlPath;
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("control");
  });

  test("rejects multiple potentially mutating tasks in one canonical cwd", async () => {
    const root = tempDir();
    writeAgent(root);
    fs.writeFileSync(path.join(root, ".pi", "agents", "test-agent.md"), "---\nname: test-agent\ndescription: Test agent\n---\nPrompt\n");
    const result = await call(tool, {
      tasks: [{ agent: "test-agent", task: "one" }, { agent: "test-agent", task: "two" }],
      agentScope: "project",
    }, ctx(root, { hasUI: true }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Parallel mutation rejected");
  });

  test("rejects potentially mutating parallel tasks in one project root", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.mkdirSync(path.join(root, "one"));
    fs.mkdirSync(path.join(root, "two"));
    writeAgent(root);
    fs.writeFileSync(path.join(root, ".pi", "agents", "test-agent.md"), "---\nname: test-agent\ndescription: Test agent\n---\nPrompt\n");
    const result = await call(tool, {
      tasks: [{ agent: "test-agent", task: "one", cwd: "one" }, { agent: "test-agent", task: "two", cwd: "two" }],
      agentScope: "project",
    }, ctx(root, { hasUI: true }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("share project root");
  });

  test("allows potentially mutating parallel tasks in distinct canonical cwds", async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "one"));
    fs.mkdirSync(path.join(root, "two"));
    writeAgent(root);
    process.env.PI_SUBAGENT_BIN = writeFakePi();
    const result = await call(tool, {
      tasks: [{ agent: "test-agent", task: "one", cwd: "one" }, { agent: "test-agent", task: "two", cwd: "two" }],
      agentScope: "project",
    }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    expect(result.details.results).toHaveLength(2);
  });

  test("fails when a child produces no assistant output", async () => {
    process.env.PI_SUBAGENT_BIN = writeEmptyPi();
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no assistant output");
    expect(result.details.results[0].termination).toBe("failed");
  });

  test("does not treat a tool-use turn as a completed report", async () => {
    process.env.PI_SUBAGENT_BIN = writeToolUseOnlyPi();
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("terminal response");
    expect(result.details.results[0].termination).toBe("failed");
  });

  test("reports timeouts separately from ordinary failures", async () => {
    process.env.PI_SUBAGENT_TIMEOUT_MS = "25";
    process.env.PI_SUBAGENT_BIN = writeHangingPi();
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()));
    expect(result.isError).toBe(true);
    expect(result.details.results[0].termination).toBe("timed_out");
    expect(result.content[0].text).toContain("timed out");
  });

  test("reports cancellation separately from timeout", async () => {
    process.env.PI_SUBAGENT_BIN = writeHangingPi();
    const controller = new AbortController();
    const pending = call(tool, { agent: "worker", task: "run" }, ctx(tempDir()), controller.signal);
    setTimeout(() => controller.abort(), 25);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details.results[0].termination).toBe("cancelled");
  });

  test("queues nested delegation without starving a full sibling fan-out", async () => {
    const root = tempDir();
    const cwds = ["one", "two", "three", "four"].map((name) => {
      const cwd = path.join(root, name);
      fs.mkdirSync(cwd);
      return cwd;
    });
    process.env.PI_SUBAGENT_BIN = writeRecursivePi();
    const result = await call(tool, {
      tasks: cwds.map((cwd) => ({ agent: "worker", task: "run", cwd })),
    }, ctx(root));
    expect(result.isError).toBeUndefined();
    expect(result.details.results.map((item: any) => item.termination)).toEqual(["completed", "completed", "completed", "completed"]);
  });

  test("enforces inherited allowedAgents for nested delegation", async () => {
    const root = tempDir();
    writePolicyAgent(root, "allowedAgents: [reviewer]");
    process.env.PI_SUBAGENT_BIN = writeRecursivePi();
    const result = await call(tool, { agent: "coordinator", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("restricted to");
  });

  test("transports large nested policies through a private file", async () => {
    const root = tempDir();
    const names = ["worker", ...Array.from({ length: 100 }, (_, index) => `unused-${index}-${"x".repeat(200)}`)];
    writePolicyAgent(root, `allowedAgents: [${names.join(", ")}]`);
    process.env.PI_SUBAGENT_BIN = writeRecursivePi();
    const result = await call(tool, { agent: "coordinator", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    expect(result.details.results[0].termination).toBe("completed");
  });

  test("enforces inherited maxDelegationDepth for nested delegation", async () => {
    const root = tempDir();
    writePolicyAgent(root, "maxDelegationDepth: 0");
    process.env.PI_SUBAGENT_BIN = writeRecursivePi();
    const result = await call(tool, { agent: "coordinator", task: "run", agentScope: "project" }, ctx(root, { hasUI: true }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("depth policy");
  });

  test("returns a structured failure when an update handler throws", async () => {
    const result = await call(tool, { agent: "worker", task: "run" }, ctx(tempDir()), undefined, () => {
      throw new Error("update boom");
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("update boom");
  });

  test("rejects untrusted project agents in headless mode", async () => {
    const root = tempDir();
    writeAgent(root, "local");
    const result = await call(tool, { agent: "local", task: "run", agentScope: "project" }, ctx(root, {
      hasUI: false,
      isProjectTrusted: () => false,
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not trusted");
  });

  test("requires interactive confirmation for project agents", async () => {
    const root = tempDir();
    writeAgent(root, "local");
    const result = await call(tool, { agent: "local", task: "run", agentScope: "project" }, ctx(root, {
      hasUI: false,
      isProjectTrusted: () => true,
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("interactive confirmation");
  });

  test("does not use a different repository's project agent via cwd", async () => {
    const root = tempDir();
    const other = tempDir();
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(other, "package.json"), "{}");
    writeAgent(other, "other");
    const result = await call(tool, {
      agent: "other",
      task: "run",
      agentScope: "project",
      cwd: other,
    }, ctx(root, { hasUI: false }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("trusted project cwd");
  });

  test("supports bounded workflow branches through the shared supervisor", async () => {
    const root = tempDir();
    writeAgent(root);
    process.env.PI_SUBAGENT_BIN = writeFakePi();
    const result = await call(tool, {
      workflow: {
        start: "review",
        steps: [
          { id: "review", agent: "test-agent", task: "review", onSuccess: "finish" },
          { id: "finish", agent: "test-agent", task: "finish using {previous}" },
        ],
      },
      agentScope: "project",
    }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    expect(result.details.mode).toBe("workflow");
    expect(result.details.results).toHaveLength(2);
    expect(result.content[0].text).toBe("fake result");
  });

  test("follows workflow failure branches through the shared supervisor", async () => {
    const root = tempDir();
    writeAgent(root);
    process.env.PI_SUBAGENT_BIN = writeWorkflowBranchPi();
    const result = await call(tool, {
      workflow: {
        steps: [
          { id: "review", agent: "test-agent", task: "review", onFailure: "fallback" },
          { id: "fallback", agent: "test-agent", task: "recover using {previous}" },
        ],
      },
      agentScope: "project",
    }, ctx(root, { hasUI: true }));
    expect(result.isError).toBeUndefined();
    expect(result.details.mode).toBe("workflow");
    expect(result.details.results).toHaveLength(2);
    expect(result.details.results[0].termination).toBe("failed");
    expect(result.content[0].text).toBe("workflow fallback");
  });

  test("rejects workflow edges to unknown nodes before spawning", async () => {
    const root = tempDir();
    writeAgent(root);
    const result = await call(tool, {
      workflow: {
        steps: [{ id: "review", agent: "test-agent", task: "review", onSuccess: "missing" }],
      },
      agentScope: "project",
    }, ctx(root, { hasUI: true }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("references missing node");
    expect(result.details.results).toEqual([]);
  });

  test("supports parallel and chain modes with model overrides", async () => {
    const root = tempDir();
    writeAgent(root);
    process.env.PI_SUBAGENT_BIN = writeFakePi();
    const parallel = await call(tool, {
      model: "override/model",
      tasks: [{ agent: "test-agent", task: "one" }, { agent: "test-agent", task: "two" }],
      agentScope: "project",
    }, ctx(root, { hasUI: true }));
    expect(parallel.details.mode).toBe("parallel");
    expect(parallel.details.results.map((item: any) => item.agent)).toEqual(["test-agent", "test-agent"]);
    expect(Buffer.byteLength(JSON.stringify(parallel.details), "utf8")).toBeLessThanOrEqual(50 * 1024);

    const chain = await call(tool, {
      model: "override/model",
      agentScope: "project",
      chain: [{ agent: "test-agent", task: "one" }, { agent: "test-agent", task: "use {previous}" }],
    }, ctx(root, { hasUI: true }));
    expect(chain.details.mode).toBe("chain");
    expect(chain.details.results).toHaveLength(2);
    expect(chain.content[0].text).toBe("fake result");
  });
});

describe("rendering", () => {
  test("renders calls and typed result details in both collapsed and expanded views", async () => {
    const tool = await loadTool();
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;
    const callComponent = tool.renderCall({ agent: "reviewer", task: "Review this", agentScope: "both" }, theme, {});
    expect(callComponent.render(120).join("\n")).toContain("reviewer");
    const details = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [{
        agent: "reviewer", agentSource: "bundled", task: "Review this", exitCode: 0, stopReason: "stop",
        stderr: "", messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }], usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }, model: "fake/model", api: "test", provider: "fake", stopReason: "stop", timestamp: 0 }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turns: 1 },
      }],
    };
    const value = { content: [{ type: "text", text: "Done" }], details };
    expect(tool.renderResult(value, { expanded: false }, theme, {}).render(120).join("\n")).toContain("Done");
    expect(tool.renderResult(value, { expanded: true }, theme, {}).render(120).join("\n")).toContain("Done");
    expect(tool.renderResult({ content: [{ type: "text", text: "failed" }], details: {} }, { expanded: false }, theme, {}).render(120).join("\n")).toContain("failed");
    const partial = {
      content: [{ type: "text", text: "Running read..." }],
      details: { ...details, results: [{ ...details.results[0], exitCode: -1, messages: [] }] },
    };
    expect(tool.renderResult(partial, { expanded: false }, theme, {}).render(120).join("\n")).toContain("Running read...");
  });
});
