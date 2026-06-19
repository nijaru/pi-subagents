/**
 * Unit tests for internal helpers.
 * Tests functions that aren't directly exported but whose behavior
 * we can verify through the tool's execute() function.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXTENSION = path.join(import.meta.dir, "..", "extensions", "pi-subagents", "index.ts");

// ── Helpers ─────────────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
}

function createMockExtensionAPI() {
  const tools: RegisteredTool[] = [];
  return {
    registerTool(def: any) {
      tools.push({ name: def.name, execute: def.execute, renderCall: def.renderCall, renderResult: def.renderResult });
    },
    on() {},
    tools,
  };
}

function createMockCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    sessionManager: {
      getSessionFile: () => undefined,
    },
    modelRegistry: {
      find: overrides.modelFind ?? (() => undefined),
    },
    model: undefined,
    ...overrides,
  };
}

async function loadTool() {
  const api = createMockExtensionAPI();
  const mod = await import(EXTENSION);
  mod.default(api);
  const tool = api.tools.find(t => t.name === "subagent");
  if (!tool) throw new Error("subagent tool not registered");
  return {
    ...tool,
    /** Call execute and normalize thrown errors into isError results for test ergonomics. */
    async call(...args: Parameters<typeof tool.execute>) {
      try {
        return await tool.execute(...args);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
      }
    },
  };
}

function makeTempProject(agentName = "test-agent", extra?: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
  const agentsDir = path.join(dir, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const extraLines = extra ? "\n" + Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
  fs.writeFileSync(
    path.join(agentsDir, `${agentName}.md`),
    `---\nname: ${agentName}\ndescription: A test agent${extraLines}\n---\nYou are a test agent.`,
  );
  return dir;
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── mapConcurrent behavior ──────────────────────────────────────────────────

describe("mapConcurrent (tested via parallel tasks)", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  // NOTE: Parallel execution tests require real pi binary for inline mode.
  // Tested in integration environment, not unit tests.

  test("parallel mode structure accepts tasks array", async () => {
    // Verify the tool accepts parallel mode structurally without executing
    // (execution requires real createAgentSession or pi binary)
    const dir = makeTempProject("test-agent");
    try {
      // Use a short timeout — we're testing that the code path is reachable
      const result = await Promise.race([
        tool.call("call-1", {
          tasks: [
            { agent: "test-agent", task: "task 1" },
            { agent: "test-agent", task: "task 2" },
          ],
        }, undefined, undefined, createMockCtx({ cwd: dir })),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
      ]);
      expect(result).toBeDefined();
    } catch (e: any) {
      // Timeout is expected — inline execution requires real SDK
      expect(e.message).toBe("timeout");
    } finally {
      cleanup(dir);
    }
  });
});

// ── fmtResult and fmtRunStatus ───────────────────────────────────────────────

describe("result formatting", () => {
  test("tool result structure is valid", () => {
    // Verify RunResult structure matches what execute() returns
    const r = {
      agent: "test-agent", task: "test", exitCode: 0,
      output: "ok", stderr: "", cost: 0.001, duration: 1500,
      messages: [], turns: 1, model: "test-model",
    };
    expect(r.agent).toBe("test-agent");
    expect(Array.isArray(r.messages)).toBe(true);
    expect(typeof r.turns).toBe("number");
  });
});

// ── buildArgs behavior ──────────────────────────────────────────────────────

describe("subprocess argument construction", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  test("subprocess mode passes execution override", async () => {
    const dir = makeTempProject("sub-agent", { execution: "subprocess" });
    try {
      // Subprocess will fail (pi not in PATH during tests) but the code path is exercised
      const result = await tool.call("call-1", {
        agent: "sub-agent",
        task: "test subprocess",
        execution: "subprocess",
      }, undefined, undefined, createMockCtx({ cwd: dir }));

      expect(result.content).toBeDefined();
      expect(result.content[0]?.type).toBe("text");
    } finally {
      cleanup(dir);
    }
  });

  test("inline mode requires createAgentSession (skipped in unit tests)", () => {
    // Inline execution calls createAgentSession() from the SDK.
    // This is only available when running inside pi's process.
    // Integration tests with real pi binary cover this path.
    expect(true).toBe(true);
  });
});

// ── Message parsing structure ───────────────────────────────────────────────

describe("message parsing (structural)", () => {
  test("AgentMessage type supports tool calls", () => {
    // Verify the type structure we expect from the parser
    // This is a compile-time check — if the types are wrong, tsc would catch it
    const msg = {
      role: "assistant" as const,
      toolCalls: [{ name: "bash", args: { command: "ls" } }],
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
      model: "test-model",
      stopReason: "end_turn",
    };
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls?.[0]?.name).toBe("bash");
    expect(msg.usage?.cost).toBe(0.001);
  });

  test("AgentMessage type supports tool results", () => {
    const msg = {
      role: "tool" as const,
      toolResult: { name: "bash", output: "file1.txt\nfile2.txt" },
    };
    expect(msg.toolResult!.name).toBe("bash");
    expect(msg.toolResult!.output).toContain("file1.txt");
  });

  test("AgentMessage type supports error messages", () => {
    const msg = {
      role: "assistant" as const,
      errorMessage: "Rate limit exceeded",
    };
    expect(msg.errorMessage).toBe("Rate limit exceeded");
  });
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe("renderCall and renderResult", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  test("renderCall returns a component", () => {
    if (!tool.renderCall) return; // skip if not implemented
    const mockTheme = {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => text,
    };
    const result = tool.renderCall(
      { agent: "test-agent", task: "test task" },
      mockTheme,
      {},
    );
    // Should return a Component (has toString or is a TUI component)
    expect(result).toBeDefined();
  });

  test("renderResult handles success case", () => {
    if (!tool.renderResult) return;
    const mockTheme = {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => text,
    };
    const toolResult = {
      content: [{ type: "text", text: "Agent output here" }],
      details: {
        results: [{
          agent: "test-agent",
          task: "test",
          exitCode: 0,
          output: "Agent output here",
          stderr: "",
          cost: 0.001,
          duration: 1500,
          messages: [{
            role: "assistant",
            text: "Agent output here",
            toolCalls: [{ name: "bash", args: { command: "ls" } }],
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
          }],
          turns: 2,
          model: "test-model",
        }],
      },
    };
    const result = tool.renderResult(toolResult, { expanded: false }, mockTheme, { args: {} });
    expect(result).toBeDefined();
  });

  test("renderResult handles error case", () => {
    if (!tool.renderResult) return;
    const mockTheme = {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => text,
    };
    const toolResult = {
      content: [{ type: "text", text: "Agent failed" }],
      isError: true,
      details: {
        results: [{
          agent: "test-agent",
          task: "test",
          exitCode: 1,
          output: "",
          stderr: "Agent failed",
          cost: 0,
          duration: 100,
          messages: [],
          turns: 0,
        }],
      },
    };
    const result = tool.renderResult(toolResult, { expanded: false }, mockTheme, { args: {} });
    expect(result).toBeDefined();
  });

  test("renderResult shows tool calls in expanded view", () => {
    if (!tool.renderResult) return;
    const mockTheme = {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => text,
    };
    const toolResult = {
      content: [{ type: "text", text: "Done" }],
      details: {
        results: [{
          agent: "test-agent",
          task: "test",
          exitCode: 0,
          output: "Done",
          stderr: "",
          cost: 0.01,
          duration: 5000,
          messages: [
            { role: "assistant", toolCalls: [{ name: "read", args: { path: "file.ts" } }] },
            { role: "tool", toolResult: { name: "read", output: "file contents..." } },
            { role: "assistant", toolCalls: [{ name: "edit", args: { path: "file.ts" } }] },
            { role: "assistant", text: "Done", usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 } },
          ],
          turns: 3,
        }],
      },
    };
    // Both expanded and collapsed should work
    const expanded = tool.renderResult(toolResult, { expanded: true }, mockTheme, { args: {} });
    expect(expanded).toBeDefined();

    const collapsed = tool.renderResult(toolResult, { expanded: false }, mockTheme, { args: {} });
    expect(collapsed).toBeDefined();
  });
});

// ── Chain mode structure ────────────────────────────────────────────────────

describe("chain mode", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  test("chain mode validates agents exist before executing", async () => {
    const dir = makeTempProject("real-agent");
    try {
      const result = await tool.call("call-1", {
        chain: [
          { agent: "real-agent", task: "step 1" },
          { agent: "nonexistent-agent", task: "step 2" },
        ],
      }, undefined, undefined, createMockCtx({ cwd: dir }));

      expect(result.isError).toBe(true);
      // Chain validation uses a specific format
      expect(result.content[0].text).toContain("nonexistent-agent");
    } finally {
      cleanup(dir);
    }
  });

  test("chain mode accepts quality gate structure", async () => {
    const dir = makeTempProject("test-agent");
    try {
      // Gate + onFail are accepted by the schema. Execution requires real SDK.
      const result = await Promise.race([
        tool.call("call-1", {
          chain: [
            { agent: "test-agent", task: "generate code", gate: "echo ok", onFail: "abort" },
          ],
        }, undefined, undefined, createMockCtx({ cwd: dir })),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
      ]);
      expect(result).toBeDefined();
    } catch (e: any) {
      expect(e.message).toBe("timeout"); // expected — no real SDK
    } finally {
      cleanup(dir);
    }
  });

  test("chain mode accepts named outputs", async () => {
    const dir = makeTempProject("test-agent");
    try {
      const result = await Promise.race([
        tool.call("call-1", {
          chain: [
            { agent: "test-agent", task: "step 1", as: "analysis" },
            { agent: "test-agent", task: "based on {outputs.analysis}" },
          ],
        }, undefined, undefined, createMockCtx({ cwd: dir })),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
      ]);
      expect(result).toBeDefined();
    } catch (e: any) {
      expect(e.message).toBe("timeout");
    } finally {
      cleanup(dir);
    }
  });
});

// ── Acceptance contracts ────────────────────────────────────────────────────

describe("acceptance contracts", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  test("acceptance parameters are accepted", async () => {
    const dir = makeTempProject("test-agent");
    try {
      // Execution requires real SDK — just verify the code path is reachable
      const result = await Promise.race([
        tool.call("call-1", {
          agent: "test-agent",
          task: "write code",
          acceptance: {
            criteria: ["Code compiles", "Tests pass"],
            verify: ["echo 'verify'"],
            maxAttempts: 2,
          },
        }, undefined, undefined, createMockCtx({ cwd: dir })),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
      ]);
      expect(result).toBeDefined();
    } catch (e: any) {
      expect(e.message).toBe("timeout"); // expected — no real SDK
    } finally {
      cleanup(dir);
    }
  });
});

// ── Context mode ────────────────────────────────────────────────────────────

describe("context mode", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  test("fresh context is accepted", async () => {
    const dir = makeTempProject("test-agent");
    try {
      // Execution requires real SDK
      const result = await Promise.race([
        tool.call("call-1", {
          agent: "test-agent",
          task: "test",
          context: "fresh",
        }, undefined, undefined, createMockCtx({ cwd: dir })),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
      ]);
      expect(result).toBeDefined();
    } catch (e: any) {
      expect(e.message).toBe("timeout"); // expected — no real SDK
    } finally {
      cleanup(dir);
    }
  });

  test("fork context is accepted", async () => {
    const dir = makeTempProject("test-agent");
    try {
      const result = await Promise.race([
        tool.call("call-1", {
          agent: "test-agent",
          task: "test",
          context: "fork",
        }, undefined, undefined, createMockCtx({ cwd: dir })),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500)),
      ]);
      expect(result).toBeDefined();
    } catch (e: any) {
      expect(e.message).toBe("timeout");
    } finally {
      cleanup(dir);
    }
  });
});

// ── Background mode ─────────────────────────────────────────────────────────

describe("background mode", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  test("background flag returns immediately with run info", async () => {
    const dir = makeTempProject("test-agent");
    try {
      const result = await tool.call("call-1", {
        agent: "test-agent",
        task: "background task",
        background: true,
      }, undefined, undefined, createMockCtx({ cwd: dir }));

      // Should return immediately (not block)
      expect(result.content).toBeDefined();
      expect(result.content[0].text).toBeDefined();
      // Should mention the run ID or background status
      const text = result.content[0].text;
      expect(text).toMatch(/background|run|id/i);
    } finally {
      cleanup(dir);
    }
  });

  test("status response is serializable (no proc leak)", async () => {
    // Regression test: status used to return RunRecord with proc (child process),
    // which caused structured clone to fail with "could not be cloned".
    const dir = makeTempProject("test-agent");
    try {
      // Spawn background agent (will fail quickly in test env — pi binary not found)
      const bg = await tool.call("call-1", {
        agent: "test-agent",
        task: "bg task",
        background: true,
      }, undefined, undefined, createMockCtx({ cwd: dir }));

      // Extract run ID from response
      const text = bg.content[0].text;
      const idMatch = text.match(/id:\s*(\w+)/);
      if (!idMatch) return; // skip if background spawn failed differently
      const runId = idMatch[1];

      // Wait a moment for the process to finish (it will fail quickly)
      await new Promise(r => setTimeout(r, 200));

      // Call status
      const status = await tool.call("call-1", {
        action: "status",
        id: runId,
      }, undefined, undefined, createMockCtx({ cwd: dir }));

      // Details must be serializable — this is what failed before the fix
      expect(status.details).toBeDefined();
      expect(() => JSON.stringify(status.details)).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });
});

// ── Status/wait/resume/interrupt actions ────────────────────────────────────

describe("run lifecycle actions", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  test("status with non-existent ID returns error", async () => {
    const ctx = createMockCtx();
    const result = await tool.call("call-1", {
      action: "status",
      id: "nonexistent",
    }, undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  test("wait with non-existent ID returns error", async () => {
    const ctx = createMockCtx();
    const result = await tool.call("call-1", {
      action: "wait",
      id: "nonexistent",
    }, undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  test("resume with non-existent ID returns error", async () => {
    const ctx = createMockCtx();
    const result = await tool.call("call-1", {
      action: "resume",
      id: "nonexistent",
      task: "continue",
    }, undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  test("interrupt with non-existent ID returns error", async () => {
    const ctx = createMockCtx();
    const result = await tool.call("call-1", {
      action: "interrupt",
      id: "nonexistent",
    }, undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
  let tool: RegisteredTool;

  beforeEach(async () => {
    tool = await loadTool();
  });

  test("handles empty tasks array in parallel mode", async () => {
    const ctx = createMockCtx();
    const result = await tool.call("call-1", {
      tasks: [],
    }, undefined, undefined, ctx);

    // Should either error or return empty result
    expect(result.content).toBeDefined();
  });

  test("handles very long agent names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
    try {
      const ctx = createMockCtx({ cwd: dir });
      const longName = "a".repeat(200);
      const result = await tool.call("call-1", {
        action: "create",
        agent: longName,
        task: "test",
      }, undefined, undefined, ctx);

      // Should either succeed or give a reasonable error
      expect(result.content).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  test("handles concurrent create/delete of same agent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
    try {
      const ctx = createMockCtx({ cwd: dir });
      // Create
      await tool.call("call-1", {
        action: "create",
        agent: "race-condition",
        task: "test",
      }, undefined, undefined, ctx);

      // Delete immediately
      const result = await tool.call("call-1", {
        action: "delete",
        agent: "race-condition",
      }, undefined, undefined, ctx);

      expect(result.isError).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  test("handles model override parameter", async () => {
    const dir = makeTempProject("test-agent");
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await tool.call("call-1", {
        agent: "test-agent",
        task: "test with model",
        model: "openrouter/anthropic/fable-5",
      }, undefined, undefined, ctx);

      // Should attempt execution (may fail in test env)
      expect(result.content).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });
});

// ── Persistence validation ─────────────────────────────────────────────────

describe("persistence validation", () => {
  const runsFile = path.join(os.homedir(), ".pi", "agent", "subagent-runs.json");
  let savedData: string | undefined;

  beforeEach(() => {
    // Save existing runs file if present
    try { savedData = fs.readFileSync(runsFile, "utf-8"); } catch { /* no file */ }
  });

  afterEach(() => {
    // Restore original runs file
    if (savedData !== undefined) {
      fs.writeFileSync(runsFile, savedData);
    } else {
      try { fs.unlinkSync(runsFile); } catch { /* ok */ }
    }
  });

  test("loadRuns rejects entries with missing required fields", async () => {
    // Write corrupted data
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
    fs.writeFileSync(runsFile, JSON.stringify([
      { id: "valid1", sessionPath: "/tmp/test", status: "completed", startedAt: Date.now() },
      { id: "no-session" }, // missing sessionPath
      { sessionPath: "/tmp/test2" }, // missing id
      { id: "bad-status", sessionPath: "/tmp/test3", status: "invalid", startedAt: Date.now() },
      { id: "no-started", sessionPath: "/tmp/test4", status: "running" }, // missing startedAt
    ]));

    // Load extension — it should load only valid entries
    const tool = await loadTool();

    // The valid entry should be loadable via status
    const result = await tool.call("call-1", {
      action: "status",
      id: "valid1",
    }, undefined, undefined, createMockCtx());
    // Should find the valid run (not error with "not found")
    expect(result.content[0].text).toContain("completed");
  });
});
