import { createWriteStream } from "node:fs";
import {
  createAgentSessionServices, createAgentSessionFromServices, SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { addUsage, emptyUsage } from "./types.ts";
import { boundedDiagnostic, truncateOutput } from "./bounds.ts";
import { MAX_TASK_BYTES } from "./limits.ts";
import { assistantReport, CHILD_PROTOCOL_VERSION, emptyReport, type ChildBootstrap, type ChildEvent } from "./child-protocol.ts";

/** SDK host for one leaf task. stdout/stderr remain extension diagnostics, never protocol. */
export async function runChild(): Promise<void> {
  const pipe = createWriteStream("", { fd: 3, autoClose: false });
  let pipeError: Error | undefined;
  pipe.on("error", (error) => { pipeError = error; });
  const send = async (event: ChildEvent) => {
    if (pipeError) throw pipeError;
    await new Promise<void>((resolve, reject) => pipe.write(JSON.stringify(event) + "\n", (error) => error ? reject(error) : resolve()));
  };
  let session: AgentSession | undefined;
  try {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > MAX_TASK_BYTES * 8) throw new Error("Child bootstrap exceeds size limit.");
    }
    const request: ChildBootstrap = JSON.parse(input);
    if (request.version !== CHILD_PROTOCOL_VERSION || typeof request.prompt !== "string" || !Array.isArray(request.tools)
      || !request.tools.every((tool) => typeof tool === "string") || Buffer.byteLength(request.prompt) > MAX_TASK_BYTES) {
      throw new Error("Invalid child bootstrap request.");
    }
    const services = await createAgentSessionServices({ cwd: process.cwd() });
    for (const diagnostic of services.diagnostics) console.error(diagnostic.message);
    const loadErrors = services.resourceLoader.getExtensions().errors;
    if (loadErrors.length) throw new Error(loadErrors.map((error) => `${error.path}: ${error.error}`).join("\n"));
    if (services.diagnostics.some((diagnostic) => diagnostic.type === "error")) throw new Error("Child resource initialization failed.");
    // Model references are exact provider/id identities, not fuzzy CLI patterns.
    const separator = request.model?.indexOf("/") ?? -1;
    const model = request.model && separator > 0
      ? services.modelRuntime.getModel(request.model.slice(0, separator), request.model.slice(separator + 1)) : undefined;
    if (request.model && !model) throw new Error(`Requested child model is unavailable: ${request.model}`);
    const created = await createAgentSessionFromServices({
      services, model, tools: request.tools,
      thinkingLevel: request.thinking as AgentSession["thinkingLevel"] | undefined,
      sessionManager: SessionManager.inMemory(process.cwd()),
    });
    session = created.session;
    await session.bindExtensions({ mode: "json", onError: (error) => console.error(error.error) });
    const available = new Set(session.getAllTools().map((tool) => tool.name));
    const missing = request.tools.filter((tool) => !available.has(tool));
    if (missing.length) throw new Error(`Requested child tools are unavailable: ${missing.join(", ")}`);
    session.setActiveToolsByName(request.tools);
    const active = session.getActiveToolNames();
    if (active.length !== request.tools.length || request.tools.some((tool) => !active.includes(tool))) throw new Error("Child tool selection did not match request.");
    if (!session.model || (request.model && `${session.model.provider}/${session.model.id}` !== request.model)) throw new Error("Child model selection did not match request.");
    await send({ version: 1, kind: "ready", model: `${session.model.provider}/${session.model.id}`, tools: active });
    let report = emptyReport();
    const usage = emptyUsage();
    session.subscribe((event) => {
      if (event.type === "message_end") {
        const message = event.message;
        if (message.role === "assistant") {
          usage.turns++;
          report = assistantReport(message);
        }
        if ((message.role === "assistant" || message.role === "toolResult") && message.usage) addUsage(usage, message.usage);
        // Coalesce under backpressure. The final report always includes full usage.
        if (pipe.writableLength < 8192) pipe.write(JSON.stringify({ version: 1, kind: "usage", usage }) + "\n");
      } else if (event.type === "tool_execution_start" && pipe.writableLength < 8192) {
        pipe.write(JSON.stringify({ version: 1, kind: "progress", text: `Running ${truncateOutput(event.toolName, 256)}...` }) + "\n");
      }
    });
    await session.prompt(request.prompt, { expandPromptTemplates: false, source: "extension" });
    await session.waitForIdle();
    await send({ version: 1, kind: "result", report, usage });
  } catch (error) {
    await send({ version: 1, kind: "error", errorMessage: boundedDiagnostic(error instanceof Error ? error.message : String(error)) ?? "Child failed." });
    process.exitCode = 1;
  } finally {
    if (session) {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await new Promise<void>((resolve) => pipe.end(resolve));
  }
}
