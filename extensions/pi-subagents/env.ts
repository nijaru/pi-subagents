import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findEnvKeys, getProviders } from "@earendil-works/pi-ai/compat";

import { BUDGET_ENV, CONTROL_ENV, DEADLINE_ENV, DELEGATION_POLICY_FILE_ENV, DEPTH_ENV, PARENT_ID_ENV, PASSTHROUGH_ENV, PI_BIN_ENV, ROOT_ID_ENV, RUN_ID_ENV, SUBAGENT_BIN_ENV, TIMEOUT_ENV } from "./limits.ts";
import type { ControlContext } from "./control.ts";

// Keep the child useful for configured providers without copying arbitrary
// shell/session state (SSH sockets, cloud metadata, and unrelated secrets).
export const SAFE_ENV_KEYS = new Set([
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
  "PWD", "OLDPWD", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM",
  "NO_COLOR", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "BUN_INSTALL",
  "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR",
  TIMEOUT_ENV, PASSTHROUGH_ENV, SUBAGENT_BIN_ENV, PI_BIN_ENV,
  "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENROUTER_BASE_URL",
  "AZURE_OPENAI_ENDPOINT", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_PROFILE",
  "AWS_REGION", "AWS_DEFAULT_REGION",
]);

// These are ambient model configuration values used by providers that do not
// expose their credentials through findEnvKeys(). They are not application
// secrets and are safe to pass alongside the standard provider API keys.
export const AMBIENT_MODEL_ENV_KEYS = new Set([
  "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GCLOUD_PROJECT",
]);

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function passthroughPatternToRegExp(pattern: string): RegExp | undefined {
  // Allow exact names and glob patterns containing * and ?. Example: *_API_KEY, OPENAI_*, *TOKEN*
  if (!pattern) return undefined;
  if (!/^[A-Za-z0-9_*?]+$/.test(pattern) && pattern !== "*") return undefined;
  // Exact name fast path
  if (!pattern.includes("*") && !pattern.includes("?")) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern)) return undefined;
    return new RegExp(`^${escapeRegExp(pattern)}$`);
  }
  const escaped = pattern.split("").map((ch) => {
    if (ch === "*") return ".*";
    if (ch === "?") return ".";
    return escapeRegExp(ch);
  }).join("");
  try {
    return new RegExp(`^${escaped}$`);
  } catch {
    return undefined;
  }
}

export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ENV_VAR_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Match pi's JSONC support while preserving string literals. */
export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

export function collectConfigEnvRefs(value: unknown, refs: Set<string>): void {
  if (typeof value === "string") {
    let index = 0;
    while (index < value.length) {
      const dollarIndex = value.indexOf("$", index);
      if (dollarIndex < 0) return;
      const next = value[dollarIndex + 1];
      if (next === "$" || next === "!") {
        index = dollarIndex + 2;
        continue;
      }
      if (next === "{") {
        const end = value.indexOf("}", dollarIndex + 2);
        if (end < 0) {
          index = dollarIndex + 1;
          continue;
        }
        const name = value.slice(dollarIndex + 2, end);
        if (ENV_VAR_NAME.test(name)) refs.add(name);
        index = end + 1;
        continue;
      }
      const match = value.slice(dollarIndex + 1).match(ENV_VAR_PREFIX);
      if (match) {
        refs.add(match[0]);
        index = dollarIndex + 1 + match[0].length;
      } else {
        index = dollarIndex + 1;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConfigEnvRefs(item, refs);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectConfigEnvRefs(item, refs);
  }
}

export function collectModelEnvRefs(): Set<string> {
  const refs = new Set<string>();
  try {
    const agentDir = getAgentDir();
    const modelsPath = path.join(agentDir, "models.json");
    const raw = fs.readFileSync(modelsPath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    collectConfigEnvRefs(parsed, refs);
  } catch {
    // Best-effort; absence of models.json is not fatal
  }
  return refs;
}

export function modelCredentialEnvKeys(): Set<string> {
  const keys = new Set(AMBIENT_MODEL_ENV_KEYS);
  const available = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  try {
    for (const provider of getProviders()) {
      for (const key of findEnvKeys(provider, available) ?? []) keys.add(key);
    }
  } catch {
    // A provider catalog failure must not prevent subagent execution.
  }
  return keys;
}

export function childEnvironment(
  depth: number,
  control: ControlContext,
  parentRunId: string,
  childRunId: string,
  budgetRemaining: number,
  cwd: string,
  delegationPolicyPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Auto-include env vars referenced in ~/.pi/agent/models.json. This covers
  // provider keys, custom headers, and nested children using another configured
  // model without exposing unrelated environment variables.
  for (const ref of collectModelEnvRefs()) {
    const value = process.env[ref];
    if (value !== undefined) env[ref] = value;
  }
  // Inherit credential-shaped variables for configured model and tool
  // providers. Trusted subagents already run as the same user and need the
  // parent's Exa, Context7, GitHub, and similar credentials to be useful.
  for (const key of modelCredentialEnvKeys()) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key.endsWith("_API_KEY") || key.endsWith("_TOKEN"))) env[key] = value;
  }
  // Allow the user to explicitly opt in to additional non-credential
  // variables without making every ambient environment variable available to
  // a delegated bash-capable agent. Supports exact names and glob patterns.
  // Set "*" to pass all env (explicit insecure opt-in).
  const passthroughRaw = process.env[PASSTHROUGH_ENV] ?? "";
  const patterns = passthroughRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (patterns.length > 0) {
    const allParentKeys = Object.keys(process.env);
    for (const pat of patterns) {
      const re = passthroughPatternToRegExp(pat);
      if (!re) continue;
      for (const key of allParentKeys) {
        if (re.test(key)) {
          const value = process.env[key];
          if (value !== undefined) env[key] = value;
        }
      }
    }
  }
  env["PWD"] = cwd;
  env[DEPTH_ENV] = String(depth);
  env[RUN_ID_ENV] = childRunId;
  env[PARENT_ID_ENV] = parentRunId;
  env[ROOT_ID_ENV] = control.rootRunId;
  env[CONTROL_ENV] = control.statePath;
  env[DEADLINE_ENV] = String(control.deadlineMs);
  env[BUDGET_ENV] = String(budgetRemaining);
  if (delegationPolicyPath) env[DELEGATION_POLICY_FILE_ENV] = delegationPolicyPath;
  if (process.env[TIMEOUT_ENV] !== undefined) env[TIMEOUT_ENV] = process.env[TIMEOUT_ENV];
  if (process.env[PASSTHROUGH_ENV] !== undefined) env[PASSTHROUGH_ENV] = process.env[PASSTHROUGH_ENV];
  if (process.env[SUBAGENT_BIN_ENV] !== undefined) env[SUBAGENT_BIN_ENV] = process.env[SUBAGENT_BIN_ENV];
  if (process.env[PI_BIN_ENV] !== undefined) env[PI_BIN_ENV] = process.env[PI_BIN_ENV];
  return env;
}
