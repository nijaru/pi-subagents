import { createWriteStream } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { createChildSession, closeChildSession, type ChildSessionPolicy } from "./child-session.ts";
import { addUsage, emptyUsage, isThinkingLevel } from "./types.ts";
import { boundedDiagnostic, truncateOutput } from "./bounds.ts";
import { MAX_TASK_BYTES } from "./limits.ts";
import { assistantReport, CHILD_PROTOCOL_VERSION, emptyReport, type ChildBootstrap, type ChildEvent } from "./child-protocol.ts";

/** SDK host for one leaf task. stdout/stderr remain extension diagnostics, never protocol. */
export async function runChild(policy: ChildSessionPolicy): Promise<void> {
  const pipe = createWriteStream("", { fd: 3, autoClose: false });
  let pipeError: Error | undefined;
  pipe.on("error", (error) => { pipeError = error; });
  const send = async (event: ChildEvent) => {
    if (pipeError) throw pipeError;
    await new Promise<void>((resolve, reject) => pipe.write(JSON.stringify(event) + "\n", (error) => error ? reject(error) : resolve()));
  };
  let session: AgentSession | undefined;
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    void session?.abort().catch((error) => console.error(error));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > MAX_TASK_BYTES * 8) throw new Error("Child bootstrap exceeds size limit.");
    }
    const request: ChildBootstrap = JSON.parse(input);
    if (request.version !== CHILD_PROTOCOL_VERSION || typeof request.prompt !== "string" || !Array.isArray(request.tools)
      || !request.tools.every((tool) => typeof tool === "string") || Buffer.byteLength(request.prompt) > MAX_TASK_BYTES
      || (request.thinking !== undefined && !isThinkingLevel(request.thinking))
      || (request.strictThinking !== undefined && typeof request.strictThinking !== "boolean")
      || (request.strictThinking && request.thinking === undefined)) {
      throw new Error("Invalid child bootstrap request.");
    }
    abort.signal.throwIfAborted();
    session = await createChildSession(request, policy, abort.signal);
    abort.signal.throwIfAborted();
    const model = session.model!; // Startup verified the selected model and loadout.
    await send({ version: CHILD_PROTOCOL_VERSION, kind: "ready", model: `${model.provider}/${model.id}`, thinking: session.thinkingLevel, tools: session.getActiveToolNames() });
    let report = emptyReport();
    const usage = emptyUsage();
    session.subscribe((event) => {
      let eventUsage: Usage | undefined;
      if (event.type === "message_end") {
        const message = event.message;
        if (message.role === "assistant") {
          usage.turns++;
          report = assistantReport(message);
        }
        if (message.role === "assistant" || message.role === "toolResult") eventUsage = message.usage;
      } else if (event.type === "compaction_end") {
        eventUsage = event.result?.usage;
      } else if (event.type === "tool_execution_start" && pipe.writableLength < 8192) {
        pipe.write(JSON.stringify({ version: CHILD_PROTOCOL_VERSION, kind: "progress", text: `Running ${truncateOutput(event.toolName, 256)}...` }) + "\n");
      }
      if (eventUsage) {
        addUsage(usage, eventUsage);
        // Coalesce under backpressure. The final report always includes full usage.
        if (pipe.writableLength < 8192) pipe.write(JSON.stringify({ version: CHILD_PROTOCOL_VERSION, kind: "usage", usage }) + "\n");
      }
    });
    abort.signal.throwIfAborted();
    await session.prompt(request.prompt, { expandPromptTemplates: false, source: "extension" });
    await session.waitForIdle();
    await send({ version: CHILD_PROTOCOL_VERSION, kind: "result", report, usage });
  } catch (error) {
    await send({ version: CHILD_PROTOCOL_VERSION, kind: "error", errorMessage: boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child failed." });
    process.exitCode = 1;
  } finally {
    try {
      if (session) await closeChildSession(session);
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      await new Promise<void>((resolve) => pipe.end(resolve));
    }
  }
}
