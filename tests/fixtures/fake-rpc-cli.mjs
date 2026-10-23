import * as fs from "node:fs";
import * as readline from "node:readline";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const startupScenario = args.includes("--name") && args[args.indexOf("--name") + 1] === "startup";
let model = "fixture/model";
let thinking = "medium";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model") model = args[++i];
  if (args[i] === "--thinking") thinking = args[++i];
}
const separator = model.indexOf("/");
const provider = separator > 0 ? model.slice(0, separator) : "fixture";
const modelId = separator > 0 ? model.slice(separator + 1) : model;
fs.writeFileSync(".fake-rpc-capture.json", JSON.stringify({ args, cwd: process.cwd(), model, thinking }));

const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 9, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
const message = (text, stopReason = "stop") => ({
  role: "assistant", content: text, api: "openai-completions", provider, model: modelId,
  timestamp: Date.now(), stopReason, usage,
});
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const settle = (aborted = false) => send({ type: "agent_settled", aborted });
let scenario = "ok";

function emitTask() {
  if (scenario === "startup") return;
  if (scenario === "exit-final") {
    send({ type: "message_end", message: message("BUFFERED_FINAL".repeat(40000)) });
    process.stdout.write(JSON.stringify({ type: "agent_settled", aborted: false }) + "\n", () => process.exit(0));
    return;
  }
  if (scenario === "partial-large") {
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    for (let i = 0; i < 32; i++) send({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "界🙂".repeat(1000) } });
    return;
  }
  if (scenario === "activity" || scenario === "activity-hang") {
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    setTimeout(() => {
      const update = (type, fields = {}) => send({ type: "message_update", usage, assistantMessageEvent: { type, contentIndex: 0, ...fields } });
      update("thinking_start");
      for (let i = 0; i < 32; i++) update("thinking_delta", { delta: "PRIVATE_REASONING" });
      update("thinking_end", { content: "PRIVATE_REASONING" });
      update("toolcall_start", { id: "read-1", toolName: "read" });
      update("toolcall_delta", { delta: '{"path":"PRIVATE_ARGS"}' });
      update("toolcall_end", { toolCall: { id: "read-1", name: "read", arguments: { path: "PRIVATE_ARGS" } } });
      send({ type: "message_end", message: { ...message([], "toolUse"), content: [
        { type: "thinking", thinking: "PRIVATE_REASONING" },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "PRIVATE_ARGS" } },
      ] } });
      const tool = (type, toolCallId, toolName) => send({ type, toolCallId, toolName,
        args: { path: "PRIVATE_ARGS" }, result: { content: [{ type: "text", text: "PRIVATE_RESULT" }] },
        partialResult: { content: [{ type: "text", text: "PRIVATE_PARTIAL" }] }, isError: false });
      tool("tool_execution_start", "read-1", "read");
      if (scenario === "activity-hang") return;
      tool("tool_execution_start", "read-2", "read");
      tool("tool_execution_start", "bash-1", "bash");
      tool("tool_execution_end", "read-2", "read");
      tool("tool_execution_update", "bash-1", "bash");
      tool("tool_execution_end", "bash-1", "bash");
      tool("tool_execution_end", "read-1", "read");
      send({ type: "message_start", message: { role: "assistant", content: [] } });
      update("text_delta", { delta: "public report" });
      send({ type: "message_end", message: message("public report") });
      settle();
    }, 20);
    return;
  }
  if (scenario === "usage") {
    send({ type: "entry_appended", entry: { type: "usage", kind: "cache_warm", usage } });
    send({ type: "entry_appended", entry: { type: "usage", kind: "cache_warm", usage: { ...usage, input: -1 } } });
    // A committed compaction is announced twice, but billed only by its end event.
    send({ type: "entry_appended", entry: { type: "compaction", usage } });
    send({ type: "compaction_end", result: { usage } });
  }
  if (scenario === "exit") { process.exit(1); }
  if (scenario === "fail") {
    send({ type: "message_end", message: message("", "error") });
    settle();
    return;
  }
  if (scenario === "length") {
    send({ type: "message_end", message: message("partial", "length") });
    settle();
    return;
  }
  if (scenario === "malformed") {
    send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    settle();
    return;
  }
  if (scenario === "partial-after" || scenario === "partial-thinking") {
    send({ type: "message_end", message: message("FIRST") });
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    if (scenario === "partial-after") send({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "SECOND" } });
    return;
  }
  if (scenario === "extension-error") {
    send({ type: "extension_error", event: "tool_result", error: "hook boom" });
    send({ type: "message_end", message: message("done") });
    settle();
    return;
  }
  if (scenario === "detached-descendant" || scenario === "detached-complete") {
    const detached = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { detached: true, stdio: "ignore" });
    fs.writeFileSync("detached.pid", String(detached.pid));
    if (scenario === "detached-complete") {
      send({ type: "message_end", message: message("done") });
      settle();
    }
    return;
  }
  if (scenario === "slow") {
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    send({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "partial" } });
    send({ type: "message_end", message: message("partial") });
    return;
  }
  if (scenario === "descendant") {
    const descendant = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
    fs.writeFileSync("descendant.pid", String(descendant.pid));
    send({ type: "message_end", message: message("done") });
    settle();
    return;
  }
  if (scenario === "steer") {
    send({ type: "message_end", message: message("waiting for steer") });
    return;
  }
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  send({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "done" } });
  send({ type: "message_end", message: message("done") });
  settle();
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.type === "get_commands") {
    const noProbe = args.includes("--name") && args[args.indexOf("--name") + 1] === "no-probe";
    send({ id: command.id, type: "response", command: "get_commands", success: true, data: { commands: noProbe ? [] : [{ name: "__pi_subagent_ready", description: "probe", source: "extension" }] } });
    return;
  }
  if (command.type === "get_state") {
    if (startupScenario) return;
    setTimeout(() => send({ id: command.id, type: "response", command: "get_state", success: true, data: {
      model: { provider, id: modelId }, thinkingLevel: thinking, isStreaming: false, isCompacting: false,
      steeringMode: "all", followUpMode: "all", sessionId: "fake", autoCompactionEnabled: true,
      messageCount: 0, pendingMessageCount: 0,
    } }), Number(process.env.FAKE_RPC_STARTUP_DELAY ?? 0));
    return;
  }
  if (command.type === "prompt") {
    if (command.message.startsWith("/__pi_subagent_ready")) {
      let requested = [];
      try { requested = JSON.parse(process.env.PI_SUBAGENT_PROBE_TOOLS ?? "[]"); } catch { /* invalid */ }
      const payload = { token: process.env.PI_SUBAGENT_PROBE_TOKEN ?? "", tools: requested };
      send({ type: "entry_appended", entry: { type: "custom", customType: "subagent-probe", data: payload, id: "probe-entry", parentId: null, timestamp: new Date().toISOString() } });
      send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
      return;
    }
    scenario = /SCENARIO=([a-z-]+)/.exec(command.message)?.[1] ?? "ok";
    fs.writeFileSync(".fake-rpc-prompt", command.message);
    send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    setTimeout(emitTask, 5);
    return;
  }
  if (command.type === "steer") {
    fs.writeFileSync(".fake-rpc-steer", command.message);
    send({ id: command.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });
    if (scenario === "steer") {
      send({ type: "message_end", message: message(`steered: ${command.message}`) });
      settle();
    }
    return;
  }
  if (command.type === "abort") {
    send({ id: command.id, type: "response", command: "abort", success: true });
    settle(true);
    return;
  }
  send({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported" });
});
input.on("close", () => {
  if (scenario === "shutdown") {
    setTimeout(() => {
      fs.writeFileSync("shutdown.done", "yes");
      process.exit(0);
    }, 300);
    return;
  }
  process.exit(0);
});
