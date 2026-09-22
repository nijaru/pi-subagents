import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Release the child only after settlement, including an invisible late abort.
// A test-only command inspects completion without a provider request or a join.
test.each([
  { lateAbort: false, followUpTool: false },
  { lateAbort: false, followUpTool: true },
  { lateAbort: true, followUpTool: false },
  { lateAbort: true, followUpTool: true },
])("real Pi keeps idle completions unread until a natural turn: %j", async ({ lateAbort, followUpTool }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-children-background-"));
  const parentIdle = Promise.withResolvers<void>();
  const notified = Promise.withResolvers<any>();
  let parentRequests = 0;
  const finished = Promise.withResolvers<void>();
  const stats = Promise.withResolvers<any>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      const parent = (body.tools ?? []).some((tool: any) => tool.function.name === "subagent");
      const notice = JSON.stringify(body.messages).includes("Background child finished.");
      if (parent) parentRequests++;
      let delta: any;
      let finish = "stop";
      if (!parent) {
        await parentIdle.promise;
        delta = { content: "BACKGROUND_RESULT" };
      } else if (notice) {
        notified.resolve(body);
        if (followUpTool && !body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "read_call")) {
          delta = { tool_calls: [{ index: 0, id: "read_call", type: "function", function: {
            name: "read", arguments: JSON.stringify({ path: "fixture.txt" }),
          } }] };
          finish = "tool_calls";
        } else delta = { content: "NOTICE_RECEIVED" };
      } else if (body.messages.some((message: any) => message.role === "tool")) {
        delta = { content: "PARENT_IDLE" };
      } else {
        delta = { tool_calls: [{ index: 0, id: "spawn_call", type: "function", function: {
          name: "subagent", arguments: JSON.stringify({ command: "spawn", prompt: "Complete this independent background task.", tools: [] }),
        } }] };
        finish = "tool_calls";
      }
      const chunk = (value: any, finish_reason: string | null) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta: value, finish_reason }],
        usage: finish_reason ? { prompt_tokens: parent ? 0 : 20, completion_tokens: parent ? 0 : 3, total_tokens: parent ? 0 : 23 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const cli = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const invocation = process.env.PI_CHILD_TEST_CLI ? [process.env.PI_CHILD_TEST_CLI] : ["node", cli];
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "model" }],
  } } }));
  fs.writeFileSync(path.join(dir, "fixture.txt"), "A follow-up tool unrelated to subagent.");
  const extension = process.env.PI_CHILD_TEST_EXTENSION ?? path.resolve(import.meta.dir, "../extensions/pi-subagents/index.ts");
  const wrapper = path.join(dir, "wrapper.ts");
  const readyFile = path.join(dir, "child-ready.json");
  fs.writeFileSync(wrapper, `import extension from ${JSON.stringify(extension)};
import {writeFileSync, renameSync} from "node:fs";
export default function(pi) {
  let tool;
  extension({...pi, registerTool(value) { tool = value; pi.registerTool(value); }});
  let aborted = false;
  pi.on("agent_before_settle", (_event, ctx) => {
    if (${lateAbort} && !aborted) { aborted = true; ctx.abort(); }
  });
  pi.registerCommand("await-child", {description:"Test probe", handler:async (_args, ctx) => {
    let result;
    const deadline = Date.now() + 10000;
    do {
      result = await tool.execute("probe", {command:"status"}, undefined, undefined, ctx);
      if (result.details.results[0]?.state.status === "terminal") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    writeFileSync(${JSON.stringify(readyFile + ".tmp")}, JSON.stringify(result));
    renameSync(${JSON.stringify(readyFile + ".tmp")}, ${JSON.stringify(readyFile)});
  }});
}`);
  const proc = Bun.spawn([...invocation, "--mode", "rpc", "--no-session", "--extension", wrapper, "--tools", "read,subagent", "--model", "fixture/model"], {
    cwd: dir,
    env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENT_TIMEOUT_MS: "15000" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  let output = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const event = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (event.type === "agent_settled") {
          parentIdle.resolve();
          if (output.includes("NOTICE_RECEIVED")) finished.resolve();
        }
        if (event.type === "response" && event.id === "stats") stats.resolve(event.data);
      }
    }
  })();
  const timeout = Promise.withResolvers<never>();
  const deadline = setTimeout(() => { timeout.reject(new Error(`Background test timed out. Output tail: ${output.slice(-2000)}`)); proc.kill(); }, 20000);
  try {
    proc.stdin.write(JSON.stringify({ type: "prompt", message: "Delegate a background task, then finish your turn without waiting." }) + "\n");
    await Promise.race([parentIdle.promise, timeout.promise]);
    proc.stdin.write(JSON.stringify({ type: "prompt", message: "/await-child" }) + "\n");
    const readyDeadline = Date.now() + 10000;
    while (!fs.existsSync(readyFile) && Date.now() < readyDeadline) await Bun.sleep(10);
    expect(fs.existsSync(readyFile)).toBe(true);
    const retained = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    expect(retained.details.results[0].output).toBe("BACKGROUND_RESULT");
    await Bun.sleep(100); // Give an erroneous idle wake-up time to reach the provider.
    expect(parentRequests).toBe(2);
    expect(output).not.toContain("Background child finished.");
    proc.stdin.write(JSON.stringify({ type: "prompt", message: "Continue and incorporate any pending child results." }) + "\n");
    const body = await Promise.race([notified.promise, timeout.promise]);
    expect(JSON.stringify(body.messages)).toContain("BACKGROUND_RESULT");
    expect(output).toContain("PARENT_IDLE");
    expect(output).toContain('"type":"agent_end"');
    await Promise.race([finished.promise, timeout.promise]);
    proc.stdin.write(JSON.stringify({ id: "stats", type: "get_session_stats" }) + "\n");
    const totals = await Promise.race([stats.promise, timeout.promise]);
    expect(totals.tokens.input).toBe(followUpTool ? 20 : 0);
    expect(totals.tokens.output).toBe(followUpTool ? 3 : 0);
    expect(totals.tokens.total).toBe(followUpTool ? 23 : 0);
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
