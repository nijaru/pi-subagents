/** Private command/entry handshake between the parent and the child probe. */
export const PROBE_COMMAND = "__pi_subagent_ready";
export const PROBE_CUSTOM_TYPE = "subagent-probe";
export const PROBE_TOKEN_ENV = "PI_SUBAGENT_PROBE_TOKEN";
export const PROBE_TOOLS_ENV = "PI_SUBAGENT_PROBE_TOOLS";
export const PROBE_TIMEOUT_ENV = "PI_SUBAGENT_PROBE_TIMEOUT_MS";

export interface ProbeReport {
  token: string;
  tools: string[];
  requested: string[];
  missing?: string[];
  error?: string;
}
