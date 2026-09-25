import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { getChildInvocation } from "../extensions/pi-subagents/subprocess.ts";
import { CHILD_PROTOCOL_VERSION, parseChildEvent, type ChildBootstrap, type ChildEvent } from "../extensions/pi-subagents/child-protocol.ts";

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
  pi.on('session_shutdown', () => writeFileSync(process.cwd() + '/child-shutdown', 'yes'));
  pi.registerProvider('fixture', {
    api: 'fixture-api', baseUrl: 'http://unused', apiKey: 'test',
    models: [{ id:'model', name:'model', reasoning:true, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:128000, maxTokens:4096 }],
    streamSimple(model, context, options) {
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
      if (text === 'wait-for-abort') {
        const pending = setInterval(() => {}, 1000);
        const stop = () => {
          clearInterval(pending);
          stream.push({type:'error',reason:'aborted',error:{...output,stopReason:'aborted'}});
          stream.end();
        };
        if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, {once:true});
        return stream;
      }
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

async function run(overrides: Partial<ChildBootstrap> = {}, packed = false, cancel = false) {
  rmSync(join(dir, "provider-called"), { force: true });
  rmSync(join(dir, "child-shutdown"), { force: true });
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
  child.stdin!.end(JSON.stringify({ version: CHILD_PROTOCOL_VERSION, prompt: "/literal unchanged", tools: [], model: "fixture/model", ...overrides }));
  const closed = new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  if (cancel) {
    const started = Date.now() + 5000;
    while (!existsSync(join(dir, "provider-called")) && Date.now() < started) await Bun.sleep(10);
    expect(existsSync(join(dir, "provider-called"))).toBe(true);
    child.kill("SIGTERM");
  }
  const code = await closed;
  clearTimeout(deadline);
  const wire = await protocol;
  const events: ChildEvent[] = wire.trim() ? wire.trim().split("\n").map(parseChildEvent) : [];
  return { code, events, stdout: await stdout, stderr: await stderr, wire };
}

test.each([false, true])("real SDK and packed SDK runner keep prompts literal and diagnostics separate (packed=%s)", async (packed) => {
  const result = await run({}, packed);
  expect(result.stderr).not.toContain("Error");
  expect(result.code).toBe(0);
  expect(result.events[0]).toMatchObject({ version: CHILD_PROTOCOL_VERSION, kind: "ready", model: "fixture/model", tools: [] });
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

test("SDK verifies explicit effort and reports effective inherited/default effort", async () => {
  const explicit = await run({ thinking: "high", strictThinking: true });
  expect(explicit.code).toBe(0);
  expect(explicit.events[0]).toMatchObject({ kind: "ready", thinking: "high" });
  const unsupported = await run({ thinking: "max", strictThinking: true });
  expect(unsupported.code).toBe(1);
  expect(unsupported.events.at(-1)).toMatchObject({ kind: "error" });
  expect(unsupported.wire).toContain("Supported:");
  expect(existsSync(join(dir, "provider-called"))).toBe(false);
  const inherited = await run({ thinking: "max" });
  expect(inherited.code).toBe(0);
  expect(inherited.events[0]).toMatchObject({ kind: "ready", thinking: "high" });
  const settingsPath = join(dir, "settings.json");
  const previous = readFileSync(settingsPath, "utf8");
  try {
    writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(previous), modelThinkingLevels: { "fixture/model": "low" } }));
    const defaults = await run();
    expect(defaults.code).toBe(0);
    expect(defaults.events[0]).toMatchObject({ kind: "ready", thinking: "low" });
  } finally { writeFileSync(settingsPath, previous); }
});

test("successful SDK retry clears earlier assistant failure and counts both attempts", async () => {
  const result = await run({ prompt: "retry" });
  expect(result.code).toBe(0);
  expect(result.events.at(-1)).toMatchObject({ kind: "result", report: { stopReason: "stop" }, usage: { turns: 2, input: 6 } });
  expect((result.events.at(-1) as any).report.errorMessage).toBeUndefined();
});

test("SDK cancellation runs child extension shutdown before exiting", async () => {
  const result = await run({ prompt: "wait-for-abort" }, false, true);
  expect(result.events.at(-1)).toMatchObject({ kind: "result", report: { stopReason: "aborted" } });
  expect(existsSync(join(dir, "child-shutdown"))).toBe(true);
});

test.each([
  { fallback: "ask", saved: null, hook: null, trusted: false },
  { fallback: "always", saved: null, hook: null, trusted: true },
  { fallback: "never", saved: true, hook: null, trusted: true },
  { fallback: "always", saved: false, hook: null, trusted: false },
  { fallback: "never", saved: false, hook: "yes", trusted: true },
  { fallback: "always", saved: true, hook: "no", trusted: false },
])("SDK child preserves noninteractive Pi project trust: %j", async ({ fallback, saved, hook, trusted }) => {
  const settingsPath = join(dir, "settings.json");
  const previous = readFileSync(settingsPath, "utf8");
  const projectDir = join(dir, ".pi");
  const marker = join(dir, "project-loaded");
  try {
    mkdirSync(join(projectDir, "extensions"), { recursive: true });
    writeFileSync(join(projectDir, "extensions", "project.ts"), `import {writeFileSync} from "node:fs";
      export default function(pi) {
        writeFileSync(${JSON.stringify(marker)}, "yes");
        pi.registerTool({name:"project_only",label:"project",description:"test",parameters:{type:"object",properties:{}},execute:async()=>({content:[]})});
      }`);
    rmSync(join(dir, "trust.json"), { force: true });
    if (saved !== null) new ProjectTrustStore(dir).set(dir, saved);
    const settings = JSON.parse(previous);
    settings.defaultProjectTrust = fallback;
    if (hook) {
      const extension = join(dir, "trust-hook.ts");
      writeFileSync(extension, `export default pi => pi.on("project_trust", () => ({trusted:${JSON.stringify(hook)}}));`);
      settings.extensions.push(extension);
    }
    writeFileSync(settingsPath, JSON.stringify(settings));
    const result = await run({ tools: ["project_only"] });
    expect(existsSync(marker)).toBe(trusted);
    expect(existsSync(join(dir, "provider-called"))).toBe(trusted);
    expect(result.code).toBe(trusted ? 0 : 1);
  } finally {
    writeFileSync(settingsPath, previous);
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(marker, { force: true });
    rmSync(join(dir, "trust.json"), { force: true });
  }
});

test("SDK length termination and oversized final output stay explicit", async () => {
  const length = await run({ prompt: "length" });
  expect(length.events.at(-1)).toMatchObject({ report: { stopReason: "length" } });
  const huge = await run({ prompt: "huge" });
  expect(huge.events.at(-1)).toMatchObject({ report: { outputTruncation: { truncated: true, originalBytes: 400000 } } });
});
