import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Loaded only in RPC children. It reports the active tool set after startup so
 * the parent can fail before prompting when a requested tool did not load.
 * Public extension API only; it registers no tools or commands.
 */
export default function subagentProbe(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const file = process.env.PI_SUBAGENT_PROBE_FILE;
    if (!file) return;
    let requested: string[] = [];
    try { requested = JSON.parse(process.env.PI_SUBAGENT_PROBE_TOOLS ?? "[]"); } catch { return; }
    const startedAt = Date.now();
    const deadline = startedAt + 10_000;
    const report = () => {
      let active: string[] = [];
      try { active = pi.getActiveTools(); } catch { /* runtime not ready */ }
      const missing = requested.filter((name) => !active.includes(name));
      // MCP registration is asynchronous; other tools should be present
      // immediately, so report a missing built-in without burning the grace window.
      const waitForMcp = missing.some((name) => name.startsWith("mcp__") || ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name));
      // Give the runtime a short window to settle its initial tool set before
      // declaring a built-in missing; MCP gets the full registration window.
      const grace = Date.now() - startedAt < 1_000;
      if (missing.length && (waitForMcp || grace) && Date.now() < deadline) {
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
