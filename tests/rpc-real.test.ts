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

test("real RPC child fails before prompting when a requested tool does not load", async () => {
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
        tools: ["definitely_missing"], model: "fixture/model", executionTimeoutMs: 5_000, startupTimeoutMs: 8_000,
      },
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("failed");
    expect(result.errorKind).toBe("startup");
    expect(result.errorMessage).toContain("unavailable");
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
  } finally {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
