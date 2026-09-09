import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Keep the RPC parent alive after its first turn. Release the child only after
// agent_end, proving completion starts a new parent turn without status polling.
test("real Pi background completion wakes an idle RPC parent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-children-background-"));
  const parentIdle = Promise.withResolvers<void>();
  const notified = Promise.withResolvers<any>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      const parent = (body.tools ?? []).some((tool: any) => tool.function.name === "subagent");
      const notice = JSON.stringify(body.messages).includes("Background child finished.");
      let delta: any;
      let finish = "stop";
      if (!parent) {
        await parentIdle.promise;
        delta = { content: "BACKGROUND_RESULT" };
      } else if (notice) {
        notified.resolve(body);
        delta = { content: "NOTICE_RECEIVED" };
      } else if (body.messages.some((message: any) => message.role === "tool")) {
        delta = { content: "PARENT_IDLE" };
      } else {
        delta = { tool_calls: [{ index: 0, id: "spawn_call", type: "function", function: {
          name: "subagent", arguments: JSON.stringify({ command: "spawn", prompt: "Complete this independent background task.", tools: [] }),
        } }] };
        finish = "tool_calls";
      }
      const chunk = (value: any, finish_reason: string | null) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const cli = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const invocation = process.env.PI_CHILD_TEST_CLI ? [process.env.PI_CHILD_TEST_CLI] : ["node", cli];
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "model" }],
  } } }));
  const proc = Bun.spawn([...invocation, "--mode", "rpc", "--no-session", "--extension", path.resolve(import.meta.dir, "../extensions/pi-subagents/index.ts"), "--tools", "read,subagent", "--model", "fixture/model"], {
    cwd: dir,
    env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENT_TIMEOUT_MS: "15000" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  let output = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (output.includes('"type":"agent_end"')) parentIdle.resolve();
    }
  })();
  const deadline = setTimeout(() => { notified.reject(new Error(`Background notice did not reach parent. Output tail: ${output.slice(-2000)}`)); proc.kill(); }, 20000);
  try {
    proc.stdin.write(JSON.stringify({ type: "prompt", message: "Delegate a background task, then finish your turn without waiting." }) + "\n");
    const body = await notified.promise;
    expect(JSON.stringify(body.messages)).toContain("BACKGROUND_RESULT");
    expect(output).toContain("PARENT_IDLE");
    expect(output).toContain('"type":"agent_end"');
  } finally {
    clearTimeout(deadline);
    parentIdle.resolve();
    proc.stdin.end();
    const kill = setTimeout(() => proc.kill(), 2000);
    await proc.exited;
    clearTimeout(kill);
    await reading;
    const errors = await stderr;
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(errors).toBe("");
  }
}, 30000);
