import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { excludedChildTools, MCP_RESOURCE_TOOLS, resolveCwd, selectTools, validateCommand, SubagentParamsSchema } from "../extensions/pi-subagents/params.ts";
import { Check } from "typebox/value";
import { childEnvironment } from "../extensions/pi-subagents/env.ts";
import { isChildProcess, processTimeoutMs, TIMEOUT_ENV, STARTUP_TIMEOUT_ENV, startupTimeoutMs, MAX_PROCESS_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS, foregroundBudgetMs, DEFAULT_FOREGROUND_MS, MAX_WAIT_MS } from "../extensions/pi-subagents/limits.ts";

let env: NodeJS.ProcessEnv;
beforeEach(() => { env = { ...process.env }; });
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});

describe("tool selection", () => {
  test("has usable defaults without enabling control tools", () => {
    expect(selectTools(undefined, ["read", "bash", "edit", "write", "subagent", "intercom", "web_search"], ["mcp__server__lookup"])).toEqual(["read", "web_search"]);
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
  test.each([
    [STARTUP_TIMEOUT_ENV, startupTimeoutMs, 30_000, MAX_STARTUP_TIMEOUT_MS],
    ["PI_SUBAGENT_FOREGROUND_MS", foregroundBudgetMs, DEFAULT_FOREGROUND_MS, MAX_WAIT_MS],
  ] as const)("invalid %s cannot disable or overflow its timer", (key, read, fallback, maximum) => {
    for (const value of ["0", "-1", "Infinity", "1.5", String(maximum + 1), "2147483648"]) {
      process.env[key] = value;
      expect(read()).toBe(fallback);
    }
    process.env[key] = "1234";
    expect(read()).toBe(1234);
    process.env[key] = String(maximum);
    expect(read()).toBe(maximum);
  });
  test("execution deadlines are off unless explicitly configured", () => {
    delete process.env[TIMEOUT_ENV];
    expect(processTimeoutMs()).toBeUndefined();
    for (const value of [1, 1234, MAX_PROCESS_TIMEOUT_MS]) {
      process.env[TIMEOUT_ENV] = String(value);
      expect(processTimeoutMs()).toBe(value);
    }
  });
  test("invalid execution deadline configuration cannot silently remove an intended limit", () => {
    for (const value of ["", "0", "-1", "Infinity", "1.5", "garbage", String(MAX_PROCESS_TIMEOUT_MS + 1), "2147483648"]) {
      process.env[TIMEOUT_ENV] = value;
      expect(() => processTimeoutMs()).toThrow(TIMEOUT_ENV);
    }
  });
  test("executionTimeoutMs is a run/spawn option within the two-hour bound", () => {
    expect(Check(SubagentParamsSchema, { command: "run", prompt: "x", executionTimeoutMs: 1 })).toBe(true);
    expect(Check(SubagentParamsSchema, { command: "spawn", prompt: "x", executionTimeoutMs: MAX_PROCESS_TIMEOUT_MS })).toBe(true);
    for (const value of [0, -1, 1.5, MAX_PROCESS_TIMEOUT_MS + 1]) {
      expect(() => validateCommand({ command: "run", prompt: "x", executionTimeoutMs: value })).toThrow("executionTimeoutMs");
    }
    expect(Check(SubagentParamsSchema, { command: "run", prompt: "x", executionTimeoutMs: "1000" })).toBe(false);
    expect(() => validateCommand({ command: "run", prompt: "x", executionTimeoutMs: 1000 })).not.toThrow();
    expect(() => validateCommand({ command: "spawn", prompt: "x", executionTimeoutMs: 1000 })).not.toThrow();
    expect(() => validateCommand({ command: "run", prompt: "x", timeoutMs: 1000 })).toThrow("child creation options");
    expect(() => validateCommand({ command: "wait", ids: ["x"], executionTimeoutMs: 1000 })).toThrow("does not accept child creation or join options");
    expect(() => validateCommand({ command: "status", executionTimeoutMs: 1000 })).toThrow("does not accept child creation or join options");
    expect(() => validateCommand({ command: "stop", id: "x", executionTimeoutMs: 1000 })).toThrow("does not accept child creation or join options");
  });
  test("startup and join options are scoped; removed notification options are rejected", () => {
    for (const value of [1, 1000, MAX_STARTUP_TIMEOUT_MS]) {
      expect(Check(SubagentParamsSchema, { command: "run", prompt: "x", startupTimeoutMs: value })).toBe(true);
    }
    for (const value of [0, -1, 1.5, MAX_STARTUP_TIMEOUT_MS + 1]) {
      expect(() => validateCommand({ command: "spawn", prompt: "x", startupTimeoutMs: value })).toThrow("startupTimeoutMs");
    }
    expect(Check(SubagentParamsSchema, { command: "run", prompt: "x", joinTimeoutMs: 1000 })).toBe(true);
    expect(() => validateCommand({ command: "spawn", prompt: "x", joinTimeoutMs: 1000 })).toThrow("spawn does not join");
    expect(Check(SubagentParamsSchema, { command: "spawn", prompt: "x", notify: "turn" })).toBe(false);
  });
});

describe("provider-neutral argument limits", () => {
  test.each([
    ["model", 512], ["cwd", 4096], ["id", 128], ["resume", 4096], ["label", 80],
  ] as const)("%s retains its length bounds outside the sampling schema", (field, maximum) => {
    const base = field === "id" ? { command: "status" } : { command: "run", prompt: "x" };
    expect(() => validateCommand({ ...base, [field]: "x".repeat(maximum) } as any)).not.toThrow();
    for (const value of ["", "x".repeat(maximum + 1)]) {
      const input = { ...base, [field]: value } as any;
      expect(Check(SubagentParamsSchema, input)).toBe(true);
      expect(() => validateCommand(input)).toThrow(field);
    }
  });
  test("labels are display-only, nonblank, one-line Unicode strings scoped to launch", () => {
    for (const label of ["review", "🙂".repeat(80)]) expect(() => validateCommand({ command: "run", prompt: "x", label })).not.toThrow();
    for (const label of ["  ", "line\nbreak", "escape\x1b", "control\u0085", "line\u2028break", "paragraph\u2029break"]) {
      expect(() => validateCommand({ command: "run", prompt: "x", label })).toThrow("label");
    }
    for (const input of [{ command: "status" }, { command: "wait", ids: ["sa-1"] }, { command: "stop", id: "sa-1" }, { command: "steer", id: "sa-1", message: "x" }]) {
      expect(() => validateCommand({ ...input, label: "review" } as any)).toThrow("does not accept child creation");
    }
  });
  test("arrays preserve cardinality, item limits, name syntax, and duplicate rejection", () => {
    for (const tools of [[], ["read"], ["a".repeat(256)]]) expect(() => validateCommand({ command: "run", prompt: "x", tools })).not.toThrow();
    for (const tools of [["read", "read"], [""], ["a".repeat(257)], ["bad name"], ["9bad"], Array.from({ length: 65 }, (_, i) => `tool${i}`)]) {
      expect(() => validateCommand({ command: "run", prompt: "x", tools })).toThrow("tools");
    }
    expect(() => validateCommand({ command: "wait", ids: Array.from({ length: 32 }, (_, i) => `sa-${i}`) })).not.toThrow();
    for (const ids of [[], ["sa-1", "sa-1"], [""], ["x".repeat(129)], Array.from({ length: 33 }, (_, i) => `sa-${i}`)]) {
      expect(() => validateCommand({ command: "wait", ids })).toThrow("ids");
    }
  });
  test.each([
    ["timeoutMs", { command: "wait", ids: ["sa-1"] }, MAX_WAIT_MS],
    ["joinTimeoutMs", { command: "run", prompt: "x" }, MAX_WAIT_MS],
    ["startupTimeoutMs", { command: "spawn", prompt: "x" }, MAX_STARTUP_TIMEOUT_MS],
    ["executionTimeoutMs", { command: "run", prompt: "x" }, MAX_PROCESS_TIMEOUT_MS],
  ])("%s enforces integer clock limits before launch or joining", (field, base, maximum) => {
    for (const value of [1, maximum]) expect(() => validateCommand({ ...base, [field]: value } as any)).not.toThrow();
    for (const value of [0, -1, 1.5, maximum + 1, Infinity, NaN]) expect(() => validateCommand({ ...base, [field]: value } as any)).toThrow(field);
  });
  test("task and steering byte limits still apply to multibyte text", () => {
    expect(() => validateCommand({ command: "run", prompt: "x".repeat(102400) })).not.toThrow();
    expect(() => validateCommand({ command: "run", prompt: "界".repeat(40000) })).toThrow("prompt");
    expect(() => validateCommand({ command: "steer", id: "sa-1", message: "🙂".repeat(30000) })).toThrow("message");
    expect(() => validateCommand({ command: "run", prompt: "x", message: "" })).toThrow("child creation options");
  });
});

describe("working directory resolution", () => {
  test("distinguishes an existing file from a missing path", () => {
    expect(() => resolveCwd(import.meta.dir, "../package.json")).toThrow("not a directory");
    expect(() => resolveCwd(import.meta.dir, "../missing-cwd-for-test")).toThrow("does not exist");
  });
});

describe("child environment", () => {
  test("inherits provider, tool and shell configuration without credential heuristics", () => {
    process.env.PI_CODING_AGENT_DIR = "/custom-agent";
    process.env.CHILD_TEST_MODEL_SECRET = "model-secret";
    process.env.child_test_header = "header-secret";
    process.env.CHILD_TEST_API_KEY = "api-key";
    process.env.CHILD_TEST_TOKEN = "token";
    process.env.CHILD_TEST_APP_VALUE = "private-app-state";
    const child = childEnvironment("child-1", "/child");
    expect(child.PI_CODING_AGENT_DIR).toBe("/custom-agent");
    expect(child.CHILD_TEST_MODEL_SECRET).toBe("model-secret");
    expect(child.child_test_header).toBe("header-secret");
    expect(child.CHILD_TEST_API_KEY).toBe("api-key");
    expect(child.CHILD_TEST_TOKEN).toBe("token");
    expect(child.CHILD_TEST_APP_VALUE).toBe("private-app-state");
    expect(child.PI_SUBAGENT_DEPTH).toBe("1");
    expect(child.PI_SUBAGENT_RUN_ID).toBe("child-1");
    expect(child.PWD).toBe("/child");
  });
  test("does not lend parent session identity or mutate its environment", () => {
    process.env.PI_SESSION_ID = "parent-session";
    process.env.PI_INTERCOM_SESSION_ID = "parent-intercom";
    process.env.PI_SUBAGENT_DEPTH = "0";
    const child = childEnvironment("id", "/child");
    expect(child.PI_SESSION_ID).toBeUndefined();
    expect(child.PI_INTERCOM_SESSION_ID).toBeUndefined();
    expect(child.PI_SUBAGENT_DEPTH).toBe("1");
    expect(child.PWD).toBe("/child");
    expect(process.env.PI_SESSION_ID).toBe("parent-session");
    expect(process.env.PI_SUBAGENT_DEPTH).toBe("0");
  });
});

describe("steering, persistence, and trust policy", () => {
  test("accepts steer with id and message only", () => {
    expect(() => validateCommand({ command: "steer", id: "sa-1", message: "focus" } as any)).not.toThrow();
    expect(() => validateCommand({ command: "steer", message: "focus" } as any)).toThrow("id");
    expect(() => validateCommand({ command: "steer", id: "sa-1" } as any)).toThrow("message");
  });
  test("rejects persist/resume on non-start commands and both together", () => {
    expect(() => validateCommand({ command: "status", id: "sa-1", persist: true } as any)).toThrow();
    for (const persist of [true, false]) expect(() => validateCommand({ command: "run", prompt: "x", persist, resume: "s.jsonl" })).toThrow("mutually exclusive");
    expect(() => validateCommand({ command: "run", prompt: "x", trustProject: true } as any)).not.toThrow();
  });
});


describe("nested MCP tool exclusions", () => {
  test("no selected MCP tool denies the wildcard, unselected direct, and resource tools", () => {
    const excluded = excludedChildTools(["read"], ["read", "unselected_direct", "mcp__server__a", "mcp__server__b", ...MCP_RESOURCE_TOOLS]);
    expect(excluded).toContain("mcp__*");
    expect(excluded).toContain("mcp__server__a");
    expect(excluded).toContain("mcp__server__b");
    expect(excluded).toContain("unselected_direct");
    for (const name of MCP_RESOURCE_TOOLS) expect(excluded).toContain(name);
  });
  test("selected MCP tools deny only their unselected siblings", () => {
    const excluded = excludedChildTools(["mcp__server__a"], ["mcp__server__a", "mcp__server__b", ...MCP_RESOURCE_TOOLS]);
    expect(excluded).not.toContain("mcp__*");
    expect(excluded).not.toContain("mcp__server__a");
    expect(excluded).toContain("mcp__server__b");
    for (const name of MCP_RESOURCE_TOOLS) expect(excluded).toContain(name);
  });
  test("a selected resource tool is not excluded", () => {
    const excluded = excludedChildTools(["list_mcp_resources"], [...MCP_RESOURCE_TOOLS, "mcp__server__a"]);
    expect(excluded).not.toContain("list_mcp_resources");
    expect(excluded).toContain("read_mcp_resource");
    expect(excluded).toContain("mcp__server__a");
  });
});
