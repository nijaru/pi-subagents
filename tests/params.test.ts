import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { selectTools } from "../extensions/pi-subagents/params.ts";
import { childEnvironment } from "../extensions/pi-subagents/env.ts";
import { isChildProcess, processTimeoutMs, DEFAULT_PROCESS_TIMEOUT_MS } from "../extensions/pi-subagents/limits.ts";

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
    expect(selectTools(undefined, ["read", "bash", "edit", "write", "subagent", "intercom", "web_search"])).toEqual(["read", "bash", "edit", "write", "web_search"]);
    expect(selectTools(undefined, ["read"])).toEqual(["read"]);
    expect(() => selectTools(undefined, [])).toThrow("tools: []");
    expect(selectTools([], [])).toEqual([]);
  });
  test("explicit extension tools must be active, not merely installed", () => {
    expect(selectTools(["query-docs"], ["read", "query-docs"])).toEqual(["query-docs"]);
    expect(() => selectTools(["query-docs"], ["read"])).toThrow("active in the parent");
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
    fs.writeFileSync(path.join(dir, "models.json"), '{ // JSONC\n "providers": {"custom": {"apiKey": "$CHILD_TEST_MODEL_SECRET", "headers":{"x-key":"$child_test_header"}, "models": [], }, }, }');
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
