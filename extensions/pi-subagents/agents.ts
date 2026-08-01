import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_AGENT_DELEGATION_DEPTH = 3;
const MAX_OUTPUT_SCHEMA_BYTES = 16 * 1024;
const MAX_OUTPUT_SCHEMA_NODES = 512;
const MAX_OUTPUT_SCHEMA_DEPTH = 16;
const MAX_AGENT_NAME_BYTES = 256;
const MAX_AGENT_DESCRIPTION_BYTES = 2 * 1024;
const MAX_AGENT_FILES = 256;
const MAX_AGENT_DIRECTORY_BYTES = 4 * 1024 * 1024;

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project";
export type AgentCapability = "read" | "write";
export type AgentOutputSchema = Record<string, unknown>;

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  /** Explicit tool allowlist. Missing means no tools, not all tools. */
  tools?: string[];
  /** Nested delegation is opt-in and defaults to false. */
  delegation: boolean;
  /** Missing is classified as potentially mutating by the executor. */
  capability?: AgentCapability;
  /** Optional TypeBox-compatible JSON Schema for a raw JSON final response. */
  outputSchema?: AgentOutputSchema;
  /** Exact names this agent may invoke through nested delegation. */
  allowedAgents?: string[];
  /** Maximum nested levels this agent may create; zero disables nested calls. */
  maxDelegationDepth?: number;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  bundledAgentsDir: string;
  userAgentsDir: string;
}

export interface DiscoveryOptions {
  bundledAgentsDir?: string;
  userAgentsDir?: string;
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isProjectRoot(directory: string): boolean {
  return [".git", "package.json", "Cargo.toml", "go.mod"].some((name) =>
    fs.existsSync(path.join(directory, name)),
  );
}

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The package keeps its bundled definitions at the repository/package root. */
export function getBundledAgentsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agents");
}

function canonicalDirectory(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function findNearestProjectRoot(cwd: string): string | null {
  let current = canonicalDirectory(cwd);
  while (true) {
    if (isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = canonicalDirectory(cwd);
  while (true) {
    const configDir = path.join(current, CONFIG_DIR_NAME);
    const candidate = path.join(configDir, "agents");
    // Project definitions are repository-controlled input. Do not follow a
    // symlinked config or agents directory, and do not walk through the
    // nearest project root.
    if (!isSymlink(configDir) && isDirectory(candidate) && !isSymlink(candidate)) return candidate;
    if (isProjectRoot(current)) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const tools = value.split(",").map((tool) => tool.trim()).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  if (Array.isArray(value) && value.every((tool) => typeof tool === "string")) {
    const tools = value.map((tool) => tool.trim()).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  return undefined;
}

function parseAllowedAgents(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const names = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value) && value.every((name) => typeof name === "string") ? value : undefined;
  if (!names) return undefined;
  const trimmed = names.map((name) => name.trim()).filter(Boolean);
  if (trimmed.length !== new Set(trimmed).size || trimmed.some((name) => Buffer.byteLength(name, "utf8") > MAX_AGENT_NAME_BYTES)) return undefined;
  return trimmed;
}

function parseMaxDelegationDepth(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_AGENT_DELEGATION_DEPTH ? value : undefined;
}

function parseDelegation(value: unknown): boolean | undefined {
  return value === undefined ? false : typeof value === "boolean" ? value : undefined;
}

function parseCapability(value: unknown): AgentCapability | undefined {
  return value === undefined || value === "read" || value === "write" ? value : undefined;
}

const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const SCHEMA_STRING_KEYS = new Set(["$id", "$schema", "$ref", "title", "description", "pattern", "format", "$comment"]);
const SCHEMA_NUMBER_KEYS = new Set([
  "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
]);
const SCHEMA_NON_NEGATIVE_INTEGER_KEYS = new Set([
  "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties",
]);
const SCHEMA_ARRAY_KEYS = new Set(["required", "enum", "anyOf", "oneOf", "allOf"]);

interface SchemaValidationState {
  nodes: number;
  seen: Set<object>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the schema shape before handing it to TypeBox's runtime checker.
 * TypeBox treats unknown `type` values as an unconstrained schema, which would
 * silently broaden an agent's contract, so invalid control fields fail closed.
 */
function validateOutputSchema(value: unknown, state: SchemaValidationState, depth: number): boolean {
  if (!isRecord(value) || depth > MAX_OUTPUT_SCHEMA_DEPTH) return false;
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  state.nodes++;
  if (state.nodes > MAX_OUTPUT_SCHEMA_NODES) return false;

  const type = value.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0 || types.some((item) => typeof item !== "string" || !JSON_SCHEMA_TYPES.has(item))) return false;
    if (new Set(types).size !== types.length) return false;
  }
  for (const key of SCHEMA_STRING_KEYS) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  for (const key of SCHEMA_NUMBER_KEYS) {
    const number = value[key];
    if (number === undefined) continue;
    if (typeof number !== "number" || !Number.isFinite(number)) return false;
    if (SCHEMA_NON_NEGATIVE_INTEGER_KEYS.has(key) && (!Number.isInteger(number) || number < 0)) return false;
    if (key === "multipleOf" && number <= 0) return false;
  }
  if (typeof value.pattern === "string") {
    try {
      new RegExp(value.pattern);
    } catch {
      return false;
    }
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string"))) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) return false;
  if (value.additionalProperties !== undefined && value.additionalProperties !== false && value.additionalProperties !== true && !validateOutputSchema(value.additionalProperties, state, depth + 1)) return false;
  if (value.unevaluatedProperties !== undefined && value.unevaluatedProperties !== false && value.unevaluatedProperties !== true && !validateOutputSchema(value.unevaluatedProperties, state, depth + 1)) return false;

  for (const key of ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]) {
    if (value[key] === undefined) continue;
    if (!isRecord(value[key]) || Object.values(value[key]).some((schema) => !validateOutputSchema(schema, state, depth + 1))) return false;
    if (key === "patternProperties") {
      try {
        for (const pattern of Object.keys(value[key])) new RegExp(pattern);
      } catch {
        return false;
      }
    }
  }
  for (const key of ["items", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"]) {
    if (value[key] !== undefined && !validateOutputSchema(value[key], state, depth + 1)) return false;
  }
  for (const key of SCHEMA_ARRAY_KEYS) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length === 0) return false;
    if (key !== "required" && key !== "enum" && value[key].some((schema) => !validateOutputSchema(schema, state, depth + 1))) return false;
  }
  if (value.prefixItems !== undefined && (!Array.isArray(value.prefixItems) || value.prefixItems.some((schema) => !validateOutputSchema(schema, state, depth + 1)))) return false;
  if (value.$ref !== undefined && (typeof value.$ref !== "string" || !value.$ref.startsWith("#/"))) return false;
  return true;
}

function parseOutputSchema(value: unknown): AgentOutputSchema | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_SCHEMA_BYTES) return undefined;
  return validateOutputSchema(value, { nodes: 0, seen: new Set() }, 0) ? value : undefined;
}

// A read capability is an effect declaration used for parallel-write safety,
// not a sandbox. Keep the allowlist deliberately small: an unknown extension
// tool may mutate state and must not be trusted merely because its name looks
// harmless.
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "web_research",
  "source_check",
  "fetch_content",
  "get_search_content",
  "resolve-library-id",
  "query-docs",
]);

function isReadCapabilityConsistent(capability: AgentCapability | undefined, tools: string[] | undefined, delegation: boolean): boolean {
  if (capability !== "read") return true;
  if (delegation) return false;
  return (tools ?? []).every((tool) => READ_ONLY_TOOLS.has(tool));
}

export function loadAgentsFromDir(directory: string, source: AgentSource): AgentConfig[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  let inspectedFiles = 0;
  let inspectedBytes = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (inspectedFiles >= MAX_AGENT_FILES) break;
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    // A project agent must be contained by the project agent directory. A
    // symlink can otherwise turn a repository-controlled prompt into an
    // arbitrary file read.
    if (source === "project" && entry.isSymbolicLink()) continue;
    const filePath = path.join(directory, entry.name);
    let content: string;
    try {
      const size = fs.statSync(filePath).size;
      if (size > MAX_AGENT_FILE_BYTES || inspectedBytes + size > MAX_AGENT_DIRECTORY_BYTES) continue;
      inspectedFiles++;
      inspectedBytes += size;
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    let parsed: { frontmatter: Record<string, unknown>; body: string };
    try {
      parsed = parseFrontmatter<Record<string, unknown>>(content);
    } catch {
      // A malformed agent must not prevent other agents from being discovered.
      continue;
    }

    const name = parsed.frontmatter.name;
    const description = parsed.frontmatter.description;
    if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim()
      || Buffer.byteLength(name.trim(), "utf8") > MAX_AGENT_NAME_BYTES
      || Buffer.byteLength(description.trim(), "utf8") > MAX_AGENT_DESCRIPTION_BYTES) {
      continue;
    }

    const model = typeof parsed.frontmatter.model === "string" && parsed.frontmatter.model.trim()
      ? parsed.frontmatter.model.trim()
      : undefined;
    const delegation = parseDelegation(parsed.frontmatter.delegation);
    const capability = parseCapability(parsed.frontmatter.capability);
    const tools = parseTools(parsed.frontmatter.tools);
    const outputSchema = parseOutputSchema(parsed.frontmatter.outputSchema);
    const allowedAgents = parseAllowedAgents(parsed.frontmatter.allowedAgents);
    const maxDelegationDepth = parseMaxDelegationDepth(parsed.frontmatter.maxDelegationDepth);
    // Invalid control metadata is not allowed to silently become a broader
    // policy. The definition is skipped rather than treated as unrestricted.
    if (delegation === undefined || parsed.frontmatter.capability !== undefined && capability === undefined) continue;
    if (parsed.frontmatter.outputSchema !== undefined && outputSchema === undefined) continue;
    if (parsed.frontmatter.allowedAgents !== undefined && allowedAgents === undefined) continue;
    if (parsed.frontmatter.maxDelegationDepth !== undefined && maxDelegationDepth === undefined) continue;
    if (!isReadCapabilityConsistent(capability, tools, delegation)) continue;
    agents.push({
      name: name.trim(),
      description: description.trim(),
      model,
      tools,
      delegation,
      capability,
      outputSchema,
      allowedAgents,
      maxDelegationDepth,
      systemPrompt: parsed.body,
      source,
      filePath,
    });
  }
  return agents;
}

/**
 * Discover bundled agents plus the requested user/project scopes.
 * Later scopes override earlier definitions with the same name.
 */
export function discoverAgents(cwd: string, scope: AgentScope, options: DiscoveryOptions = {}): AgentDiscoveryResult {
  const bundledAgentsDir = path.resolve(options.bundledAgentsDir ?? getBundledAgentsDir());
  const userAgentsDir = path.resolve(options.userAgentsDir ?? path.join(getAgentDir(), "agents"));
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const agents = new Map<string, AgentConfig>();

  for (const agent of loadAgentsFromDir(bundledAgentsDir, "bundled")) agents.set(agent.name, agent);
  if (scope === "user" || scope === "both") {
    for (const agent of loadAgentsFromDir(userAgentsDir, "user")) agents.set(agent.name, agent);
  }
  if (scope === "project" || scope === "both") {
    if (projectAgentsDir) {
      for (const agent of loadAgentsFromDir(projectAgentsDir, "project")) agents.set(agent.name, agent);
    }
  }

  return {
    agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
    projectAgentsDir,
    bundledAgentsDir,
    userAgentsDir,
  };
}
