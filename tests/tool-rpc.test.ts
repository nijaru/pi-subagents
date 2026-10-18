import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/pi-subagents/index.ts";

const directories: string[] = [];
const hosts: any[] = [];
const saved = { ...process.env };
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-rpc-test-"));
  directories.push(dir);
  return dir;
}
function host() {
  let tool: any;
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  extension({
    registerTool(value: any) { tool = value; },
    registerMessageRenderer() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on() {},
    getActiveTools() { return ["read", "bash"]; },
  } as any);
  const cwd = tempDir();
  const context = {
    cwd, hasUI: false, tools: [{ name: "read" }, { name: "bash" }],
    model: { provider: "parent", id: "model" }, thinkingLevel: "high",
    sessionManager: { getBranch: () => [], getSessionFile: (): string | undefined => undefined }, ui: { notify: (message: string) => notifications.push(message) },
  };
  const instance = {
    tool, cwd, commands, notifications, context,
    execute: (params: any, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, context),
  };
  hosts.push(instance);
  return instance;
}
beforeEach(() => {
  process.env.PI_SUBAGENT_CLI = path.resolve(import.meta.dir, "fixtures/fake-rpc-cli.mjs");
  delete process.env.PI_SUBAGENT_SESSION_DIR;
});
afterEach(() => {
  for (const h of hosts.splice(0)) void h;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("RPC-backed subagent tool", () => {
  test("registers the rewritten surface and starts a foreground child", async () => {
    const h = host();
    expect(Object.keys(h.tool.parameters.properties).sort()).toEqual([
      "command", "cwd", "executionTimeoutMs", "id", "ids", "joinTimeoutMs", "message",
      "model", "notify", "persist", "prompt", "resume", "startupTimeoutMs", "thinking", "timeoutMs", "tools", "trustProject",
    ].sort());
    const value = await h.execute({ command: "run", prompt: "hello", tools: ["read"] });
    const child = value.details.results[0];
    expect(child.state).toMatchObject({ status: "terminal", outcome: "completed" });
    expect(child.output).toBe("done");
    expect(child.model).toBe("parent/model");
    expect(child.thinking).toBe("high");
    expect(value.isError).toBe(false);
    const capture = JSON.parse(fs.readFileSync(path.join(fs.realpathSync.native(h.cwd), ".fake-rpc-capture.json"), "utf8"));
    expect(capture.args).toContain("--exclude-tools");
    expect(capture.args[capture.args.indexOf("--exclude-tools") + 1]).toContain("mcp__*");
  });

  test("starts in the background, steers, and joins", async () => {
    const h = host();
    const started = await h.execute({ command: "spawn", prompt: "SCENARIO=steer", tools: [] });
    const handle = started.details.results[0].handle;
    expect(started.details.results[0].state.status).toBe("running");
    for (let i = 0; i < 100; i++) {
      const status = await h.execute({ command: "status", id: handle });
      if (status.details.results[0].state.status === "running") break;
      await Bun.sleep(5);
    }
    const steered = await h.execute({ command: "steer", id: handle, message: "focus" });
    expect(steered.details.command).toBe("steer");
    const joined = await h.execute({ command: "wait", ids: [handle], timeoutMs: 5000 });
    expect(joined.details.results[0].output).toBe("steered: Steering instruction:\n\nfocus");
    expect(joined.details.results[0].state).toMatchObject({ status: "terminal", outcome: "completed" });
  });

  test("resumes an existing child session", async () => {
    const h = host();
    const sessionFile = path.join(tempDir(), "previous.jsonl");
    fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "previous", cwd: h.cwd })}\n`);
    const value = await h.execute({ command: "run", prompt: "continue", tools: [], resume: sessionFile });
    expect(value.details.results[0].sessionFile).toBe(fs.realpathSync.native(sessionFile));
    expect(fs.readFileSync(path.join(h.cwd, ".fake-rpc-capture.json"), "utf8")).toContain("--session");
  });

  test("persists a child session when requested", async () => {
    const h = host();
    const sessionDir = path.join(tempDir(), "sessions");
    process.env.PI_SUBAGENT_SESSION_DIR = sessionDir;
    const value = await h.execute({ command: "run", prompt: "hello", tools: [], persist: true });
    expect(value.details.results[0].sessionFile).toContain("sessions");
    expect(value.content[0].text).toContain("session:");
  });

  test("steering joins the child's startup deadline instead of a separate polling window", async () => {
    const h = host();
    process.env.FAKE_RPC_STARTUP_DELAY = "2800";
    const started = await h.execute({ command: "spawn", prompt: "SCENARIO=steer", tools: [], startupTimeoutMs: 5000 });
    const handle = started.details.results[0].handle;
    try {
      await h.execute({ command: "steer", id: handle, message: "late readiness" });
      const result = await h.execute({ command: "wait", ids: [handle], timeoutMs: 1000 });
      expect(result.details.results[0].output).toContain("late readiness");
    } finally { await h.execute({ command: "stop", id: handle }); }
  });

  test("relative resumes use the parent cwd and cannot target its active session", async () => {
    const h = host();
    const file = path.join(h.cwd, "parent.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "session", cwd: h.cwd })}\n`);
    h.context.sessionManager.getSessionFile = () => file;
    await expect(h.execute({ command: "run", prompt: "x", tools: [], resume: "parent.jsonl" })).rejects.toThrow("active parent session");
    h.context.sessionManager.getSessionFile = () => undefined;
    const resumed = await h.execute({ command: "run", prompt: "x", tools: [], resume: "parent.jsonl" });
    expect(resumed.details.results[0].state.outcome).toBe("completed");
    expect(resumed.details.results[0].sessionFile).toBe(fs.realpathSync.native(file));
  });

  test("rejects invalid steering and obsolete fields before launch", async () => {
    const h = host();
    await expect(h.execute({ command: "steer", id: "x" })).rejects.toThrow("message");
    await expect(h.execute({ command: "steer", message: "x" })).rejects.toThrow("id");
    await expect(h.execute({ command: "run", prompt: "x", message: "x" })).rejects.toThrow();
    await expect(h.execute({ command: "status", message: "x" })).rejects.toThrow();
    await expect(h.execute({ command: "run", prompt: "x", persist: true, resume: "session.jsonl" })).rejects.toThrow("mutually exclusive");
  });

  test("/subagents lists and clears retained children", async () => {
    const h = host();
    await h.execute({ command: "run", prompt: "hello", tools: [] });
    await h.commands.get("subagents").handler("", { ui: { notify: (message: string) => h.notifications.push(message) } });
    expect(h.notifications.at(-1)).toContain("1 retained");
    await h.commands.get("subagents").handler("clear", { ui: { notify: (message: string) => h.notifications.push(message) } });
    expect(h.notifications.at(-1)).toContain("Cleared 1 read child handle");
  });
});
