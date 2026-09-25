import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A real Pi parent invokes this extension, which launches a real Pi child.
// Only the model HTTP endpoint is fake: no provider credentials or network services are needed.
test.each([false, true])("real Pi CLI delegates and accounts child usage, including failure: %s", async (fails) => {
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
        ? { content: parent ? "PARENT_SMOKE_OK" : fails ? "" : "CHILD_SMOKE_OK" }
        : { tool_calls: [{ index: 0, id: parent ? "parent_call" : "child_call", type: "function", function: {
          name: parent ? "subagent" : "read",
          arguments: JSON.stringify(parent
            ? { command: "run", prompt: "CHILD_TASK_ONLY: Read fixture.txt and report its content.", tools: ["read"] }
            : { path: "fixture.txt" }),
        } }] };
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta: part, finish_reason }],
        usage: finish_reason ? { prompt_tokens: parent ? 10 : 20, completion_tokens: parent ? 2 : 3, total_tokens: parent ? 12 : 23 } : undefined,
      })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, returned ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    fs.writeFileSync(path.join(dir, "fixture.txt"), "FILE_SENTINEL");
    // A child research tool may itself make paid model calls. Its usage must
    // flow through the child protocol and into the parent's native usage field.
    const usageExtension = path.join(dir, "usage.ts");
    fs.writeFileSync(usageExtension, `export default function (pi) {
      pi.on("tool_result", (event) => event.toolName === "read" ? { usage: {
        input: 7, output: 11, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 }
      } } : undefined);
    }`);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [usageExtension] }));
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "model", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    const cli = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const invocation = process.env.PI_CHILD_TEST_CLI ? [process.env.PI_CHILD_TEST_CLI] : ["node", cli];
    const extension = process.env.PI_CHILD_TEST_EXTENSION ?? path.resolve(import.meta.dir, "../extensions/pi-subagents/index.ts");
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
    expect(JSON.stringify(requests.at(-1).messages)).toContain(fails ? "terminal assistant output" : "CHILD_SMOKE_OK");
    const events = out.trim().split("\n").map((line) => JSON.parse(line));
    const delegated = events.find((event) => event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "subagent");
    expect(delegated.message.isError).toBe(fails);
    expect(delegated.message.usage).toMatchObject({ input: 47, output: 17, totalTokens: 64, cost: { total: 0.5 } });
  } finally {
    proc?.kill();
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("real Pi scheduler launches sibling runs and independent tools concurrently", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-children-parallel-"));
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push(body);
      const returned = body.messages.some((message: any) => message.role === "tool");
      const calls = Array.from({ length: 5 }, (_, i) => ({ index: i, id: `run_${i}`, type: "function", function: {
        name: "subagent", arguments: JSON.stringify({ command: "run", prompt: `task${i}`, tools: [] }),
      } }));
      calls.push({ index: 5, id: "probe", type: "function", function: { name: "probe", arguments: "{}" } });
      const delta = returned ? { content: "PARALLEL_OK" } : { tool_calls: calls };
      const chunk = (part: any, finish_reason: string | null) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 0, model: "model", choices: [{ index: 0, delta: part, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, returned ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const runner = path.join(dir, "runner.mjs");
    fs.writeFileSync(runner, `import {writeFileSync, existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {writeSync} from 'node:fs';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
const send=event=>writeSync(3,JSON.stringify({version:2,...event})+'\\n');
send({kind:'ready',model:request.model,thinking:'off',tools:[]});
writeFileSync(request.prompt, 'started');
const until=Date.now()+5000;
while ((!existsSync('probe-ran') || !['task0','task1','task2','task3'].every(existsSync)) && Date.now()<until) await delay(10);
if (!existsSync('probe-ran') || !['task0','task1','task2','task3'].every(existsSync)) {
  send({kind:'error',errorMessage:'sibling calls were serialized'}); process.exit(1);
}
send({kind:'result', report:{output:request.prompt,stopReason:'stop',outputTruncation:{truncated:false,originalBytes:5,retainedBytes:5}},
usage:{input:1,output:0,cacheRead:0,cacheWrite:0,totalTokens:1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},turns:1}});
`);
    const probe = path.join(dir, "probe.ts");
    fs.writeFileSync(probe, `import {writeFileSync} from 'node:fs';
export default pi=>pi.registerTool({name:'probe',label:'probe',description:'test',executionMode:'parallel',parameters:{type:'object',properties:{}},
execute:async()=>{writeFileSync('probe-ran','yes'); return {content:[{type:'text',text:'probe done'}]};}});`);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [probe], toolExecution: "parallel" }));
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "test-only", models: [{ id: "model" }],
    } } }));
    const cli = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const extension = path.resolve(import.meta.dir, "../extensions/pi-subagents/index.ts");
    const child = Bun.spawn(["node", cli, "--mode", "json", "-p", "--no-session", "--extension", extension, "--tools", "subagent,probe", "--model", "fixture/model", "delegate"], {
      cwd: dir, env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENT_RUNNER: runner, PI_SUBAGENT_TIMEOUT_MS: "10000" },
      stdout: "pipe", stderr: "pipe",
    });
    proc = child;
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    deadline = setTimeout(() => proc?.kill(), 20000);
    const exit = await proc.exited;
    const out = await stdout; const err = await stderr;
    expect({ exit, stderr: err }).toEqual({ exit: 0, stderr: "" });
    expect(out).toContain("PARALLEL_OK");
    expect(requests).toHaveLength(2);
    const results = requests[1].messages.filter((message: any) => message.role === "tool");
    expect(results).toHaveLength(6);
    expect(JSON.stringify(results)).toContain("maximum 4");
    expect(JSON.stringify(results)).not.toContain("serialized");
    expect(fs.existsSync(path.join(dir, "task4"))).toBe(false);
    const events = out.trim().split("\n").map((line) => JSON.parse(line));
    const messages = events.filter((event) => event.type === "message_end" && event.message.role === "toolResult").map((event) => event.message);
    expect(messages.filter((message) => message.isError)).toHaveLength(1);
    expect(messages.reduce((sum, message) => sum + (message.usage?.input ?? 0), 0)).toBe(4);
    expect(out).not.toContain('"customType":"subagent-complete"');
  } finally {
    clearTimeout(deadline);
    proc?.kill();
    if (proc) await proc.exited;
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
