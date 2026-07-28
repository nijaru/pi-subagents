import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverAgents,
  findNearestProjectAgentsDir,
  findNearestProjectRoot,
  getBundledAgentsDir,
  loadAgentsFromDir,
} from "../extensions/pi-subagents/agents.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
  tempDirs.push(directory);
  return directory;
}
function writeAgent(directory: string, file: string, name: string, extra = "", body = "Prompt") {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, file), `---\nname: ${name}\ndescription: ${name} agent${extra}\n---\n${body}\n`);
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("agent discovery", () => {
  test("bundled agents are always included and scopes are explicit", () => {
    const root = tempDir();
    const bundled = path.join(root, "bundled");
    const user = path.join(root, "user");
    const project = path.join(root, "project", ".pi", "agents");
    writeAgent(bundled, "bundled.md", "bundled");
    writeAgent(user, "shared.md", "shared", "\ntools: read, grep\ndelegation: true\ncapability: write");
    writeAgent(project, "shared.md", "shared", "\nmodel: project/model\ncapability: write");
    writeAgent(project, "project.md", "project");

    const userScope = discoverAgents(root, "user", { bundledAgentsDir: bundled, userAgentsDir: user });
    expect(userScope.agents.map((agent) => agent.name)).toEqual(["bundled", "shared"]);
    expect(userScope.agents.find((agent) => agent.name === "shared")?.source).toBe("user");

    const projectScope = discoverAgents(path.join(root, "project", "src"), "project", { bundledAgentsDir: bundled, userAgentsDir: user });
    expect(projectScope.agents.map((agent) => agent.name)).toEqual(["bundled", "project", "shared"]);
    expect(projectScope.agents.find((agent) => agent.name === "shared")?.source).toBe("project");
    expect(projectScope.agents.find((agent) => agent.name === "project")?.source).toBe("project");

    const bothScope = discoverAgents(path.join(root, "project"), "both", { bundledAgentsDir: bundled, userAgentsDir: user });
    expect(bothScope.agents.map((agent) => agent.name)).toEqual(["bundled", "project", "shared"]);
  });

  test("uses the nearest CONFIG_DIR_NAME agents directory", () => {
    const root = tempDir();
    const nested = path.join(root, "nested", "deep");
    fs.mkdirSync(nested, { recursive: true });
    writeAgent(path.join(root, ".pi", "agents"), "root.md", "root");
    writeAgent(path.join(root, "nested", ".pi", "agents"), "nested.md", "nested");
    expect(findNearestProjectAgentsDir(nested)).toBe(fs.realpathSync.native(path.join(root, "nested", ".pi", "agents")));
  });

  test("does not walk beyond a repository root", () => {
    const root = tempDir();
    const nested = path.join(root, "repo", "src");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "repo", "package.json"), "{}");
    writeAgent(path.join(root, ".pi", "agents"), "outside.md", "outside");
    expect(findNearestProjectAgentsDir(nested)).toBeNull();
    expect(findNearestProjectRoot(nested)).toBe(fs.realpathSync.native(path.join(root, "repo")));
  });

  test("does not follow a symlinked project config directory", () => {
    const root = tempDir();
    const repo = path.join(root, "repo");
    const outside = path.join(root, "outside", "agents");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    writeAgent(outside, "outside.md", "outside");
    fs.symlinkSync(path.join(root, "outside"), path.join(repo, ".pi"));
    expect(findNearestProjectAgentsDir(repo)).toBeNull();
  });

  test("skips malformed files and project symlinks", () => {
    const directory = tempDir();
    writeAgent(directory, "valid.md", "valid");
    fs.symlinkSync(path.join(directory, "valid.md"), path.join(directory, "linked.md"));
    expect(loadAgentsFromDir(directory, "project")).toHaveLength(1);
  });

  test("skips malformed files and parses pi frontmatter", () => {
    const directory = tempDir();
    writeAgent(directory, "valid.md", "valid", "\ntools: read, grep", "System prompt");
    fs.writeFileSync(path.join(directory, "missing.md"), "---\nname: missing\n---\nignored");
    fs.writeFileSync(path.join(directory, "broken.md"), "---\nname: [broken\n---\nignored");
    fs.writeFileSync(path.join(directory, "huge.md"), "x".repeat(256 * 1024 + 1));
    fs.writeFileSync(path.join(directory, "note.txt"), "not an agent");
    const agents = loadAgentsFromDir(directory, "user");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "valid", tools: ["read", "grep"], delegation: false, systemPrompt: "System prompt" });
  });

  test("parses nested delegation and capability metadata", () => {
    const directory = tempDir();
    writeAgent(directory, "nested.md", "nested", "\ndelegation: true\ncapability: write\ntools: read, subagent");
    const [agent] = loadAgentsFromDir(directory, "user");
    expect(agent).toMatchObject({ delegation: true, capability: "write", tools: ["read", "subagent"] });
  });

  test("skips read profiles with mutation-capable or unknown tools", () => {
    const directory = tempDir();
    writeAgent(directory, "bash.md", "bash", "\ncapability: read\ntools: read, bash");
    writeAgent(directory, "nested.md", "nested", "\ndelegation: true\ncapability: read\ntools: read");
    writeAgent(directory, "unknown.md", "unknown", "\ncapability: read\ntools: read, custom_tool");
    expect(loadAgentsFromDir(directory, "user")).toHaveLength(0);
  });

  test("bundled research profiles use current Pi tool names", () => {
    const agents = loadAgentsFromDir(getBundledAgentsDir(), "bundled");
    const explore = agents.find((agent) => agent.name === "explore");
    const architect = agents.find((agent) => agent.name === "architect");
    const researcher = agents.find((agent) => agent.name === "researcher");
    expect(explore?.tools).not.toContain("code_search");
    expect(architect?.tools).toContain("resolve-library-id");
    expect(architect?.tools).toContain("query-docs");
    expect(architect?.tools).toContain("mcp");
    expect(researcher?.tools).toContain("source_check");
    expect(researcher?.tools).toContain("get_search_content");
    for (const agent of [architect, researcher]) {
      expect(agent?.tools).not.toContain("mcp:context7");
      expect(agent?.tools).not.toContain("mcp:exa");
    }
  });

  test("skips invalid control metadata instead of broadening policy", () => {
    const directory = tempDir();
    writeAgent(directory, "bad-delegation.md", "bad-delegation", "\ndelegation: yes");
    writeAgent(directory, "bad-capability.md", "bad-capability", "\ncapability: execute");
    expect(loadAgentsFromDir(directory, "user")).toHaveLength(0);
  });

  test("bundled directory points at package definitions", () => {
    expect(fs.statSync(getBundledAgentsDir()).isDirectory()).toBe(true);
  });
});
