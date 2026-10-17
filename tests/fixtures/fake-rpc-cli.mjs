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
  if (command.type === "get_state") {
    if (startupScenario) return;
    send({ id: command.id, type: "response", command: "get_state", success: true, data: {
      model: { provider, id: modelId }, thinkingLevel: thinking, isStreaming: false, isCompacting: false,
      steeringMode: "all", followUpMode: "all", sessionId: "fake", autoCompactionEnabled: true,
      messageCount: 0, pendingMessageCount: 0,
    } });
    return;
  }
  if (command.type === "prompt") {
    scenario = /SCENARIO=([a-z-]+)/.exec(command.message)?.[1] ?? "ok";
    send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    setTimeout(emitTask, 5);
    return;
  }
  if (command.type === "steer") {
    send({ id: command.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });
    if (scenario === "descendant") {
    const descendant = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
    fs.writeFileSync("descendant.pid", String(descendant.pid));
    send({ type: "message_end", message: message("done") });
    settle();
    return;
  }
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
input.on("close", () => process.exit(0));
