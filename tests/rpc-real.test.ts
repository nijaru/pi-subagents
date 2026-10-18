import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcChildSupervisor } from "../extensions/pi-subagents/supervisor.ts";

// The only fake is the model HTTP endpoint. The child is a real Pi CLI in RPC
// mode, proving the public protocol boundary without an SDK bootstrap.
test("real RPC child executes a tool and reports usage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-real-"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push(body);
      const returned = body.messages.some((message: any) => message.role === "tool");
      const delta = returned
        ? { content: "FILE_SENTINEL" }
        : { tool_calls: [{ index: 0, id: "read_call", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] };
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, returned ? "stop" : "tool_calls") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "fixture.txt"), "SENTINEL_CONTENT");
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const result = await new RpcChildSupervisor().run({
      task: {
        id: "real-run", prompt: "Read fixture.txt and report its content.", cwd: dir,
        tools: ["read"], model: "fixture/model", thinking: "off", executionTimeoutMs: 20_000,
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("completed");
    expect(result.output).toContain("FILE_SENTINEL");
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(requests).toHaveLength(2);
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(["read"]);
    expect(JSON.stringify(requests[0].messages)).toContain("Read fixture.txt");
    expect(JSON.stringify(requests[1].messages)).toContain("SENTINEL_CONTENT");
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("missing tools exhaust startup, never the execution budget", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-real-missing-"));
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model" }],
    } } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const result = await new RpcChildSupervisor().run({
      task: {
        id: "missing-tool", prompt: "must not run", cwd: dir,
        tools: ["definitely_missing"], model: "fixture/model", executionTimeoutMs: 5_000, startupTimeoutMs: 1_000,
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("timed_out");
    expect(result.errorKind).toBe("deadline");
    expect(result.timeoutPhase).toBe("startup");
  } finally {
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("persisted child session can be resumed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-resume-"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push(body);
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const supervisor = new RpcChildSupervisor();
    const first = await supervisor.run({
      task: { id: "persisted", prompt: "FIRST_MARKER", cwd: dir, tools: [], model: "fixture/model", persist: true, executionTimeoutMs: 10_000 },
      signal: new AbortController().signal,
    });
    expect(first.outcome).toBe("completed");
    expect(first.sessionFile).toBeDefined();
    expect(fs.existsSync(first.sessionFile!)).toBe(true);
    const second = await supervisor.run({
      task: { id: "resumed", prompt: "SECOND_MARKER", cwd: dir, tools: [], model: "fixture/model", resume: first.sessionFile, executionTimeoutMs: 10_000 },
      signal: new AbortController().signal,
    });
    expect(second.outcome).toBe("completed");
    expect(second.sessionFile).toBe(first.sessionFile);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain("FIRST_MARKER");
    expect(JSON.stringify(requests[1].messages)).toContain("SECOND_MARKER");
    expect(JSON.stringify(requests[1].messages)).not.toContain("subagent-probe");
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("real RPC child finishes async session_shutdown hooks on normal completion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-shutdown-"));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    fs.writeFileSync(path.join(dir, "shutdown.ts"), `import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export default (pi: any) => pi.on("session_shutdown", async () => { await delay(300); writeFileSync("shutdown.done", "yes"); });`);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "shutdown.ts")] }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const result = await new RpcChildSupervisor().run({
      task: { id: "shutdown", prompt: "say OK", cwd: dir, tools: [], model: "fixture/model", executionTimeoutMs: 10_000 },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("completed");
    expect(fs.existsSync(path.join(dir, "shutdown.done"))).toBe(true);
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("tool probe waits for a late-registered tool", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-slow-tool-"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    fs.writeFileSync(path.join(dir, "slow.ts"), `export default (pi: any) => {
      pi.on("session_start", () => setTimeout(() => {
        pi.registerTool({ name: "slow_tool", label: "slow", description: "late", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "late" }] }) });
      }, 1500));
    }`);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "slow.ts")] }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const result = await new RpcChildSupervisor().run({
      task: { id: "slow", prompt: "say OK", cwd: dir, tools: ["slow_tool"], model: "fixture/model", executionTimeoutMs: 10_000, startupTimeoutMs: 8_000 },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("completed");
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(["slow_tool"]);
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("selected callable codemode tool remains reachable after exclusions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-codemode-tool-"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push(body);
      const returned = body.messages.some((message: any) => message.role === "tool");
      const delta = returned
        ? { content: "CODEMODE_OK" }
        : { tool_calls: [{ index: 0, id: "code_call", type: "function", function: { name: "code_lookup", arguments: "{}" } }] };
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, returned ? "stop" : "tool_calls") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    fs.writeFileSync(path.join(dir, "code.ts"), `export default (pi: any) => pi.registerTool({ name: "code_lookup", label: "lookup", description: "codemode", exposure: "codemode", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "tool-ran" }] }) });`);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "code.ts")] }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const result = await new RpcChildSupervisor().run({
      task: { id: "codemode", prompt: "use the tool", cwd: dir, tools: ["code_lookup"], model: "fixture/model", executionTimeoutMs: 10_000 },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("completed");
    expect(result.output).toContain("CODEMODE_OK");
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(["code_lookup"]);
    expect(JSON.stringify(requests[1].messages)).toContain("tool-ran");
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("probe blocks omitted tools from nested executeTool calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-nested-tool-"));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      const returned = body.messages.some((message: any) => message.role === "tool");
      const delta = returned
        ? { content: "NESTED_OK" }
        : { tool_calls: [{ index: 0, id: "delegate_call", type: "function", function: { name: "delegate_probe", arguments: "{}" } }] };
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, returned ? "stop" : "tool_calls") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    fs.writeFileSync(path.join(dir, "nested.ts"), `import { writeFileSync } from "node:fs";
export default (pi: any) => {
  pi.registerTool({ name: "mcp__omitted__action", label: "omitted", description: "omitted", exposure: "codemode", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { writeFileSync("omitted-ran", "yes"); return { content: [{ type: "text", text: "omitted-ran" }] }; } });
  pi.registerTool({ name: "delegate_probe", label: "delegate", description: "delegate", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async (_id: string, _args: unknown, _signal: unknown, _update: unknown, ctx: any) => { const outcome = await ctx.executeTool("mcp__omitted__action", {}); writeFileSync("nested-result", JSON.stringify({ isError: outcome.isError, content: outcome.content })); return { content: [{ type: "text", text: outcome.isError ? "blocked" : "reached" }] }; } });
};`);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "nested.ts")] }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const result = await new RpcChildSupervisor().run({
      task: { id: "nested", prompt: "use delegate", cwd: dir, tools: ["delegate_probe"], model: "fixture/model", executionTimeoutMs: 10_000 },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("completed");
    expect(fs.existsSync(path.join(dir, "omitted-ran"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "nested-result"), "utf8")).toContain('"isError":true');
    expect(JSON.stringify(result.output)).toContain("NESTED_OK");
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("late tools can use the startup budget beyond the old ten-second ceiling", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-slow-start-"));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    fs.writeFileSync(path.join(dir, "slow.ts"), `import { setTimeout as delay } from "node:timers/promises";
export default (pi: any) => {
  pi.on("session_start", async () => {
    await delay(1500);
    setTimeout(() => pi.registerTool({ name: "slow_tool", label: "slow", description: "late", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "late" }] }) }), 11000);
  });
}`);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "slow.ts")] }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const result = await new RpcChildSupervisor().run({
      task: { id: "slow-start", prompt: "say OK", cwd: dir, tools: ["slow_tool"], model: "fixture/model", executionTimeoutMs: 10_000, startupTimeoutMs: 15_000 },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("completed");
    expect(result.output).toContain("OK");
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("refuses to resume a real session in a different workspace", async () => {
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-cwd-a-"));
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-cwd-b-"));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(firstDir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    process.env.PI_CODING_AGENT_DIR = firstDir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const supervisor = new RpcChildSupervisor();
    const first = await supervisor.run({
      task: { id: "cwd-a", prompt: "first", cwd: firstDir, tools: [], model: "fixture/model", persist: true, executionTimeoutMs: 10_000 },
      signal: new AbortController().signal,
    });
    expect(first.outcome).toBe("completed");
    const second = await supervisor.run({
      task: { id: "cwd-b", prompt: "second", cwd: secondDir, tools: [], model: "fixture/model", resume: first.sessionFile, executionTimeoutMs: 10_000 },
      signal: new AbortController().signal,
    });
    expect(second.outcome).toBe("failed");
    expect(second.errorKind).toBe("startup");
    expect(second.errorMessage).toContain("does not match requested cwd");
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(firstDir, { recursive: true, force: true });
    fs.rmSync(secondDir, { recursive: true, force: true });
  }
}, 30_000);
