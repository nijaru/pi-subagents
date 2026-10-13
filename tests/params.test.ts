import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { selectTools, validateCommand, SubagentParamsSchema } from "../extensions/pi-subagents/params.ts";
import { Check } from "typebox/value";
import { childEnvironment } from "../extensions/pi-subagents/env.ts";
import { isChildProcess, processTimeoutMs, DEFAULT_PROCESS_TIMEOUT_MS, MAX_PROCESS_TIMEOUT_MS } from "../extensions/pi-subagents/limits.ts";

let env: NodeJS.ProcessEnv;
const dirs: string[] = [];
beforeEach(() => { env = { ...process.env }; });
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tool selection", () => {
  test("has usable defaults without enabling control tools", () => {
    expect(selectTools(undefined, ["read", "bash", "edit", "write", "subagent", "intercom", "web_search"], ["mcp__server__lookup"])).toEqual(["read", "bash", "edit", "write", "web_search"]);
    expect(selectTools(undefined, ["read"], ["web_search"])).toEqual(["read"]);
    expect(() => selectTools(undefined, [], ["mcp__server__lookup"])).toThrow("tools: []");
    expect(selectTools([], [], [])).toEqual([]);
  });
  test("explicit tools may be active or callable, but not merely registered", () => {
    expect(selectTools(["query-docs"], ["read", "query-docs"], [])).toEqual(["query-docs"]);
    expect(selectTools(["mcp__server__lookup"], ["read"], ["mcp__server__lookup"])).toEqual(["mcp__server__lookup"]);
    expect(() => selectTools(["query-docs"], ["read"], [])).toThrow("active or callable in the parent");
    expect(() => selectTools(["subagent"], ["subagent"], ["subagent"])).toThrow("leaves");
  });
  test("malformed and nested depth markers fail closed", () => {
    delete process.env.PI_SUBAGENT_DEPTH;
    expect(isChildProcess()).toBe(false);
    process.env.PI_SUBAGENT_DEPTH = "0";
    expect(isChildProcess()).toBe(false);
    for (const value of ["", "-1", "1", "1.5", "abc", "9007199254740992"]) {
      process.env.PI_SUBAGENT_DEPTH = value;
      expect(isChildProcess()).toBe(true);
    }
  });
  test("invalid timeout configuration cannot disable the deadline", () => {
    for (const value of ["0", "-1", "Infinity", "1.5", "99999999999"]) {
      process.env.PI_SUBAGENT_TIMEOUT_MS = value;
      expect(processTimeoutMs()).toBe(DEFAULT_PROCESS_TIMEOUT_MS);
    }
    process.env.PI_SUBAGENT_TIMEOUT_MS = "1234";
    expect(processTimeoutMs()).toBe(1234);
  });
  test("executionTimeoutMs is a run/spawn option within the two-hour bound", () => {
    expect(Check(SubagentParamsSchema, { command: "run", prompt: "x", executionTimeoutMs: 1 })).toBe(true);
    expect(Check(SubagentParamsSchema, { command: "spawn", prompt: "x", executionTimeoutMs: MAX_PROCESS_TIMEOUT_MS })).toBe(true);
    for (const value of [0, -1, 1.5, "1000", MAX_PROCESS_TIMEOUT_MS + 1]) {
      expect(Check(SubagentParamsSchema, { command: "run", prompt: "x", executionTimeoutMs: value })).toBe(false);
    }
    expect(() => validateCommand({ command: "run", prompt: "x", executionTimeoutMs: 1000 })).not.toThrow();
    expect(() => validateCommand({ command: "spawn", prompt: "x", executionTimeoutMs: 1000 })).not.toThrow();
    expect(() => validateCommand({ command: "run", prompt: "x", timeoutMs: 1000 })).toThrow("executionTimeoutMs");
    expect(() => validateCommand({ command: "wait", ids: ["x"], executionTimeoutMs: 1000 })).toThrow("does not accept child creation options");
    expect(() => validateCommand({ command: "status", executionTimeoutMs: 1000 })).toThrow("does not accept child creation options");
    expect(() => validateCommand({ command: "stop", id: "x", executionTimeoutMs: 1000 })).toThrow("does not accept child creation options");
  });
});

describe("child environment", () => {
  test("forwards model refs and credentials, not unrelated application state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-children-env-")); dirs.push(dir);
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.CHILD_TEST_MODEL_SECRET = "model-secret";
    process.env.child_test_header = "header-secret";
    process.env.CHILD_TEST_API_KEY = "api-key";
    process.env.CHILD_TEST_TOKEN = "token";
    process.env.CHILD_TEST_APP_VALUE = "private-app-state";
    delete process.env.PI_SUBAGENT_PASSTHROUGH_ENV;
    fs.writeFileSync(path.join(dir, "models.json"), '\uFEFF{ // JSONC\n "providers": {"custom": {"apiKey": "$CHILD_TEST_MODEL_SECRET", "headers":{"x-key":"$child_test_header"}, "models": [], }, }, }');
    const child = childEnvironment("child-1", dir);
    expect(child.CHILD_TEST_MODEL_SECRET).toBe("model-secret");
    expect(child.child_test_header).toBe("header-secret");
    expect(child.CHILD_TEST_API_KEY).toBe("api-key");
    expect(child.CHILD_TEST_TOKEN).toBe("token");
    expect(child.CHILD_TEST_APP_VALUE).toBeUndefined();
    expect(child.PI_SUBAGENT_DEPTH).toBe("1");
    expect(child.PI_SUBAGENT_RUN_ID).toBe("child-1");
    expect(child.PWD).toBe(dir);
  });
  test("explicit passthrough supports globs but cannot override the child marker", () => {
    process.env.CHILD_TEST_APP_VALUE = "allowed";
    process.env.PI_SUBAGENT_DEPTH = "0";
    process.env.PI_SUBAGENT_PASSTHROUGH_ENV = "CHILD_TEST_*,PI_SUBAGENT_DEPTH";
    const child = childEnvironment("id", process.cwd());
    expect(child.CHILD_TEST_APP_VALUE).toBe("allowed");
    expect(child.PI_SUBAGENT_DEPTH).toBe("1");
  });
});
