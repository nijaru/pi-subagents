import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Delta = { content?: string; reasoning_content?: string; tool_calls?: unknown[] };

/** Isolate a real Pi CLI from live providers; only its HTTP endpoint is fake. */
export function realRpcFixture(respond: (body: any) => Delta | Promise<Delta> = () => ({ content: "OK" })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-real-"));
  const saved = { ...process.env };
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push(body);
      const delta = await respond(body);
      const chunk = (part: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, delta.tool_calls ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const dispose = () => {
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_SUBAGENT_SESSION_DIR = path.join(dir, "sessions");
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    return { dir, requests, [Symbol.dispose]: dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
