import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROBE_COMMAND, PROBE_CUSTOM_TYPE, PROBE_DEADLINE_ENV, PROBE_TOKEN_ENV, PROBE_TOOLS_ENV, type ProbeReport } from "./probe-protocol.ts";

/**
 * Loaded only in RPC children. It reports the active tool set after startup so
 * the parent can fail before prompting when a requested tool did not load.
 * Public extension API only: a private readiness command and a tool-call guard.
 */
export default function subagentProbe(pi: ExtensionAPI): void {
  let requested: string[] = [];
  try { requested = JSON.parse(process.env[PROBE_TOOLS_ENV] ?? "[]"); } catch { /* invalid request */ }
  const token = process.env[PROBE_TOKEN_ENV] ?? "";
  const deadline = Number(process.env[PROBE_DEADLINE_ENV]);
  const allowed = new Set(requested);
  let sending = false;

  const report = () => {
    if (sending) return;
    let active: string[] = [];
    try { active = pi.getActiveTools(); } catch { /* runtime not ready */ }
    const missing = requested.filter((name) => !active.includes(name));
    // Tool registration can be asynchronous (MCP, codemode, slow extensions).
    if (missing.length && Number.isSafeInteger(deadline) && Date.now() < deadline) {
      setTimeout(report, 50);
      return;
    }
    sending = true;
    const payload: ProbeReport = { token, tools: active, requested, missing };
    pi.appendEntry(PROBE_CUSTOM_TYPE, payload);
  };

  // `--tools` controls the declared set, but `executeTool()` can still reach
  // registered tools. Enforce the same allowlist for direct and nested calls.
  pi.on("tool_call", (event) => allowed.has(event.toolName)
    ? undefined
    : { block: true, reason: `Tool ${event.toolName} is not in this child's allowlist.` });

  pi.registerCommand(PROBE_COMMAND, {
    description: "Internal subagent readiness probe",
    handler: async () => { report(); },
  });
}
