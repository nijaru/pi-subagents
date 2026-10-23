import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RpcChildSupervisor } from "../extensions/pi-subagents/supervisor.ts";
import { realRpcFixture } from "./fixtures/real-rpc.ts";

// Each test starts the installed CLI, not an SDK bootstrap or fake RPC process.
test("real RPC child executes a tool and reports usage", async () => {
  using f = realRpcFixture((body) => body.messages.some((message: any) => message.role === "tool")
    ? { content: "FILE_SENTINEL" }
    : { tool_calls: [{ index: 0, id: "read_call", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] });
  fs.writeFileSync(path.join(f.dir, "fixture.txt"), "SENTINEL_CONTENT");
  const result = await new RpcChildSupervisor().run({
    task: {
      id: "real-run", prompt: "Read fixture.txt and report its content.", cwd: f.dir,
      tools: ["read"], model: "fixture/model", thinking: "off", executionTimeoutMs: 20_000,
    },
    signal: new AbortController().signal,
  });
  expect(result.outcome).toBe("completed");
  expect(result.output).toContain("FILE_SENTINEL");
  expect(result.usage).toMatchObject({ turns: 2, input: 34, output: 8, totalTokens: 42 });
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0].tools.map((tool: any) => tool.function.name)).toEqual(["read"]);
  expect(JSON.stringify(f.requests[0].messages)).toContain("Read fixture.txt");
  expect(JSON.stringify(f.requests[1].messages)).toContain("SENTINEL_CONTENT");
}, 30_000);

test("missing tools exhaust startup without submitting model work", async () => {
  using f = realRpcFixture();
  const result = await new RpcChildSupervisor().run({
    task: {
      id: "missing-tool", prompt: "must not run", cwd: f.dir,
      tools: ["definitely_missing"], model: "fixture/model", executionTimeoutMs: 5_000, startupTimeoutMs: 1_000,
    },
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ outcome: "timed_out", errorKind: "deadline", timeoutPhase: "startup" });
  expect(f.requests).toEqual([]);
}, 20_000);

test("persisted sessions resume their history only in the original workspace", async () => {
  using f = realRpcFixture();
  const supervisor = new RpcChildSupervisor();
  const first = await supervisor.run({
    task: { id: "persisted", prompt: "FIRST_MARKER", cwd: f.dir, tools: [], model: "fixture/model", persist: true, executionTimeoutMs: 10_000 },
    signal: new AbortController().signal,
  });
  expect(first.outcome).toBe("completed");
  expect(first.sessionFile).toBeDefined();
  expect(fs.existsSync(first.sessionFile!)).toBe(true);
  const other = path.join(f.dir, "other");
  fs.mkdirSync(other);
  const rejected = await supervisor.run({
    task: { id: "wrong-cwd", prompt: "must not run", cwd: other, tools: [], model: "fixture/model", resume: first.sessionFile },
    signal: new AbortController().signal,
  });
  expect(rejected).toMatchObject({ outcome: "failed", errorKind: "startup" });
  expect(rejected.errorMessage).toContain("does not match requested cwd");
  const second = await supervisor.run({
    task: { id: "resumed", prompt: "SECOND_MARKER", cwd: f.dir, tools: [], model: "fixture/model", resume: first.sessionFile, executionTimeoutMs: 10_000 },
    signal: new AbortController().signal,
  });
  expect(second.outcome).toBe("completed");
  expect(second.sessionFile).toBe(first.sessionFile);
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1].messages)).toContain("FIRST_MARKER");
  expect(JSON.stringify(f.requests[1].messages)).toContain("SECOND_MARKER");
  expect(JSON.stringify(f.requests[1].messages)).not.toContain("subagent-probe");
}, 30_000);

test("real RPC child finishes async session_shutdown hooks on normal completion", async () => {
  using f = realRpcFixture();
  fs.writeFileSync(path.join(f.dir, "shutdown.ts"), `import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export default (pi: any) => pi.on("session_shutdown", async () => { await delay(300); writeFileSync("shutdown.done", "yes"); });`);
  fs.writeFileSync(path.join(f.dir, "settings.json"), JSON.stringify({ extensions: [path.join(f.dir, "shutdown.ts")] }));
  const result = await new RpcChildSupervisor().run({
    task: { id: "shutdown", prompt: "say OK", cwd: f.dir, tools: [], model: "fixture/model", executionTimeoutMs: 10_000 },
    signal: new AbortController().signal,
  });
  expect(result.outcome).toBe("completed");
  expect(fs.existsSync(path.join(f.dir, "shutdown.done"))).toBe(true);
}, 30_000);

test("selected callable codemode tool remains reachable after exclusions", async () => {
  using f = realRpcFixture((body) => body.messages.some((message: any) => message.role === "tool")
    ? { content: "CODEMODE_OK" }
    : { tool_calls: [{ index: 0, id: "code_call", type: "function", function: { name: "code_lookup", arguments: "{}" } }] });
  fs.writeFileSync(path.join(f.dir, "code.ts"), `export default (pi: any) => pi.registerTool({ name: "code_lookup", label: "lookup", description: "codemode", exposure: "codemode", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "tool-ran" }] }) });`);
  fs.writeFileSync(path.join(f.dir, "settings.json"), JSON.stringify({ extensions: [path.join(f.dir, "code.ts")] }));
  const result = await new RpcChildSupervisor().run({
    task: { id: "codemode", prompt: "use the tool", cwd: f.dir, tools: ["code_lookup"], model: "fixture/model", executionTimeoutMs: 10_000 },
    signal: new AbortController().signal,
  });
  expect(result.outcome).toBe("completed");
  expect(result.output).toContain("CODEMODE_OK");
  expect(f.requests[0].tools.map((tool: any) => tool.function.name)).toEqual(["code_lookup"]);
  expect(JSON.stringify(f.requests[1].messages)).toContain("tool-ran");
}, 30_000);

test("probe blocks omitted tools from nested executeTool calls", async () => {
  using f = realRpcFixture((body) => body.messages.some((message: any) => message.role === "tool")
    ? { content: "NESTED_OK" }
    : { tool_calls: [{ index: 0, id: "delegate_call", type: "function", function: { name: "delegate_probe", arguments: "{}" } }] });
  fs.writeFileSync(path.join(f.dir, "nested.ts"), `import { writeFileSync } from "node:fs";
export default (pi: any) => {
  pi.registerTool({ name: "mcp__omitted__action", label: "omitted", description: "omitted", exposure: "codemode", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { writeFileSync("omitted-ran", "yes"); return { content: [{ type: "text", text: "omitted-ran" }] }; } });
  pi.registerTool({ name: "delegate_probe", label: "delegate", description: "delegate", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async (_id: string, _args: unknown, _signal: unknown, _update: unknown, ctx: any) => { const outcome = await ctx.executeTool("mcp__omitted__action", {}); writeFileSync("nested-result", JSON.stringify({ isError: outcome.isError, content: outcome.content })); return { content: [{ type: "text", text: outcome.isError ? "blocked" : "reached" }] }; } });
};`);
  fs.writeFileSync(path.join(f.dir, "settings.json"), JSON.stringify({ extensions: [path.join(f.dir, "nested.ts")] }));
  const result = await new RpcChildSupervisor().run({
    task: { id: "nested", prompt: "use delegate", cwd: f.dir, tools: ["delegate_probe"], model: "fixture/model", executionTimeoutMs: 10_000 },
    signal: new AbortController().signal,
  });
  expect(result.outcome).toBe("completed");
  expect(fs.existsSync(path.join(f.dir, "omitted-ran"))).toBe(false);
  expect(fs.readFileSync(path.join(f.dir, "nested-result"), "utf8")).toContain('"isError":true');
  expect(result.output).toContain("NESTED_OK");
}, 30_000);

test("late tools share the startup budget beyond the old ten-second ceiling", async () => {
  using f = realRpcFixture();
  fs.writeFileSync(path.join(f.dir, "slow.ts"), `import { setTimeout as delay } from "node:timers/promises";
export default (pi: any) => {
  pi.on("session_start", async () => {
    await delay(1500);
    setTimeout(() => pi.registerTool({ name: "slow_tool", label: "slow", description: "late", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "late" }] }) }), 11000);
  });
}`);
  fs.writeFileSync(path.join(f.dir, "settings.json"), JSON.stringify({ extensions: [path.join(f.dir, "slow.ts")] }));
  const result = await new RpcChildSupervisor().run({
    task: { id: "slow-start", prompt: "say OK", cwd: f.dir, tools: ["slow_tool"], model: "fixture/model", executionTimeoutMs: 10_000, startupTimeoutMs: 15_000 },
    signal: new AbortController().signal,
  });
  expect(result.outcome).toBe("completed");
  expect(result.output).toContain("OK");
  expect(f.requests[0].tools.map((tool: any) => tool.function.name)).toEqual(["slow_tool"]);
}, 30_000);
