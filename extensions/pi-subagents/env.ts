import { DEPTH_ENV, RUN_ID_ENV } from "./limits.ts";

/**
 * Children are trusted, same-user Pi processes, not sandboxes. Inherit the
 * ordinary subprocess environment so providers, MCP servers and shell tools
 * see the same configuration; a credential-name filter cannot isolate them.
 */
export function childEnvironment(childRunId: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PWD: cwd, [DEPTH_ENV]: "1", [RUN_ID_ENV]: childRunId };
  // These describe the parent session, not configuration for the next Pi.
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_INTERCOM_SESSION_ID", "PI_SUBAGENT_PASSTHROUGH_ENV"]) delete env[key];
  return env;
}
