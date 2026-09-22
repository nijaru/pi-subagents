import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Hold the parent's next model response until its real child has completed.
// A read-only tool probe supplies that barrier without consuming the report.
// This reproduces the completion-before-wait race against Pi's actual queues.
test.each(["wait", "unread", "batch"])("real Pi delivers completed children once: %s", async (mode) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-delivery-"));
  const expectedChildren = mode === "batch" ? 2 : 1;
  let parentRequests = 0;
  const requests: any[] = [];
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      const parent = (body.tools ?? []).some((tool: any) => tool.function.name === "subagent");
      const call = (id: string, name: string, args: any, index = 0) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
      let delta: any;
      let finish = "stop";
      if (!parent) {
        delta = { content: "CHILD_REPORT" };
      } else {
        parentRequests++;
        requests.push(body);
        if (parentRequests === 1) {
          delta = { tool_calls: Array.from({ length: expectedChildren }, (_, i) => call(`spawn_${i}`, "subagent", { command: "spawn", prompt: `Independent child ${i}`, tools: [] }, i)) };
          finish = "tool_calls";
        } else if (parentRequests === 2) {
          const deadline = Date.now() + 15000;
          let ids: string[] = [];
          while (Date.now() < deadline) {
            ids = fs.readdirSync(dir).filter((name) => name.startsWith("completed-")).map((name) => name.slice("completed-".length));
            if (ids.length === expectedChildren) break;
            await Bun.sleep(10);
          }
          if (ids.length !== expectedChildren) throw new Error("Child completion barrier timed out");
          delta = { tool_calls: [mode === "wait"
            ? call("wait_call", "subagent", { command: "wait", id: ids[0] })
            : call("read_call", "read", { path: "fixture.txt" })] };
          finish = "tool_calls";
        } else delta = { content: parentRequests === 3 ? "PARENT_DONE" : "REDUNDANT_NOTICE" };
      }
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta: part, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    fs.writeFileSync(path.join(dir, "fixture.txt"), "parent work");
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "model" }],
    } } }));
    const wrapper = path.join(dir, "wrapper.ts");
    const extension = process.env.PI_CHILD_TEST_EXTENSION ?? path.resolve(import.meta.dir, "../extensions/pi-subagents/index.ts");
    fs.writeFileSync(wrapper, `import extension from ${JSON.stringify(extension)};
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
  let tool;
  const timers = new Set();
  extension(new Proxy(pi, { get(target, name) {
    if (name === "registerTool") return (definition) => { tool = definition; pi.registerTool(definition); };
    return Reflect.get(target, name);
  } }));
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "subagent" || event.input.command !== "spawn" || event.isError) return;
    const id = event.details.results[0].id;
    const timer = setInterval(async () => {
      const result = await tool.execute("probe", {command:"status",id}, undefined, undefined, ctx);
      if (result.details.results[0].state.status !== "terminal") return;
      clearInterval(timer); timers.delete(timer);
      writeFileSync(join(ctx.cwd, "completed-" + id), "ready");
    }, 10);
    timers.add(timer);
  });
  pi.on("session_shutdown", () => { for (const timer of timers) clearInterval(timer); });
}`);
    const cli = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const invocation = process.env.PI_CHILD_TEST_CLI ? [process.env.PI_CHILD_TEST_CLI] : ["node", cli];
    const child = Bun.spawn([...invocation, "--mode", "json", "-p", "--no-session", "--extension", wrapper, "--tools", "read,subagent", "--model", "fixture/model", "Delegate independent work and incorporate each result once."], {
      cwd: dir,
      env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENT_TIMEOUT_MS: "15000" },
      stdout: "pipe", stderr: "pipe",
    });
    proc = child;
    const output = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const deadline = setTimeout(() => proc?.kill(), 25000);
    const exit = await proc.exited;
    clearTimeout(deadline);
    const out = await output;
    expect({ exit, stderr: await stderr }).toEqual({ exit: 0, stderr: "" });
    expect(parentRequests).toBe(3);
    expect(out).toContain("PARENT_DONE");
    expect(out).not.toContain("REDUNDANT_NOTICE");
    expect(JSON.stringify(requests[2].messages)).toContain("CHILD_REPORT");
    const events = out.trim().split("\n").map((line) => JSON.parse(line));
    const notices = events.filter((event) => event.type === "entry_appended" && event.entry.type === "custom_message" && event.entry.customType === "subagent-complete");
    expect(notices).toHaveLength(mode === "wait" ? 0 : 1);
    if (mode !== "wait") expect(notices[0].entry.details.results).toHaveLength(expectedChildren);
    expect(out).not.toContain('"type":"queue_update","steering":[],"followUp":[{"role":"custom","customType":"subagent-complete"');
  } finally {
    proc?.kill();
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
