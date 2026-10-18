import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A real Pi parent, a real RPC child, and only the model HTTP endpoint faked.
test.each(["run", "spawn"] as const)("real Pi parent delegates with %s and retrieves the report explicitly", async (mode) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-parent-"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push(body);
      const isParent = JSON.stringify(body.messages).includes("PARENT_SENTINEL");
      const isChild = JSON.stringify(body.messages).includes("CHILD_SENTINEL");
      const returned = body.messages.some((message: any) => message.role === "tool");
      let delta: any;
      if (isParent && !returned) {
        delta = { tool_calls: [{ index: 0, id: "parent_subagent", type: "function", function: {
          name: "subagent",
          arguments: JSON.stringify({ command: mode, notify: "turn", prompt: "/capture CHILD_SENTINEL: read fixture.txt and report it.", tools: ["read"] }),
        } }] };
      } else if (isParent) {
        const text = JSON.stringify(body.messages);
        if (mode === "run" || body.messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("CHILD_OK"))) {
          delta = { content: "PARENT_OK" };
        } else {
          const handle = /Started child (sa-\d+)/.exec(text)?.[1];
          if (!handle) throw new Error("Spawn did not expose a handle.");
          const announced = text.includes("Child results ready:");
          // Keep the parent active through public status snapshots until the
          // child settles. The continuation notice must then cause an explicit
          // wait, not silently deliver or acknowledge the report.
          if (!announced) await Bun.sleep(20);
          delta = { tool_calls: [{ index: 0, id: `parent_${requests.length}`, type: "function", function: {
            name: "subagent", arguments: JSON.stringify(announced ? { command: "wait", ids: [handle] } : { command: "status", id: handle }),
          } }] };
        }
      } else if (isChild && !returned) {
        delta = { tool_calls: [{ index: 0, id: "child_read", type: "function", function: {
          name: "read", arguments: JSON.stringify({ path: "fixture.txt" }),
        } }] };
      } else {
        delta = { content: "CHILD_OK" };
      }
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "model",
        choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: isParent ? 10 : 20, completion_tokens: 2, total_tokens: isParent ? 12 : 22 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, delta.tool_calls ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(dir, "fixture.txt"), "FILE_SENTINEL");
    fs.writeFileSync(path.join(dir, "capture.ts"), `import { writeFileSync } from "node:fs";
export default (pi: any) => pi.registerCommand("capture", { handler: async () => { writeFileSync("command-ran", "yes"); } });`);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "capture.ts")] }));
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    process.env.HOME = dir;
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    delete process.env.PI_SUBAGENT_CLI;
    const cli = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const extension = process.env.PI_SUBAGENT_TEST_EXTENSION ?? path.resolve(import.meta.dir, "../extensions/pi-subagents/index.ts");
    proc = Bun.spawn([
      "node", cli, "--mode", "json", "-p", "--no-session", "--extension", extension,
      "--tools", "subagent,read", "--model", "fixture/model",
      "PARENT_SENTINEL: delegate the bounded task.",
    ], {
      cwd: dir,
      env: process.env,
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(proc.stdout as ReadableStream).text();
    const stderr = new Response(proc.stderr as ReadableStream).text();
    const deadline = setTimeout(() => proc?.kill(), 25_000);
    const exit = await proc.exited;
    clearTimeout(deadline);
    const out = await stdout;
    const err = await stderr;
    expect({ exit, stderr: err }).toEqual({ exit: 0, stderr: "" });
    expect(out).toContain("PARENT_OK");
    expect(out).toContain("CHILD_OK");
    const events = out.trim().split("\n").map((line) => JSON.parse(line));
    const delegated = events.find((event) => event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "subagent");
    expect(delegated.message.isError).toBe(false);
    if (mode === "run") expect(JSON.stringify(delegated.message)).toContain("CHILD_OK");
    else expect(delegated.message.details.command).toBe("spawn");
    if (mode === "run") expect(requests).toHaveLength(4);
    else {
      const announced = requests.find((request) => JSON.stringify(request.messages).includes("Child results ready:"));
      expect(announced).toBeDefined();
      expect(JSON.stringify(announced.messages)).not.toContain("CHILD_OK");
      const reports = events.filter((event) => event.type === "message_end" && event.message.role === "toolResult" && event.message.details?.command === "wait");
      expect(reports).toHaveLength(1);
      expect(reports[0].message.details.results[0].state.outcome).toBe("completed");
    }
    const childRequests = requests.filter((request) => request.tools.length === 1 && request.tools[0].function.name === "read");
    expect(childRequests).toHaveLength(2);
    expect(childRequests[0].tools.map((tool: any) => tool.function.name)).toEqual(["read"]);
    expect(JSON.stringify(childRequests[0].messages)).not.toContain("PARENT_SENTINEL");
    expect(JSON.stringify(childRequests[1].messages)).toContain("FILE_SENTINEL");
    expect(fs.existsSync(path.join(dir, "command-ran"))).toBe(false);
    expect(JSON.stringify(childRequests[0].messages)).toContain("/capture CHILD_SENTINEL");
    expect(JSON.stringify(childRequests[0].messages)).not.toContain("subagent-probe");
    expect(JSON.stringify(childRequests[0].messages)).not.toContain('"token"');
  } finally {
    proc?.kill();
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
