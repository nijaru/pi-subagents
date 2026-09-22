import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { getChildInvocation } from "../extensions/pi-subagents/subprocess.ts";
import { parseChildEvent, type ChildBootstrap, type ChildEvent } from "../extensions/pi-subagents/child-protocol.ts";

let dir: string;
let packedRunner: string;
const provider = `
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';
export default function(pi) {
  let attempts = 0;
  pi.registerCommand('literal', { description: 'must not execute', handler() { throw new Error('SLASH_EXECUTED'); } });
  pi.on('session_start', () => {
    pi.registerTool({ name: 'dynamic_test', label: 'dynamic', description: 'test tool', parameters: { type: 'object', properties: {} },
      execute: async () => ({content: [{type:'text', text:'tool result'}]}) });
    console.log('STDOUT_DIAGNOSTIC');
    console.error('STDERR_DIAGNOSTIC');
  });
  pi.registerProvider('fixture', {
    api: 'fixture-api', baseUrl: 'http://unused', apiKey: 'test',
    models: [{ id:'model', name:'model', reasoning:true, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:128000, maxTokens:4096 }],
    streamSimple(model, context) {
      writeFileSync(process.cwd() + '/provider-called', 'yes');
      const input = context.messages.find(m => m.role === 'user');
      const text = typeof input.content === 'string' ? input.content : input.content.map(p => p.text ?? '').join('');
      const names = getCurrentTools(context.messages).map(t => t.name);
      const stream = createAssistantMessageEventStream();
      const retryError = text === 'retry' && attempts++ === 0;
      const output = {
        role:'assistant', api:model.api, provider:model.provider, model:model.id, timestamp:Date.now(),
        usage:{input:3,output:2,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        content:[{type:'thinking',thinking:'X'.repeat(2000000),thinkingSignature:'Y'.repeat(2000000)},
          {type:'text',text:text === 'huge' ? '😀'.repeat(100000) : JSON.stringify({text,names})}],
        stopReason:retryError ? 'error' : text === 'length' ? 'length' : 'stop',
        ...(retryError ? {errorMessage:'503 service unavailable'} : {})
      };
      queueMicrotask(() => {
        stream.push(retryError ? {type:'error',reason:'error',error:output} : {type:'done',reason:output.stopReason,message:output});
        stream.end();
      });
      return stream;
    }
  });
}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-sdk-protocol-"));
  writeFileSync(join(dir, "provider.ts"), provider);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [join(dir, "provider.ts")], retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
  // Real packed artifact, deliberately extracted beneath node_modules where native
  // Node TS stripping is forbidden. Bootstrap must supply its own TS loader.
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: resolve(import.meta.dir, ".."), encoding: "utf8" });
  if (pack.status !== 0) throw new Error(pack.stderr);
  const archive = (Object.values(JSON.parse(pack.stdout))[0] as { filename: string }).filename;
  const extracted = join(dir, "node_modules", "packed-subagents");
  mkdirSync(extracted, { recursive: true });
  const tar = spawnSync("tar", ["-xf", join(dir, archive), "-C", extracted, "--strip-components=1"]);
  if (tar.status !== 0) throw new Error("pack extraction failed");
  packedRunner = join(extracted, "extensions/pi-subagents/child-bootstrap.mjs");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(overrides: Partial<ChildBootstrap> = {}, packed = false) {
  rmSync(join(dir, "provider-called"), { force: true });
  const invocation = getChildInvocation();
  const child = spawn("node", [packed ? packedRunner : invocation.args[0]!, invocation.args[1]!], {
    cwd: dir, env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENT_DEPTH: "1" },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const read = async (stream: Readable) => { stream.setEncoding("utf8"); let text = ""; for await (const chunk of stream) text += chunk; return text; };
  const stdout = read(child.stdout!);
  const stderr = read(child.stderr!);
  const protocol = read(child.stdio[3] as Readable);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
  child.stdin!.end(JSON.stringify({ version: 1, prompt: "/literal unchanged", tools: [], model: "fixture/model", ...overrides }));
  const code = await new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  clearTimeout(deadline);
  const wire = await protocol;
  const events: ChildEvent[] = wire.trim() ? wire.trim().split("\n").map(parseChildEvent) : [];
  return { code, events, stdout: await stdout, stderr: await stderr, wire };
}

test.each([false, true])("real SDK and packed SDK runner keep prompts literal and diagnostics separate (packed=%s)", async (packed) => {
  const result = await run({}, packed);
  expect(result.stderr).not.toContain("Error");
  expect(result.code).toBe(0);
  expect(result.events[0]).toEqual({ version: 1, kind: "ready", model: "fixture/model", tools: [] });
  expect(result.events.at(-1)).toMatchObject({ kind: "result", report: { output: JSON.stringify({ text: "/literal unchanged", names: [] }) } });
  expect(result.stdout).toContain("STDOUT_DIAGNOSTIC");
  expect(result.stderr).toContain("STDERR_DIAGNOSTIC");
  expect(result.wire.length).toBeLessThan(2000);
}, 15000);

test("session_start registered tools are verified and selected", async () => {
  const result = await run({ tools: ["dynamic_test"] });
  expect(result.code).toBe(0);
  expect(result.events.at(-1)).toMatchObject({ report: { output: JSON.stringify({ text: "/literal unchanged", names: ["dynamic_test"] }) } });
});

test.each([{ tools: ["runtime_only_missing"] }, { model: "fixture/missing" }])("missing tools/model fail before provider task: %j", async (request) => {
  const result = await run({ ...request, tools: request.tools ? [...request.tools] : [] });
  expect(result.code).toBe(1);
  expect(result.events.at(-1)?.kind).toBe("error");
  expect(existsSync(join(dir, "provider-called"))).toBe(false);
});

test("successful SDK retry clears earlier assistant failure and counts both attempts", async () => {
  const result = await run({ prompt: "retry" });
  expect(result.code).toBe(0);
  expect(result.events.at(-1)).toMatchObject({ kind: "result", report: { stopReason: "stop" }, usage: { turns: 2, input: 6 } });
  expect((result.events.at(-1) as any).report.errorMessage).toBeUndefined();
});

test("SDK length termination and oversized final output stay explicit", async () => {
  const length = await run({ prompt: "length" });
  expect(length.events.at(-1)).toMatchObject({ report: { stopReason: "length" } });
  const huge = await run({ prompt: "huge" });
  expect(huge.events.at(-1)).toMatchObject({ report: { outputTruncation: { truncated: true, originalBytes: 400000 } } });
});
