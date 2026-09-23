import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/pi-subagents/index.ts";
import { activeChildren } from "../extensions/pi-subagents/subprocess.ts";
import { MAX_COMPLETION_BYTES } from "../extensions/pi-subagents/limits.ts";

const directories: string[] = [];
interface Host {
  tool: any;
  cwd: string;
  notices: any[];
  renderers: Map<string, any>;
  execute(params: any, signal?: AbortSignal, update?: (value: any) => void): Promise<any>;
  toolResult(event?: any): any;
  boundary(): void;
  shutdown(): Promise<void>;
  restart(): Promise<void>;
}
const hosts: Host[] = [];
let savedEnv: NodeJS.ProcessEnv;
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-children-test-"));
  directories.push(dir);
  return dir;
}
function host(active = ["read", "bash", "edit", "write", "web_search", "web_fetch", "web_research", "query-docs"]): Host {
  let tool: any;
  const events = new Map<string, (...args: any[]) => any>();
  const notices: any[] = [];
  const renderers = new Map<string, any>();
  extension({
    registerTool(value: any) { tool = value; },
    registerMessageRenderer(name: string, renderer: any) { renderers.set(name, renderer); },
    on(name: string, fn: (...args: any[]) => any) { events.set(name, fn); },
    getActiveTools() { return active; },
    sendMessage(message: any, options: any) { notices.push({ message, options }); },
  } as any);
  const cwd = tempDir();
  const entries: any[] = [];
  const context = { cwd, hasUI: false, model: { provider: "parent", id: "model" }, thinkingLevel: "high", isIdle: () => true,
    sessionManager: { getBranch: () => entries } };
  const instance = {
    tool, cwd, notices, renderers,
    execute: (params: any, signal?: AbortSignal, update?: (value: any) => void) => tool.execute("call", params, signal, update, context),
    toolResult: (event = { toolName: "subagent" }) => events.get("tool_result")!(event),
    boundary: () => {
      const result = events.get("turn_end")!({ type: "turn_end", outcome: "completed", entries: [] }, context);
      for (const entry of result?.entries ?? []) {
        entries.push(entry);
        if (entry.customType === "subagent-complete") notices.push({ message: entry });
      }
      events.get("turn_start")!({}, context);
    },
    shutdown: () => events.get("session_shutdown")!(),
    restart: () => events.get("session_start")!({}, context),
  };
  hosts.push(instance);
  return instance;
}
function fakePi(body = 'final("done");'): string {
  const file = path.join(tempDir(), "runner.mjs");
  fs.writeFileSync(file, `import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
fs.writeFileSync(process.argv[1] + ".capture", JSON.stringify({ ...request, args, cwd: process.cwd(), depth: process.env.PI_SUBAGENT_DEPTH }));
const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 9, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 }, turns: 1 };
const emit = (event) => fs.writeSync(3, JSON.stringify({ version: 1, ...event }) + "\\n");
const report = (text, stopReason = "stop", extra = {}) => ({ output: text, stopReason, outputTruncation: { truncated: false, originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text) }, ...extra });
const final = (text, stopReason = "stop", extra = {}) => emit({ kind: "result", report: report(text, stopReason, extra), usage });
emit({ kind: "ready", model: request.model, tools: request.tools });
${body}
`);
  process.env.PI_SUBAGENT_RUNNER = file;
  return file;
}
async function captured(file: string) {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(file + ".capture")) {
      // The writer creates the file before filling it; retry a partial read.
      try { return JSON.parse(fs.readFileSync(file + ".capture", "utf8")); } catch { /* still writing */ }
    }
    await Bun.sleep(10);
  }
  throw new Error("fake child did not start");
}
const first = (value: any) => value.details.results[0];
const spawn = async (h: ReturnType<typeof host>, options = {}) => first(await h.execute({ command: "spawn", prompt: "inspect", tools: ["read"], ...options })).id;

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.PI_SUBAGENT_DEPTH;
  delete process.env.PI_SUBAGENT_TIMEOUT_MS;
  delete process.env.PI_SUBAGENT_FOREGROUND_MS;
  delete process.env.PI_SUBAGENT_BIN;
  delete process.env.PI_BIN;
  delete process.env.PI_SUBAGENT_RUNNER;
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("task-first tool", () => {
  test("exposes only the lifecycle API with unambiguous prompt guidelines", () => {
    const tool = host().tool;
    expect(Object.keys(tool.parameters.properties)).toEqual(["command", "prompt", "tools", "model", "cwd", "id", "timeoutMs"]);
    expect(tool.promptGuidelines.every((line: string) => line.includes("subagent"))).toBe(true);
  });
  test("runs without profiles, inherits model/thinking, and delivers the prompt on stdin", async () => {
    const h = host();
    const file = fakePi();
    const value = await h.execute({ command: "run", prompt: "Read exactly these facts; no parent history." });
    const capture = await captured(file);
    expect(capture.prompt).toBe("Read exactly these facts; no parent history.");
    expect(capture.depth).toBe("1");
    expect(capture.version).toBe(1);
    expect(capture.model).toBe("parent/model");
    expect(capture.thinking).toBe("high");
    expect(capture.args).not.toContain(capture.prompt);
    expect(capture.tools).toEqual(["read", "bash", "edit", "write", "web_search", "web_fetch", "web_research", "query-docs"]);
    expect(first(value).output).toBe("done");
    expect(first(value).usage.cost.total).toBe(1);
    expect(h.notices).toHaveLength(0);
    expect(activeChildren.size).toBe(0);
  });
  test("supports explicit tool-less reasoning, model override and canonical cwd", async () => {
    const h = host();
    const file = fakePi();
    fs.mkdirSync(path.join(h.cwd, "nested"));
    const value = await h.execute({ command: "run", prompt: "reason", tools: [], model: "custom/model", cwd: "nested" });
    const capture = await captured(file);
    expect(capture.tools).toEqual([]);
    expect(capture.model).toBe("custom/model");
    expect(capture.cwd).toBe(fs.realpathSync(path.join(h.cwd, "nested")));
    expect(first(value).tools).toEqual([]);
  });
  test("does not read repository or user role definitions", async () => {
    const h = host();
    fs.mkdirSync(path.join(h.cwd, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(h.cwd, ".pi", "agents", "worker.md"), "MALICIOUS ROLE PERSONA");
    const file = fakePi();
    await h.execute({ command: "run", prompt: "only my task", tools: ["read"] });
    expect((await captured(file)).prompt).toBe("only my task");
  });
  test.each([
    {}, { agent: "worker", task: "old" }, { command: "send", id: "id" },
    { command: "run", prompt: " " }, { command: "spawn", prompt: "x", id: "id" },
    { command: "status", prompt: "x" }, { command: "wait" }, { command: "stop" },
    { command: "run", prompt: "x", model: " " }, { command: "run", prompt: "x", cwd: " " },
    { command: "wait", id: "x", timeoutMs: 0 }, { command: "wait", id: "x", timeoutMs: 120001 },
    { command: "run", prompt: "x", tools: ["read", "read"] },
    { command: "run", prompt: "😀".repeat(26_000) },
  ])("rejects invalid or obsolete input before launch: %j", async (params) => {
    await expect(host().execute(params)).rejects.toThrow();
    expect(activeChildren.size).toBe(0);
  });
  test("rejects unavailable tools, recursive calls, malformed depth and missing cwd", async () => {
    const h = host(["read", "subagent"]);
    await expect(h.execute({ command: "run", prompt: "x", tools: ["bash"] })).rejects.toThrow("active in the parent");
    await expect(h.execute({ command: "run", prompt: "x", tools: ["subagent"] })).rejects.toThrow("leaves");
    await expect(h.execute({ command: "run", prompt: "x", cwd: "missing" })).rejects.toThrow("does not exist");
    for (const depth of ["1", "3", "garbage", "-1", ""]) {
      process.env.PI_SUBAGENT_DEPTH = depth;
      await expect(h.execute({ command: "run", prompt: "x" })).rejects.toThrow("leaves");
    }
  });
  test("cancellation before launch creates no child", async () => {
    const h = host();
    const controller = new AbortController(); controller.abort();
    await expect(h.execute({ command: "run", prompt: "x" }, controller.signal)).rejects.toThrow("cancelled");
    expect((await h.execute({ command: "status" })).details.results).toEqual([]);
  });
});

describe("background lifecycle", () => {
  test("re-arms the notice after a wait expires, then delivers once without a waiter", async () => {
    const h = host();
    const file = fakePi('await delay(150); final("finished later");');
    const id = await spawn(h);
    const interim = await h.execute({ command: "wait", id, timeoutMs: 1 });
    expect(first(interim).state.status).toBe("running");
    await captured(file);
    // No waiter is active; the result stays unread until a turn boundary.
    await Bun.sleep(400);
    expect(h.notices).toHaveLength(0);
    h.boundary();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].message.content).toContain(id);
    expect(h.notices[0].message.content).toContain("finished later");
    expect(h.notices[0].message.content).not.toContain("use subagent wait");
    expect(h.notices[0].options).toBeUndefined();
    const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text };
    const notice = h.renderers.get("subagent-complete")(h.notices[0].message, { expanded: false, outputPad: 1 }, theme).render(100);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain(`subagent ${id.slice(0, 8)} completed`);
    expect(notice[0]).toContain("finished later"); // one-line result preview
    expect(first(await h.execute({ command: "wait", id })).output).toBe("finished later");
    expect(h.notices).toHaveLength(1);
  });
  test("a delivering wait claims the result and suppresses the notice", async () => {
    const h = host();
    fakePi('await delay(50); final("delivered by wait");');
    const id = await spawn(h);
    const value = await h.execute({ command: "wait", id });
    expect(first(value).output).toBe("delivered by wait");
    await Bun.sleep(100);
    expect(h.notices).toHaveLength(0);
  });
  test("points at the retained result only when the notice excerpt was truncated", async () => {
    const h = host();
    fakePi('await delay(50); final("y".repeat(20000));');
    await spawn(h);
    await Bun.sleep(300);
    h.boundary();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].message.content).toContain("use subagent wait");
    expect(Buffer.byteLength(h.notices[0].message.content)).toBeLessThanOrEqual(MAX_COMPLETION_BYTES + 2048);
  });
  test("run degrades to background work when the foreground budget expires", async () => {
    const h = host();
    process.env.PI_SUBAGENT_FOREGROUND_MS = "50";
    fakePi('await delay(250); final("late result");');
    const value = await h.execute({ command: "run", prompt: "x" });
    expect(first(value).state.status).toBe("running");
    expect(value.content[0].text).toContain("Still running after");
    expect(h.notices).toHaveLength(0);
    await Bun.sleep(500);
    expect(h.notices).toHaveLength(0);
    h.boundary();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].message.content).toContain("late result");
    expect(first(await h.execute({ command: "wait", id: first(value).id })).output).toBe("late result");
  });
  test("cancelling wait leaves the child running; stop joins and is idempotent", async () => {
    const h = host();
    const file = fakePi("await delay(10000);");
    const id = await spawn(h);
    await captured(file);
    const controller = new AbortController();
    const pending = h.execute({ command: "wait", id }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("use stop");
    expect(first(await h.execute({ command: "status", id })).state.status).toBe("running");
    expect(first(await h.execute({ command: "stop", id })).state).toMatchObject({ outcome: "cancelled" });
    expect(first(await h.execute({ command: "stop", id })).state).toMatchObject({ outcome: "cancelled" });
    expect(h.notices).toHaveLength(0);
    expect(activeChildren.size).toBe(0);
  });
  test("run propagates abort and preserves the cancelled result in status", async () => {
    const h = host();
    const file = fakePi("await delay(10000);");
    const controller = new AbortController();
    const pending = h.execute({ command: "run", prompt: "x" }, controller.signal);
    await captured(file); controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(first(await h.execute({ command: "status" })).state).toMatchObject({ outcome: "cancelled" });
  });
  test("shutdown drains children, suppresses stale notices, and session start drops old handles", async () => {
    const h = host();
    const file = fakePi("await delay(10000);");
    const id = await spawn(h); await captured(file);
    await h.shutdown();
    expect(activeChildren.size).toBe(0);
    expect(h.notices).toHaveLength(0);
    await expect(h.execute({ command: "spawn", prompt: "no" })).rejects.toThrow("closing");
    await h.restart();
    await expect(h.execute({ command: "status", id })).rejects.toThrow("Unknown child");
    fakePi();
    expect(first(await h.execute({ command: "run", prompt: "new session" })).state).toMatchObject({ outcome: "completed" });
  });
  test("enforces one shared capacity limit across sibling spawn/run calls", async () => {
    const h = host(); fakePi("await delay(10000);");
    await Promise.all(Array.from({ length: 4 }, () => spawn(h)));
    await expect(h.execute({ command: "run", prompt: "fifth", tools: ["read"] })).rejects.toThrow("maximum 4");
    expect((await h.execute({ command: "status" })).details.results).toHaveLength(4);
  });
  test("admits concurrent writers in one root and one worktree", async () => {
    const h = host(); fakePi("await delay(10000);");
    fs.mkdirSync(path.join(h.cwd, ".git"));
    for (const name of ["one", "two"]) {
      fs.mkdirSync(path.join(h.cwd, name));
      fs.writeFileSync(path.join(h.cwd, name, "package.json"), "{}");
    }
    fs.symlinkSync(path.join(h.cwd, "two"), path.join(h.cwd, "alias"));
    await spawn(h, { tools: ["bash"], cwd: "one" });
    await spawn(h, { tools: ["bash"], cwd: "alias" });
    await spawn(h, { tools: ["read", "bash", "edit", "write"], cwd: "." });
    expect((await h.execute({ command: "status" })).details.results).toHaveLength(3);
  });
});

describe("usage delivery", () => {
  test.each([false, true])("charges foreground usage once, including failures (%s)", async (fails) => {
    const h = host();
    fakePi(fails ? 'final("", "error", {errorMessage:"paid failure"});' : undefined);
    if (fails) await expect(h.execute({ command: "run", prompt: "x" })).rejects.toThrow("paid failure");
    else await h.execute({ command: "run", prompt: "x" });
    expect(h.toolResult({ toolName: "subagent", isError: fails }).usage.cost.total).toBe(1);
    const id = first(await h.execute({ command: "status" })).id;
    expect(h.toolResult()).toBeUndefined();
    if (fails) await expect(h.execute({ command: "wait", id })).rejects.toThrow("paid failure");
    else await h.execute({ command: "wait", id });
    expect(h.toolResult()).toBeUndefined();
    await h.execute({ command: "stop", id });
    expect(h.toolResult()).toBeUndefined();
  });
  test("merges background usage into the next tool result without mutating its usage", async () => {
    const h = host();
    fakePi('await delay(50); final("background");');
    const id = await spawn(h);
    expect(h.toolResult()).toBeUndefined();
    for (let i = 0; first(await h.execute({ command: "status", id })).state.status === "running" && i < 200; i++) await Bun.sleep(10);
    expect(h.notices).toHaveLength(0);
    const existing = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
    const patch = h.toolResult({ toolName: "web_search", usage: existing });
    expect(patch.usage.input).toBe(3);
    expect(patch.usage.cost.total).toBe(1.5);
    expect(existing.cost.total).toBe(0.5);
    expect(existing.input).toBe(1);
    await h.execute({ command: "wait", id });
    expect(h.toolResult()).toBeUndefined();
  });
  test("accounts paid work when a foreground child is cancelled", async () => {
    const h = host();
    fakePi('emit({kind:"usage", usage}); emit({kind:"progress",text:"Working"}); await delay(10000);');
    const controller = new AbortController();
    await expect(h.execute({ command: "run", prompt: "x" }, controller.signal, (value) => {
      if (first(value).usage.turns) controller.abort();
    })).rejects.toThrow("cancelled");
    expect(h.toolResult({ toolName: "subagent", isError: true }).usage.cost.total).toBe(1);
    expect(h.toolResult()).toBeUndefined();
  });
  test("does not carry undelivered costs into a replacement session", async () => {
    const h = host(); fakePi();
    await h.execute({ command: "run", prompt: "x" });
    await h.restart();
    expect(h.toolResult()).toBeUndefined();
  });
});

describe("subprocess regressions", () => {
  test.each([
    ["empty output", "", "terminal assistant output"],
    ["tool-use only", 'final("need tool", "toolUse");', "terminal assistant output"],
    ["protocol error", 'emit({kind:"error",errorMessage:"provider failed"});', "provider failed"],
    ["assistant error", 'final("", "error", {errorMessage:"assistant failed"});', "assistant failed"],
    ["nonzero exit", 'console.error("broken child"); process.exit(2);', "broken child"],
  ])("reports %s as failure", async (_name, body, error) => {
    const h = host(); fakePi(body);
    await expect(h.execute({ command: "run", prompt: "x" })).rejects.toThrow(error);
    expect(first(await h.execute({ command: "status" })).state).toMatchObject({ outcome: "failed" });
  });
  test("thrown tool errors reattach renderer details without duplicate prompts", async () => {
    const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text };
    const h = host();
    fakePi('final("", "error", {errorMessage:"assistant failed"});');
    const error: Error = await h.execute({ command: "run", prompt: "unique task prompt", tools: ["read"] }).then(
      () => { throw new Error("expected failure"); }, (cause: Error) => cause);
    expect(error.message).toContain("assistant failed");
    expect(error.message).not.toContain("unique task prompt");
    const patch = h.toolResult({ toolName: "subagent", toolCallId: "call", isError: true });
    expect(patch.details).toMatchObject({ command: "run", results: [{ errorMessage: "assistant failed" }] });
    const rendered = h.tool.renderResult({ content: [{ type: "text", text: error.message }], details: patch.details }, { expanded: false }, theme).render(80).join("\n");
    expect(rendered).toContain("failed");
    expect(rendered).toContain("assistant failed");
    expect(rendered).not.toContain("unique task prompt");
    // Consumed exactly once: nothing left to patch, and no duplicate usage.
    expect(h.toolResult({ toolName: "subagent", toolCallId: "call", isError: true })).toBeUndefined();
  });
  test("distinguishes deadline expiry from cancellation", async () => {
    const h = host(); fakePi("await delay(10000);");
    process.env.PI_SUBAGENT_TIMEOUT_MS = "100";
    await expect(h.execute({ command: "run", prompt: "x" })).rejects.toThrow("timed out");
    expect(first(await h.execute({ command: "status" })).state).toMatchObject({ outcome: "timed_out" });
  });
  test.each([
    'console.log(JSON.stringify({version:1,kind:"error",errorMessage:"stdout spoof"}));',
    'process.stdout.write("ignored line\\n".repeat(300000));',
    'process.stdout.write("x".repeat(2*1024*1024)+"\\n");',
  ])("diagnostic stdout cannot corrupt the private result protocol", async (body) => {
    const h = host(); fakePi(body + 'final("recovered");');
    const value = await h.execute({ command: "run", prompt: "x" });
    expect(first(value).output).toBe("recovered");
    expect(first(value).state).toMatchObject({ outcome: "completed" });
  });
  test("preserves UTF-8 split across chunks and a final event without newline", async () => {
    const h = host();
    fakePi('const bytes=Buffer.from(JSON.stringify({version:1,kind:"result",report:report("😀漢字"),usage})); const i=bytes.indexOf(Buffer.from("😀")); fs.writeSync(3,bytes.subarray(0,i+1)); await delay(10); fs.writeSync(3,bytes.subarray(i+1));');
    expect(first(await h.execute({ command: "run", prompt: "x" })).output).toBe("😀漢字");
  });
  test("bounds returned reports and details independently of diagnostic volume", async () => {
    const h = host();
    fakePi('process.stdout.write("x".repeat(100000)); final("x".repeat(50*1024));');
    let updates = 0;
    const value = await h.execute({ command: "run", prompt: "x" }, undefined, () => updates++);
    expect(updates).toBeLessThan(10);
    expect(Buffer.byteLength(value.content[0].text)).toBeLessThanOrEqual(50 * 1024);
    expect(Buffer.byteLength(JSON.stringify(value.details))).toBeLessThanOrEqual(50 * 1024);
    expect("messages" in first(value)).toBe(false);
    expect(first(value).output.length).toBeGreaterThan(1000);
  });
  test("cumulative usage frames and the final snapshot are counted once", async () => {
    const h = host();
    fakePi('emit({kind:"usage",usage}); emit({kind:"usage",usage}); final("done");');
    const value = await h.execute({ command: "run", prompt: "x" });
    expect(first(value).usage.turns).toBe(1);
    expect(first(value).usage.totalTokens).toBe(9);
    expect(h.toolResult().usage.cost.total).toBe(1);
  });
  test("retains incomplete output while reporting the token limit as a tool error", async () => {
    const h = host();
    fakePi('final("partial findings", "length");');
    await expect(h.execute({ command: "run", prompt: "x" })).rejects.toThrow("model output limit");
    const value = first(await h.execute({ command: "status" }));
    expect(value.state).toMatchObject({ outcome: "incomplete", stopReason: "length" });
    expect(value.output).toBe("partial findings");
  });
  test("a failing update handler does not fail or terminate the child", async () => {
    const h = host(); fakePi();
    let updates = 0;
    const value = await h.execute({ command: "run", prompt: "x" }, undefined, () => { updates++; throw new Error("update boom"); });
    expect(first(value).output).toBe("done");
    expect(first(value).state).toMatchObject({ outcome: "completed" });
    expect(updates).toBe(1);
    expect(activeChildren.size).toBe(0);
  });
  test("emits coarse heartbeats while foreground work is running", async () => {
    const h = host(); fakePi('await delay(1150); final("done");');
    const updates: string[] = [];
    await h.execute({ command: "run", prompt: "x" }, undefined, (value) => updates.push(value.content[0].text));
    expect(updates.filter((text) => text === "Working...").length).toBeGreaterThan(1);
  });
  test("sweeps surviving processes before reporting ordinary completion", async () => {
    if (process.platform === "win32") return;
    const h = host();
    const marker = path.join(tempDir(), "swept");
    fakePi(`const {spawn}=await import("node:child_process"); const child=spawn("sh",["-c",${JSON.stringify(`trap 'printf swept > '${JSON.stringify(marker)}'; exit 0' TERM; printf ready; while :; do sleep 1; done`)}],{stdio:["ignore","pipe","inherit"]}); await new Promise(resolve=>child.stdout.once("data",resolve)); final("done"); process.exit(0);`);
    const value = await h.execute({ command: "run", prompt: "x" });
    expect(first(value).state).toMatchObject({ outcome: "completed" });
    expect(fs.existsSync(marker)).toBe(true);
  });
  test("killing the parent mid-run kills the child instead of orphaning it", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const started = path.join(dir, "started");
    const marker = path.join(dir, "mutation");
    const runner = path.join(dir, "runner.mjs");
    // A real child that outlives its parent long enough to mutate the tree.
    fs.writeFileSync(runner, `import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
for await (const chunk of process.stdin) {};
fs.writeFileSync(${JSON.stringify(started)}, "1");
await delay(1500);
fs.writeFileSync(${JSON.stringify(marker)}, "mutated");
`);
    const parentScript = path.join(dir, "parent.ts");
    fs.writeFileSync(parentScript, `import { SubprocessChildSupervisor } from ${JSON.stringify(path.resolve(import.meta.dir, "../extensions/pi-subagents/supervisor.ts"))};
const result: any = { id: "orphan-check", prompt: "task", cwd: process.cwd(), tools: [], state: { status: "running" }, stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turns: 0 } };
await new SubprocessChildSupervisor().run({ result, signal: new AbortController().signal });
`);
    const proc = Bun.spawn([process.execPath, parentScript], {
      cwd: dir,
      env: { ...process.env, PI_SUBAGENT_RUNNER: runner },
      stdout: "ignore", stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(started) && Date.now() < deadline) await Bun.sleep(20);
      expect(fs.existsSync(started)).toBe(true);
      process.kill(proc.pid, "SIGKILL");
      await proc.exited;
      await Bun.sleep(2500);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      try { process.kill(proc.pid, "SIGKILL"); } catch { /* already gone */ }
      await proc.exited;
    }
  }, 30000);
  test("keeps the tail of over-budget stderr so the final failure survives", async () => {
    const h = host();
    fakePi('process.stderr.write("EARLY_DIAGNOSTIC\\n" + "x".repeat(60000) + "\\nFINAL_STACK_TRACE\\n"); process.exit(3);');
    await expect(h.execute({ command: "run", prompt: "x" })).rejects.toThrow("FINAL_STACK_TRACE");
    const status = first(await h.execute({ command: "status" }));
    expect(Buffer.byteLength(status.stderr)).toBeLessThanOrEqual(50 * 1024);
    expect(status.stderr).toContain("EARLY_DIAGNOSTIC");
    expect(status.stderr).toContain("FINAL_STACK_TRACE");
  });

  test("renders current results and safely falls back for old transcripts", async () => {
    const h = host(); fakePi();
    const value = await h.execute({ command: "run", prompt: "render me" });
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
    for (const expanded of [false, true]) {
      expect(h.tool.renderResult(value, { expanded }, theme).render(120).join("\n")).toContain("done");
      expect(h.tool.renderResult({ content: [{ type: "text", text: "old output" }], details: { results: [{ agent: "worker" }] } }, { expanded }, theme).render(120).join("\n")).toContain("old output");
    }
    const malformed = { ...value, details: { ...value.details, results: [{ ...first(value), model: {} }] } };
    expect(h.tool.renderResult(malformed, { expanded: true }, theme).render(120).join("\n")).toContain("done");
    const oversized = { ...value, details: { ...value.details, results: [{ ...first(value), output: "x".repeat(200000) }] } };
    expect(h.tool.renderResult(oversized, { expanded: true }, theme).render(120).join("\n").length).toBeLessThan(70000);
    expect(h.tool.renderCall({ command: "run", prompt: "hello\x1b[31m" }, theme).render(120).join("\n")).toContain("hello");
  });
});
