import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { zstdDecompressSync } from "node:zlib";

// A real Pi parent, a real RPC child, and only the model HTTP endpoint faked.
test.each(([
  ["openai-completions", "run", true], ["openai-completions", "spawn", true],
  ["openai-responses", "run", true], ["openai-responses", "spawn", true],
  ["openai-codex-responses", "run", true], ["openai-codex-responses", "spawn", true],
  ["openai-completions", "run", false],
] as const).map(([api, mode, supportsStrictMode]) => ({ api, mode, supportsStrictMode })))("real Pi $api parent delegates with $mode (strict supported: $supportsStrictMode)", async ({ api, mode, supportsStrictMode }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-parent-"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const bytes = Buffer.from(await request.arrayBuffer());
      const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString()) as any;
      requests.push(body);
      const messages = body.messages ?? body.input;
      const isToolResult = (message: any) => message.role === "tool" || message.type === "function_call_output";
      const isParent = JSON.stringify(messages).includes("PARENT_SENTINEL");
      const isChild = JSON.stringify(messages).includes("CHILD_SENTINEL");
      const returned = messages.some(isToolResult);
      const tool = body.tools?.map((tool: any) => tool.function ?? tool).find((tool: any) => tool.name === "subagent");
      // Strict OpenAI tools require all optional fields as null. Exercise the
      // real host's nullable-argument normalization, not a hand-written shim.
      const args = (input: any) => JSON.stringify({
        ...Object.fromEntries(Object.keys(tool?.parameters.properties ?? {}).map((key) => [key, null])), ...input,
      });
      let delta: any;
      if (isParent && !returned) {
        delta = { tool_calls: [{ index: 0, id: "parent_subagent", type: "function", function: {
          name: "subagent",
          arguments: args({ command: mode, label: "fixture review", prompt: "/capture CHILD_SENTINEL: read fixture.txt and report it.", tools: ["read"] }),
        } }] };
      } else if (isParent) {
        const text = JSON.stringify(messages);
        if (mode === "run" || messages.some((message: any) => isToolResult(message) && JSON.stringify(message.content ?? message.output).includes("CHILD_OK"))) {
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
            name: "subagent", arguments: args(announced ? { command: "wait", ids: [handle] } : { command: "status", id: handle }),
          } }] };
        }
      } else if (isChild && !returned) {
        delta = { tool_calls: [{ index: 0, id: "child_read", type: "function", function: {
          name: "read", arguments: JSON.stringify({ path: "fixture.txt" }),
        } }] };
      } else {
        delta = { content: "CHILD_OK" };
      }
      if (api !== "openai-completions") {
        const items = delta.tool_calls
          ? delta.tool_calls.map((call: any) => ({ id: `fc_${call.id}`, type: "function_call", status: "completed", call_id: call.id, name: call.function.name, arguments: call.function.arguments }))
          : [{ id: "msg_answer", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: delta.content, annotations: [] }] }];
        const response = { id: `resp_${requests.length}`, model: "model", status: "completed", output: items,
          usage: { input_tokens: isParent ? 10 : 20, output_tokens: 2, total_tokens: isParent ? 12 : 22 } };
        const events = [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          ...items.flatMap((item: any, output_index: number) => [
            { type: "response.output_item.added", output_index, item: { ...item, status: "in_progress", ...(item.type === "function_call" ? { arguments: "" } : { content: [] }) } },
            { type: "response.output_item.done", output_index, item },
          ]),
          { type: "response.completed", response },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
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
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "capture.ts")], transport: "sse", cacheWarming: "off" }));
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api,
      apiKey: api === "openai-codex-responses" ? `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture` : "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024, compat: { supportsStrictMode } }],
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
      // This subprocess plays the parent, even when tests run in a Pi child.
      env: { ...process.env, PI_SUBAGENT_DEPTH: "0" },
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
    expect(delegated.message.details.results[0].label).toBe("fixture review");
    const declaration = requests[0].tools.map((tool: any) => tool.function ?? tool).find((tool: any) => tool.name === "subagent");
    expect(declaration.strict).toBe(supportsStrictMode ? true : undefined);
    expect(declaration.parameters.required).toEqual(supportsStrictMode ? Object.keys(declaration.parameters.properties) : ["command"]);
    expect(declaration.parameters.additionalProperties).toBe(false);
    if (supportsStrictMode) expect(declaration.parameters.properties.prompt.anyOf).toContainEqual({ type: "null" });
    expect(JSON.stringify(declaration.parameters)).not.toMatch(/"(?:minLength|maxLength|uniqueItems|pattern|minimum|maximum|minItems|maxItems)":/);
    const billedInput = events.filter((event) => event.type === "message_end" && event.message.role === "toolResult")
      .reduce((sum, event) => sum + (event.message.usage?.input ?? 0), 0);
    expect(billedInput).toBe(40); // Two child calls, charged once regardless of retrieval.
    // Structured results belong to execution events; transcript tool messages
    // intentionally retain only content/details/usage on the host.
    const execution = events.find((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
    expect(execution.result.structuredContent).toEqual(execution.result.details);
    if (mode === "run") expect(JSON.stringify(delegated.message)).toContain("CHILD_OK");
    else expect(delegated.message.details.command).toBe("spawn");
    if (mode === "run") expect(requests).toHaveLength(4);
    else {
      const announced = requests.find((request) => JSON.stringify(request.messages ?? request.input).includes("Child results ready:"));
      expect(announced).toBeDefined();
      expect(JSON.stringify(announced.messages ?? announced.input)).not.toContain("CHILD_OK");
      const reports = events.filter((event) => event.type === "message_end" && event.message.role === "toolResult" && event.message.details?.command === "wait");
      expect(reports).toHaveLength(1);
      expect(reports[0].message.details.results[0].state.outcome).toBe("completed");
    }
    const childRequests = requests.filter((request) => request.tools.length === 1 && (request.tools[0].function ?? request.tools[0]).name === "read");
    expect(childRequests).toHaveLength(2);
    expect(childRequests[0].tools.map((tool: any) => (tool.function ?? tool).name)).toEqual(["read"]);
    const firstChildInput = JSON.stringify(childRequests[0].messages ?? childRequests[0].input);
    expect(firstChildInput).not.toContain("PARENT_SENTINEL");
    expect(JSON.stringify(childRequests[1].messages ?? childRequests[1].input)).toContain("FILE_SENTINEL");
    expect(fs.existsSync(path.join(dir, "command-ran"))).toBe(false);
    expect(firstChildInput).toContain("/capture CHILD_SENTINEL");
    expect(firstChildInput).not.toContain("subagent-probe");
    expect(firstChildInput).not.toContain('"token"');
  } finally {
    proc?.kill();
    server.stop(true);
    Object.assign(process.env, saved);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
