import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const AGENTS_DIR = path.join(import.meta.dir, "..", "agents");
const EXTENSION = path.join(import.meta.dir, "..", "extensions", "pi-subagents", "index.ts");

// ── Agent file format ───────────────────────────────────────────────────────

describe("agent definitions", () => {
  const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md"));

  test("every .md file has valid frontmatter with name and description", () => {
    for (const file of agentFiles) {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8");
      expect(raw.startsWith("---"), `${file}: must start with ---`).toBe(true);

      const end = raw.indexOf("\n---", 3);
      expect(end, `${file}: must have closing ---`).toBeGreaterThan(0);

      const frontmatter = raw.slice(4, end);
      const meta: Record<string, string> = {};
      for (const line of frontmatter.split("\n")) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (m) meta[m[1]!] = m[2]!.trim();
      }

      expect(meta.name, `${file}: missing name`).toBeTruthy();
      expect(meta.description, `${file}: missing description`).toBeTruthy();
    }
  });

  test("no agent declares unsupported frontmatter fields", () => {
    const SUPPORTED = new Set(["name", "description", "model", "tools"]);
    for (const file of agentFiles) {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8");
      const end = raw.indexOf("\n---", 3);
      const frontmatter = raw.slice(4, end);
      for (const line of frontmatter.split("\n")) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (m) {
          expect(
            SUPPORTED.has(m[1]!),
            `${file}: unsupported field "${m[1]}" — only ${[...SUPPORTED].join(", ")} are read by the extension`,
          ).toBe(true);
        }
      }
    }
  });

  test("tools field is comma-separated", () => {
    for (const file of agentFiles) {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8");
      const end = raw.indexOf("\n---", 3);
      const frontmatter = raw.slice(4, end);
      const toolsLine = frontmatter.split("\n").find(l => l.startsWith("tools:"));
      if (toolsLine) {
        const value = toolsLine.slice(toolsLine.indexOf(":") + 1).trim();
        // Should be comma-separated, no spaces around commas expected
        const tools = value.split(",").map(t => t.trim());
        expect(tools.length, `${file}: tools must have at least one entry`).toBeGreaterThan(0);
        for (const t of tools) {
          expect(t, `${file}: empty tool entry in "${value}"`).toBeTruthy();
        }
      }
    }
  });

  test("agent names are unique", () => {
    const names = new Set<string>();
    for (const file of agentFiles) {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8");
      const end = raw.indexOf("\n---", 3);
      const frontmatter = raw.slice(4, end);
      const nameLine = frontmatter.split("\n").find(l => l.startsWith("name:"));
      if (nameLine) {
        const name = nameLine.slice(nameLine.indexOf(":") + 1).trim();
        expect(names.has(name), `${file}: duplicate agent name "${name}"`).toBe(false);
        names.add(name);
      }
    }
  });

  test("body (system prompt) is non-empty", () => {
    for (const file of agentFiles) {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8");
      const end = raw.indexOf("\n---", 3);
      const body = raw.slice(end + 4).trim();
      expect(body.length, `${file}: system prompt body must not be empty`).toBeGreaterThan(0);
    }
  });
});

// ── Extension entry point ───────────────────────────────────────────────────

describe("extension", () => {
  test("extension file exists and exports default function", async () => {
    const mod = await import(EXTENSION);
    expect(typeof mod.default, "must export default function").toBe("function");
  });
});

// ── parseFrontmatter (reimplemented for testing) ────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const s = content.replace(/\r\n/g, "\n");
  if (!s.startsWith("---")) return { meta: {}, body: s };
  const end = s.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: s };
  const meta: Record<string, string> = {};
  for (const line of s.slice(4, end).split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      let v = m[2]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      meta[m[1]!] = v;
    }
  }
  return { meta, body: s.slice(end + 4).trim() };
}

describe("parseFrontmatter", () => {
  test("parses name and description", () => {
    const { meta, body } = parseFrontmatter("---\nname: test\ndescription: A test agent\n---\nHello world");
    expect(meta.name).toBe("test");
    expect(meta.description).toBe("A test agent");
    expect(body).toBe("Hello world");
  });

  test("handles quoted values", () => {
    const { meta } = parseFrontmatter('---\nname: "quoted"\ndescription: \'also quoted\'\n---');
    expect(meta.name).toBe("quoted");
    expect(meta.description).toBe("also quoted");
  });

  test("returns empty meta for no frontmatter", () => {
    const { meta, body } = parseFrontmatter("No frontmatter here");
    expect(meta).toEqual({});
    expect(body).toBe("No frontmatter here");
  });

  test("handles \r\n line endings", () => {
    const { meta } = parseFrontmatter("---\r\nname: test\r\n---");
    expect(meta.name).toBe("test");
  });

  test("ignores malformed lines", () => {
    const { meta } = parseFrontmatter("---\nname: test\nno-colon-here\n---");
    expect(meta.name).toBe("test");
    expect(meta["no-colon-here"]).toBeUndefined();
  });
});

// ── truncate (reimplemented for testing) ────────────────────────────────────

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf-8") <= maxBytes) return s;
  let t = s;
  while (Buffer.byteLength(t, "utf-8") > maxBytes) t = t.slice(0, -1);
  return `${t}\n[truncated — ${Buffer.byteLength(s, "utf-8")} bytes total]`;
}

describe("truncate", () => {
  test("returns string unchanged if under limit", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  test("truncates to maxBytes and appends notice", () => {
    const result = truncate("hello world", 5);
    expect(result).toContain("[truncated");
    expect(Buffer.byteLength(result.split("\n")[0]!, "utf-8")).toBeLessThanOrEqual(5);
  });

  test("handles empty string", () => {
    expect(truncate("", 100)).toBe("");
  });
});
