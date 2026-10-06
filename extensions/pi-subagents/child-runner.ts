import { createWriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSessionServices, createAgentSessionFromServices, getAgentDir, ProjectTrustStore, SessionManager, SettingsManager,
  type AgentSession, type DefaultProjectTrust, type InlineExtension, type LoadExtensionsResult, type ProjectTrustContext,
} from "@earendil-works/pi-coding-agent";
import { addUsage, emptyUsage, isThinkingLevel } from "./types.ts";
import { boundedDiagnostic, truncateOutput } from "./bounds.ts";
import { MAX_TASK_BYTES } from "./limits.ts";
import { assistantReport, CHILD_PROTOCOL_VERSION, emptyReport, type ChildBootstrap, type ChildEvent } from "./child-protocol.ts";

// Pi's MCP allowlist exception includes these unnamespaced resource tools.
const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const isMcpTool = (name: string) => name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.includes(name);

type ResolveProjectTrust = (options: {
  cwd: string;
  trustStore: ProjectTrustStore;
  defaultProjectTrust: DefaultProjectTrust;
  extensionsResult: LoadExtensionsResult;
  projectTrustContext: ProjectTrustContext;
  onExtensionError: (message: string) => void;
}) => Promise<boolean>;

/** SDK host for one leaf task. stdout/stderr remain extension diagnostics, never protocol. */
export async function runChild(resolveProjectTrust: ResolveProjectTrust, builtInExtensions: InlineExtension[]): Promise<void> {
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
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    // Start untrusted so project code/settings cannot run before Pi decides.
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const trustStore = new ProjectTrustStore(agentDir);
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager, modelRuntimeSignal: abort.signal,
      resourceLoaderOptions: { extensionFactories: builtInExtensions },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: ({ extensionsResult }) => resolveProjectTrust({
          cwd, trustStore, extensionsResult, defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
          projectTrustContext: {
            cwd, mode: "json", hasUI: false,
            ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: (message) => console.error(message) },
          },
          onExtensionError: (message) => console.error(message),
        }),
      },
    });
    abort.signal.throwIfAborted();
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
      // Pi 1.0.4 retains omitted MCP tools for nested calls unless an MCP name
      // occurs in the allowlist. An active-name check alone cannot restrict them.
      excludeTools: [
        ...(request.tools.some((name) => name.startsWith("mcp__")) ? [] : ["mcp__*"]),
        ...MCP_RESOURCE_TOOLS.filter((name) => !request.tools.includes(name)),
      ],
      thinkingLevel: request.thinking,
      sessionManager: SessionManager.inMemory(process.cwd()),
    });
    session = created.session;
    await session.bindExtensions({ mode: "json", onError: (error) => console.error(error.error) });
    abort.signal.throwIfAborted();
    const missingTools = () => {
      const available = new Set(session!.getAllTools().map((tool) => tool.name));
      return request.tools.filter((tool) => !available.has(tool));
    };
    // MCP connects in the background, including tools explicitly requested by
    // name. Gate prompting on their registration, under Pi's 10s startup budget
    // and our cancellation/deadline; never call the model with a partial loadout.
    const until = Date.now() + 10_000;
    while (missingTools().some(isMcpTool) && Date.now() < until) {
      await delay(25, undefined, { signal: abort.signal });
    }
    const missing = missingTools();
    if (missing.length) throw new Error(`Requested child tools are unavailable: ${missing.join(", ")}`);
    session.setActiveToolsByName(request.tools);
    const active = session.getActiveToolNames();
    if (active.length !== request.tools.length || request.tools.some((tool) => !active.includes(tool))) throw new Error("Child tool selection did not match request.");
    if (!session.model || (request.model && `${session.model.provider}/${session.model.id}` !== request.model)) throw new Error("Child model selection did not match request.");
    if (request.strictThinking && session.thinkingLevel !== request.thinking) {
      throw new Error(`Thinking level ${request.thinking} was not selected for ${request.model}; effective level is ${session.thinkingLevel}. Supported: ${session.getAvailableThinkingLevels().join(", ")}.`);
    }
    await send({ version: CHILD_PROTOCOL_VERSION, kind: "ready", model: `${session.model.provider}/${session.model.id}`, thinking: session.thinkingLevel, tools: active });
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
        if (pipe.writableLength < 8192) pipe.write(JSON.stringify({ version: CHILD_PROTOCOL_VERSION, kind: "usage", usage }) + "\n");
      } else if (event.type === "tool_execution_start" && pipe.writableLength < 8192) {
        pipe.write(JSON.stringify({ version: CHILD_PROTOCOL_VERSION, kind: "progress", text: `Running ${truncateOutput(event.toolName, 256)}...` }) + "\n");
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
      if (session) {
        try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
        finally { session.dispose(); }
      }
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      await new Promise<void>((resolve) => pipe.end(resolve));
    }
  }
}
