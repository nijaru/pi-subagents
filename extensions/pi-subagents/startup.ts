import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ChildTask } from "./execution.ts";
import { PROBE_COMMAND, type ProbeReport } from "./probe-protocol.ts";
import type { ChildRpc } from "./rpc.ts";

/** One startup transaction, one absolute deadline, and no model work. */
export async function prepareChild(rpc: ChildRpc, task: ChildTask, readiness: Promise<ProbeReport | undefined>, expiresAt: number): Promise<{ model: string; thinking: ModelThinkingLevel }> {
  const remaining = () => Math.max(1, expiresAt - Date.now());
  // CLI flags are defaults: restoration and startup extensions may override them.
  if (task.model) {
    const separator = task.model.indexOf("/");
    if (separator < 1) throw new Error("Child model must use provider/model-id.");
    await rpc.request({ type: "set_model", provider: task.model.slice(0, separator), modelId: task.model.slice(separator + 1) }, remaining());
  }
  if (task.thinking !== undefined) {
    if (task.strictThinking) {
      const levels = (await rpc.request({ type: "get_available_thinking_levels" }, remaining())).data?.levels;
      if (!Array.isArray(levels)) throw new Error("Child did not report supported thinking levels.");
      if (!levels.includes(task.thinking)) throw new Error(`Child model does not support thinking ${task.thinking}; supported: ${levels.join(", ")}.`);
    }
    await rpc.request({ type: "set_thinking_level", level: task.thinking }, remaining());
  }
  const commands = (await rpc.request({ type: "get_commands" }, remaining())).data?.commands;
  if (!Array.isArray(commands) || !commands.some((command) => command.name === PROBE_COMMAND && command.source === "extension")) throw new Error("Child probe extension is unavailable.");
  const response = await rpc.request({ type: "prompt", message: `/${PROBE_COMMAND}` }, remaining());
  if (response.data?.disposition !== "handled") throw new Error("Child probe command was not handled.");
  const report = await readiness;
  if (!report) throw new Error("Child probe ended without readiness.");
  const missing = task.tools.filter((tool) => !report.tools.includes(tool));
  if (missing.length) throw new Error(`Requested child tools are unavailable: ${missing.join(", ")}`);
  if (report.tools.length !== task.tools.length || new Set(report.tools).size !== task.tools.length) throw new Error("Child tool selection did not match request.");
  const state = (await rpc.request({ type: "get_state" }, remaining())).data;
  if (!state?.model) throw new Error("Child has no selected model.");
  const model = `${state.model.provider}/${state.model.id}`;
  if (task.model && model !== task.model) throw new Error(`Child model ${model} does not match requested ${task.model}.`);
  if (task.strictThinking && state.thinkingLevel !== task.thinking) throw new Error(`Child thinking ${state.thinkingLevel} does not match requested ${task.thinking}.`);
  return { model, thinking: state.thinkingLevel };
}
