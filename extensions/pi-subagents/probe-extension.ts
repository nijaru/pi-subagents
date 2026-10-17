import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Loaded only in RPC children. It reports the active tool set after startup so
 * the parent can fail before prompting when a requested tool did not load.
 * Public extension API only; it registers no tools or commands.
 */
export default function subagentProbe(pi: ExtensionAPI): void {
  let requested: string[] = [];
  try { requested = JSON.parse(process.env.PI_SUBAGENT_PROBE_TOOLS ?? "[]"); } catch { /* invalid request */ }
  const allowed = new Set(requested);
  // `--tools` controls the declared set, but `executeTool()` can still reach
  // registered tools. Enforce the same allowlist for direct and nested calls.
  pi.on("tool_call", (event) => allowed.has(event.toolName)
    ? undefined
    : { block: true, reason: `Tool ${event.toolName} is not in this child's allowlist.` });
  pi.on("session_start", () => {
    const file = process.env.PI_SUBAGENT_PROBE_FILE;
    if (!file) return;
    const startedAt = Date.now();
    const configured = Number(process.env.PI_SUBAGENT_PROBE_TIMEOUT_MS);
    const timeout = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 5 * 60_000) : 10_000;
    const deadline = startedAt + timeout;
    const report = () => {
      let active: string[] = [];
      try { active = pi.getActiveTools(); } catch { /* runtime not ready */ }
      const missing = requested.filter((name) => !active.includes(name));
      // Tool registration can be asynchronous (MCP, codemode, slow extensions).
      // Wait for the resolved startup window rather than declaring a built-in
      // missing after an arbitrary one-second grace.
      if (missing.length && Date.now() < deadline) {
        setTimeout(report, 50);
        return;
      }
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify({ tools: active, requested }), { encoding: "utf8", mode: 0o600 });
        renameSync(temporary, file);
      } catch {
        // The parent's startup deadline turns a failed probe into a clear error.
      }
    };
    setTimeout(report, 0);
  });
}
