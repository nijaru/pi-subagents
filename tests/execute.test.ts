import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/pi-subagents/index.ts";
import { activeChildren } from "../extensions/pi-subagents/subprocess.ts";

const directories: string[] = [];
interface Host {
  tool: any;
  cwd: string;
  notices: any[];
  execute(params: any, signal?: AbortSignal, update?: (value: any) => void): Promise<any>;
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
  const events = new Map<string, () => Promise<void>>();
  const notices: any[] = [];
  extension({
    registerTool(value: any) { tool = value; },
    on(name: string, fn: () => Promise<void>) { events.set(name, fn); },
    getActiveTools() { return active; },
    sendMessage(message: any, options: any) { notices.push({ message, options }); },
  } as any);
  const cwd = tempDir();
  const context = { cwd, hasUI: false, model: { provider: "parent", id: "model" }, thinkingLevel: "high" };
  const instance = {
    tool, cwd, notices,
    execute: (params: any, signal?: AbortSignal, update?: (value: any) => void) => tool.execute("call", params, signal, update, context),
    shutdown: () => events.get("session_shutdown")!(),
    restart: () => events.get("session_start")!(),
  };
  hosts.push(instance);
  return instance;
}
function fakePi(body = 'final("done");'): string {
  const file = path.join(tempDir(), "pi");
  fs.writeFileSync(file, `#!/usr/bin/env bun
import * as fs from "node:fs";
const args = process.argv.slice(2);
const taskPath = args.find((arg) => arg.startsWith("@"))?.slice(1);
fs.writeFileSync(import.meta.filename + ".capture", JSON.stringify({ args, cwd: process.cwd(), prompt: taskPath ? fs.readFileSync(taskPath, "utf8") : null, mode: taskPath ? fs.statSync(taskPath).mode & 0o777 : null, depth: process.env.PI_SUBAGENT_DEPTH }));
const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 9, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
const message = (text, stopReason = "stop", extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], model: "fake/model", usage, stopReason, timestamp: 0, ...extra });
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const final = (text, stopReason = "stop", extra = {}) => emit({ type: "message_end", message: message(text, stopReason, extra) });
${body}
`);
  fs.chmodSync(file, 0o755);
  process.env.PI_SUBAGENT_BIN = file;
  return file;
}
async function captured(file: string) {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(file + ".capture")) return JSON.parse(fs.readFileSync(file + ".capture", "utf8"));
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
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.shutdown()));
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("task-first tool", () => {
  test("exposes only the lifecycle API", () => {
    expect(Object.keys(host().tool.parameters.properties)).toEqual(["command", "prompt", "tools", "model", "cwd", "id", "timeoutMs"]);
  });
  test("runs without profiles, inherits model/thinking, and transports a private prompt file", async () => {
    const h = host();
    const file = fakePi();
    const value = await h.execute({ command: "run", prompt: "Read exactly these facts; no parent history." });
    const capture = await captured(file);
    expect(capture.prompt).toBe("Read exactly these facts; no parent history.");
    expect(capture.mode).toBe(0o600);
    expect(capture.depth).toBe("1");
    expect(capture.args).toContain("--no-session");
    expect(capture.args).toContain("parent/model");
    expect(capture.args).toContain("high");
    expect(capture.args).not.toContain("--append-system-prompt");
    expect(capture.args).not.toContain(capture.prompt);
    expect(capture.args).toContain("read,bash,edit,write,web_search,web_fetch,web_research,query-docs");
    expect(fs.existsSync(capture.args.find((arg: string) => arg.startsWith("@")).slice(1))).toBe(false);
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
    expect(capture.args).toContain("--no-tools");
    expect(capture.args).toContain("custom/model");
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
  test("returns before completion, times out a wait without cancelling, then notifies once", async () => {
    const h = host();
    const file = fakePi('await Bun.sleep(150); final("finished later");');
    const id = await spawn(h);
    const interim = await h.execute({ command: "wait", id, timeoutMs: 1 });
    expect(first(interim).exitCode).toBe(-1);
    await captured(file);
    const value = await h.execute({ command: "wait", id });
    expect(first(value).output).toBe("finished later");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].message.content).toContain(id);
    expect(h.notices[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    await h.execute({ command: "wait", id });
    expect(h.notices).toHaveLength(1);
  });
  test("cancelling wait leaves the child running; stop joins and is idempotent", async () => {
    const h = host();
    const file = fakePi("await Bun.sleep(10000);");
    const id = await spawn(h);
    await captured(file);
    const controller = new AbortController();
    const pending = h.execute({ command: "wait", id }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("use stop");
    expect(first(await h.execute({ command: "status", id })).exitCode).toBe(-1);
    expect(first(await h.execute({ command: "stop", id })).termination).toBe("cancelled");
    expect(first(await h.execute({ command: "stop", id })).termination).toBe("cancelled");
    expect(h.notices).toHaveLength(0);
    expect(activeChildren.size).toBe(0);
  });
  test("run propagates abort and preserves the cancelled result in status", async () => {
    const h = host();
    const file = fakePi("await Bun.sleep(10000);");
    const controller = new AbortController();
    const pending = h.execute({ command: "run", prompt: "x" }, controller.signal);
    await captured(file); controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(first(await h.execute({ command: "status" })).termination).toBe("cancelled");
  });
  test("shutdown drains children, suppresses stale notices, and session start drops old handles", async () => {
    const h = host();
    const file = fakePi("await Bun.sleep(10000);");
    const id = await spawn(h); await captured(file);
    await h.shutdown();
    expect(activeChildren.size).toBe(0);
    expect(h.notices).toHaveLength(0);
    await expect(h.execute({ command: "spawn", prompt: "no" })).rejects.toThrow("closing");
    await h.restart();
    await expect(h.execute({ command: "status", id })).rejects.toThrow("Unknown child");
    fakePi();
    expect(first(await h.execute({ command: "run", prompt: "new session" })).termination).toBe("completed");
  });
  test("enforces one shared capacity limit across sibling spawn/run calls", async () => {
    const h = host(); fakePi("await Bun.sleep(10000);");
    await Promise.all(Array.from({ length: 4 }, () => spawn(h)));
    await expect(h.execute({ command: "run", prompt: "fifth", tools: ["read"] })).rejects.toThrow("maximum 4");
    expect((await h.execute({ command: "status" })).details.results).toHaveLength(4);
  });
  test("rejects writers in one git root even through nested packages and symlinks", async () => {
    const h = host(); fakePi("await Bun.sleep(10000);");
    fs.mkdirSync(path.join(h.cwd, ".git"));
    for (const name of ["one", "two"]) {
      fs.mkdirSync(path.join(h.cwd, name));
      fs.writeFileSync(path.join(h.cwd, name, "package.json"), "{}");
    }
    fs.symlinkSync(path.join(h.cwd, "two"), path.join(h.cwd, "alias"));
    await spawn(h, { tools: ["bash"], cwd: "one" });
    await expect(h.execute({ command: "run", prompt: "writer", cwd: "alias" })).rejects.toThrow("Concurrent mutation");
  });
  test("permits independent worktree writers and same-root readers", async () => {
    const h = host(); fakePi("await Bun.sleep(10000);");
    for (const name of ["one", "two"]) {
      fs.mkdirSync(path.join(h.cwd, name));
      fs.writeFileSync(path.join(h.cwd, name, ".git"), "gitdir: /unused");
    }
    await spawn(h, { tools: ["bash"], cwd: "one" });
    await spawn(h, { tools: ["bash"], cwd: "two" });
    await spawn(h, { tools: ["read"], cwd: "one" });
    expect((await h.execute({ command: "status" })).details.results).toHaveLength(3);
  });
});

describe("subprocess regressions", () => {
  test.each([
    ["empty output", "", "terminal assistant output"],
    ["tool-use only", 'final("need tool", "toolUse");', "terminal assistant output"],
    ["protocol error", 'emit({type:"error",message:"provider failed"}); final("not success");', "provider failed"],
    ["assistant error", 'final("", "error", {errorMessage:"assistant failed"});', "assistant failed"],
    ["nonzero exit", 'console.error("broken child"); process.exit(2);', "broken child"],
  ])("reports %s as failure", async (_name, body, error) => {
    const h = host(); fakePi(body);
    await expect(h.execute({ command: "run", prompt: "x" })).rejects.toThrow(error);
    expect(first(await h.execute({ command: "status" })).termination).toBe("failed");
  });
  test("distinguishes deadline expiry from cancellation", async () => {
    const h = host(); fakePi("await Bun.sleep(10000);");
    process.env.PI_SUBAGENT_TIMEOUT_MS = "100";
    await expect(h.execute({ command: "run", prompt: "x" })).rejects.toThrow("timed out");
    expect(first(await h.execute({ command: "status" })).termination).toBe("timed_out");
  });
  test.each([
    'emit({type:"tool_execution_update",partialResult:"x".repeat(2*1024*1024)});',
    'process.stdout.write("ignored line\\n".repeat(300000));',
    'process.stdout.write("x".repeat(2*1024*1024)+"\\n");',
  ])("recovers after oversized or ignored protocol traffic", async (body) => {
    const h = host(); fakePi(body + 'final("recovered");');
    expect(first(await h.execute({ command: "run", prompt: "x" })).output).toBe("recovered");
  });
  test("preserves UTF-8 split across chunks and a final event without newline", async () => {
    const h = host();
    fakePi('const bytes=Buffer.from(JSON.stringify({type:"message_end",message:message("😀漢字")})); const i=bytes.indexOf(Buffer.from("😀")); process.stdout.write(bytes.subarray(0,i+1)); await Bun.sleep(10); process.stdout.write(bytes.subarray(i+1));');
    expect(first(await h.execute({ command: "run", prompt: "x" })).output).toBe("😀漢字");
  });
  test("bounds model output, retained details, metadata and delta updates", async () => {
    const h = host();
    fakePi('for(let i=0;i<60;i++)emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"x".repeat(500)}}); final("x".repeat(100000), "stop", {providerMetadata:"x".repeat(20000)});');
    let updates = 0;
    const value = await h.execute({ command: "run", prompt: "x" }, undefined, () => updates++);
    expect(updates).toBeLessThan(10);
    expect(Buffer.byteLength(value.content[0].text)).toBeLessThanOrEqual(50 * 1024);
    expect(Buffer.byteLength(JSON.stringify(value.details))).toBeLessThanOrEqual(50 * 1024);
    expect(first(value).messages).toHaveLength(0);
    expect(first(value).output.length).toBeGreaterThan(1000);
  });
  test("failed private-prompt cleanup is visible, bounds further launches, and retries on shutdown", async () => {
    const h = host(); const file = fakePi();
    const remove = fs.promises.rm.bind(fs.promises);
    const mock = spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes("pi-subagent-")) throw new Error("simulated cleanup denial");
      return remove(target, options);
    });
    let promptPath = "";
    try {
      await expect(h.execute({ command: "run", prompt: "private" })).rejects.toThrow("Private prompt cleanup failed");
      const capture = await captured(file);
      promptPath = capture.args.find((arg: string) => arg.startsWith("@")).slice(1);
      expect(fs.existsSync(promptPath)).toBe(true);
      await expect(h.execute({ command: "run", prompt: "do not create another file" })).rejects.toThrow("cleanup is pending");
    } finally { mock.mockRestore(); }
    await h.shutdown();
    expect(fs.existsSync(promptPath)).toBe(false);
  });
  test("update-handler failure cleans up and retains its diagnostic", async () => {
    const h = host(); fakePi();
    await expect(h.execute({ command: "run", prompt: "x" }, undefined, () => { throw new Error("update boom"); })).rejects.toThrow("update boom");
    expect(activeChildren.size).toBe(0);
  });
  test("emits coarse heartbeats while foreground work is running", async () => {
    const h = host(); fakePi('await Bun.sleep(1150); final("done");');
    const updates: string[] = [];
    await h.execute({ command: "run", prompt: "x" }, undefined, (value) => updates.push(value.content[0].text));
    expect(updates.filter((text) => text === "Working...").length).toBeGreaterThan(1);
  });
  test("sweeps surviving processes before reporting ordinary completion", async () => {
    if (process.platform === "win32") return;
    const h = host();
    const marker = path.join(tempDir(), "swept");
    fakePi(`const child=Bun.spawn(["sh","-c",${JSON.stringify(`trap 'printf swept > '${JSON.stringify(marker)}'; exit 0' TERM; printf ready; while :; do sleep 1; done`)}],{stdout:"pipe",stderr:"inherit"}); const reader=child.stdout.getReader(); await reader.read(); final("done"); process.exit(0);`);
    const value = await h.execute({ command: "run", prompt: "x" });
    expect(first(value).termination).toBe("completed");
    expect(fs.existsSync(marker)).toBe(true);
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
