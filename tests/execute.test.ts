/**
 * Integration tests for the subagent tool's execute() function.
 *
 * These test the actual tool handler with mocked ExtensionContext,
 * catching runtime errors that unit tests on helpers miss.
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
}

function createMockExtensionAPI() {
  const tools: RegisteredTool[] = [];
  return {
    registerTool(def: any) {
      tools.push({ name: def.name, execute: def.execute });
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
      find: () => undefined,
    },
    model: undefined,
    ...overrides,
  };
}

/** Load the extension and return the registered tool's execute function. */
async function loadTool() {
  const api = createMockExtensionAPI();
  const mod = await import(EXTENSION);
  mod.default(api);
  const tool = api.tools.find(t => t.name === "subagent");
  if (!tool) throw new Error("subagent tool not registered");
  return tool.execute;
}

/** Create a temp dir with an agent .md file for testing. */
function makeTempProject(agentName = "test-agent", model?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
  const agentsDir = path.join(dir, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const modelLine = model ? `\nmodel: ${model}` : "";
  fs.writeFileSync(
    path.join(agentsDir, `${agentName}.md`),
    `---\nname: ${agentName}\ndescription: A test agent${modelLine}\n---\nYou are a test agent.`,
  );
  return dir;
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("execute — ctx.cwd handling", () => {
  let execute: (...args: any[]) => Promise<any>;

  beforeEach(async () => {
    execute = await loadTool();
  });

  test("works when ctx.cwd is undefined (the original paths[0] bug)", async () => {
    const ctx = createMockCtx({ cwd: undefined });
    // This used to throw: The "paths[0]" argument must be of type string. Received undefined
    const result = await execute("call-1", { action: "list" }, undefined, undefined, ctx);
    expect(result.isError).toBeUndefined(); // success, not error
    expect(result.content[0].text).toContain("Available agents:");
  });

  test("works when ctx.cwd is a valid path", async () => {
    const dir = makeTempProject();
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await execute("call-1", { action: "list" }, undefined, undefined, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("test-agent");
    } finally {
      cleanup(dir);
    }
  });
});

describe("execute — action: list", () => {
  let execute: (...args: any[]) => Promise<any>;

  beforeEach(async () => {
    execute = await loadTool();
  });

  test("lists agents from project .pi/agents/", async () => {
    const dir = makeTempProject("my-agent");
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await execute("call-1", { action: "list" }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("my-agent");
      expect(result.content[0].text).toContain("A test agent");
    } finally {
      cleanup(dir);
    }
  });

  test("lists bundled agents when project has no agents", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await execute("call-1", { action: "list" }, undefined, undefined, ctx);
      // Bundled agents are always discovered (from the extension's agents/ dir)
      expect(result.content[0].text).toContain("Available agents:");
      expect(result.content[0].text).toContain("reviewer");
    } finally {
      cleanup(dir);
    }
  });
});

describe("execute — action: create", () => {
  let execute: (...args: any[]) => Promise<any>;
  let dir: string;

  beforeEach(async () => {
    execute = await loadTool();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
  });

  afterEach(() => cleanup(dir));

  test("creates agent with task and prompt", async () => {
    const ctx = createMockCtx({ cwd: dir });
    const result = await execute("call-1", {
      action: "create",
      agent: "my-reviewer",
      task: "Code review agent",
      prompt: "You review code carefully.",
    }, undefined, undefined, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Created agent");

    // Verify the file was written correctly
    const fp = path.join(dir, ".pi", "agents", "my-reviewer.md");
    expect(fs.existsSync(fp)).toBe(true);
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("name: my-reviewer");
    expect(content).toContain("description: Code review agent");
    expect(content).toContain("You review code carefully.");
  });

  test("creates agent with only prompt (task auto-derived)", async () => {
    const ctx = createMockCtx({ cwd: dir });
    const result = await execute("call-1", {
      action: "create",
      agent: "oracle",
      prompt: "You provide second opinions.",
    }, undefined, undefined, ctx);

    expect(result.isError).toBeUndefined();
    const fp = path.join(dir, ".pi", "agents", "oracle.md");
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("description: oracle agent");
  });

  test("creates agent with only task (no system prompt)", async () => {
    const ctx = createMockCtx({ cwd: dir });
    const result = await execute("call-1", {
      action: "create",
      agent: "helper",
      task: "A helper agent",
    }, undefined, undefined, ctx);

    expect(result.isError).toBeUndefined();
    const fp = path.join(dir, ".pi", "agents", "helper.md");
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("description: A helper agent");
  });

  test("rejects create with neither task nor prompt", async () => {
    const ctx = createMockCtx({ cwd: dir });
    const result = await execute("call-1", {
      action: "create",
      agent: "broken",
    }, undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("task");
    expect(result.content[0].text).toContain("prompt");
  });

  test("rejects create for already-existing agent", async () => {
    const dir2 = makeTempProject("existing");
    try {
      const ctx = createMockCtx({ cwd: dir2 });
      const result = await execute("call-1", {
        action: "create",
        agent: "existing",
        prompt: "Duplicate",
      }, undefined, undefined, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("already exists");
    } finally {
      cleanup(dir2);
    }
  });

  test("escapes YAML special characters in name/description", async () => {
    const ctx = createMockCtx({ cwd: dir });
    const result = await execute("call-1", {
      action: "create",
      agent: "my:agent",
      task: "Has: colons and \"quotes\"",
      prompt: "Test",
    }, undefined, undefined, ctx);

    expect(result.isError).toBeUndefined();
    const fp = path.join(dir, ".pi", "agents", "my:agent.md");
    const content = fs.readFileSync(fp, "utf-8");
    // The frontmatter should be valid YAML (quoted)
    expect(content).toContain('name: "my:agent"');
    expect(content).toContain('description: "Has: colons and \\"quotes\\""');
  });
});

describe("execute — action: delete", () => {
  let execute: (...args: any[]) => Promise<any>;

  beforeEach(async () => {
    execute = await loadTool();
  });

  test("deletes an existing agent", async () => {
    const dir = makeTempProject("doomed");
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await execute("call-1", {
        action: "delete",
        agent: "doomed",
      }, undefined, undefined, ctx);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Deleted");
      expect(fs.existsSync(path.join(dir, ".pi", "agents", "doomed.md"))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("errors on non-existent agent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await execute("call-1", {
        action: "delete",
        agent: "nonexistent",
      }, undefined, undefined, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    } finally {
      cleanup(dir);
    }
  });
});

describe("execute — action: update", () => {
  let execute: (...args: any[]) => Promise<any>;

  beforeEach(async () => {
    execute = await loadTool();
  });

  test("updates agent description", async () => {
    const dir = makeTempProject("updatable");
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await execute("call-1", {
        action: "update",
        agent: "updatable",
        task: "Updated description",
      }, undefined, undefined, ctx);

      expect(result.isError).toBeUndefined();
      const content = fs.readFileSync(path.join(dir, ".pi", "agents", "updatable.md"), "utf-8");
      expect(content).toContain("Updated description");
    } finally {
      cleanup(dir);
    }
  });
});

describe("execute — mode validation", () => {
  let execute: (...args: any[]) => Promise<any>;

  beforeEach(async () => {
    execute = await loadTool();
  });

  test("errors when no mode specified", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await execute("call-1", {}, undefined, undefined, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("exactly one mode");
    } finally {
      cleanup(dir);
    }
  });

  test("errors when agent not found", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
    try {
      const ctx = createMockCtx({ cwd: dir });
      const result = await execute("call-1", {
        agent: "nonexistent",
        task: "do something",
      }, undefined, undefined, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown agent");
      expect(result.content[0].text).toContain("Available:");
    } finally {
      cleanup(dir);
    }
  });
});

describe("execute — agent discovery walks up directories", () => {
  let execute: (...args: any[]) => Promise<any>;

  beforeEach(async () => {
    execute = await loadTool();
  });

  test("finds agents in parent directory", async () => {
    const root = makeTempProject("parent-agent");
    const subdir = path.join(root, "src", "deep");
    fs.mkdirSync(subdir, { recursive: true });
    try {
      const ctx = createMockCtx({ cwd: subdir });
      const result = await execute("call-1", { action: "list" }, undefined, undefined, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("parent-agent");
    } finally {
      cleanup(root);
    }
  });

  test("delete finds agent in parent directory", async () => {
    const root = makeTempProject("deleteme");
    const subdir = path.join(root, "src");
    fs.mkdirSync(subdir, { recursive: true });
    try {
      const ctx = createMockCtx({ cwd: subdir });
      const result = await execute("call-1", {
        action: "delete",
        agent: "deleteme",
      }, undefined, undefined, ctx);

      expect(result.isError).toBeUndefined();
      expect(fs.existsSync(path.join(root, ".pi", "agents", "deleteme.md"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});

describe("execute — unknown action", () => {
  let execute: (...args: any[]) => Promise<any>;

  beforeEach(async () => {
    execute = await loadTool();
  });

  test("returns error for unknown action", async () => {
    const ctx = createMockCtx();
    const result = await execute("call-1", { action: "nonexistent" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown action");
  });
});
