import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A real Pi parent invokes this extension, which launches a real Pi child.
// Only the model HTTP endpoint is fake: no provider credentials or network services are needed.
test("real Pi CLI delegates, narrows tools, executes a child read and returns its result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-children-cli-"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push(body);
      const names = (body.tools ?? []).map((tool: any) => tool.function.name);
      const parent = names.includes("subagent");
      const returned = body.messages.some((message: any) => message.role === "tool");
      const delta = returned
        ? { content: parent ? "PARENT_SMOKE_OK" : "CHILD_SMOKE_OK" }
        : { tool_calls: [{ index: 0, id: parent ? "parent_call" : "child_call", type: "function", function: {
          name: parent ? "subagent" : "read",
          arguments: JSON.stringify(parent
            ? { command: "run", prompt: "CHILD_TASK_ONLY: Read fixture.txt and report its content.", tools: ["read"] }
            : { path: "fixture.txt" }),
        } }] };
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta: part, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, returned ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    fs.writeFileSync(path.join(dir, "fixture.txt"), "FILE_SENTINEL");
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    const cli = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const invocation = process.env.PI_CHILD_TEST_CLI ? [process.env.PI_CHILD_TEST_CLI] : ["node", cli];
    const extension = path.resolve(import.meta.dir, "../extensions/pi-subagents/index.ts");
    const child = Bun.spawn([...invocation, "--mode", "json", "-p", "--no-session", "--extension", extension, "--tools", "read,subagent", "--model", "fixture/model", "PARENT_HISTORY_SECRET: delegate the bounded task."], {
      cwd: dir,
      env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENT_TIMEOUT_MS: "15000" },
      stdout: "pipe", stderr: "pipe",
    });
    proc = child;
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const deadline = setTimeout(() => proc?.kill(), 25000);
    const exit = await proc.exited;
    clearTimeout(deadline);
    const out = await stdout;
    const err = await stderr;
    expect({ exit, stderr: err }).toEqual({ exit: 0, stderr: "" });
    expect(out).toContain("PARENT_SMOKE_OK");
    expect(requests).toHaveLength(4);
    const childRequests = requests.filter((request) => !request.tools.some((tool: any) => tool.function.name === "subagent"));
    expect(childRequests).toHaveLength(2);
    expect(childRequests[0].tools.map((tool: any) => tool.function.name)).toEqual(["read"]);
    expect(JSON.stringify(childRequests[0].messages)).toContain("CHILD_TASK_ONLY");
    expect(JSON.stringify(childRequests[0].messages)).not.toContain("PARENT_HISTORY_SECRET");
    expect(JSON.stringify(childRequests[1].messages)).toContain("FILE_SENTINEL");
    expect(JSON.stringify(requests.at(-1).messages)).toContain("CHILD_SMOKE_OK");
  } finally {
    proc?.kill();
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
