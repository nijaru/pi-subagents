import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSessionServices, createAgentSessionFromServices, getAgentDir, ProjectTrustStore, SessionManager, SettingsManager,
  type AgentSession, type DefaultProjectTrust, type InlineExtension, type LoadExtensionsResult, type ProjectTrustContext,
} from "@earendil-works/pi-coding-agent";
import type { ChildBootstrap } from "./child-protocol.ts";

export interface ChildSessionPolicy {
  builtInExtensions: InlineExtension[];
  resolveProjectTrust: (options: {
    cwd: string;
    trustStore: ProjectTrustStore;
    defaultProjectTrust: DefaultProjectTrust;
    extensionsResult: LoadExtensionsResult;
    projectTrustContext: ProjectTrustContext;
    onExtensionError: (message: string) => void;
  }) => Promise<boolean>;
}

// Pi's MCP allowlist exception includes these unnamespaced resource tools.
const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const isMcpTool = (name: string) => name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.includes(name);

/** Initialize and verify one selected-installation Pi session before task execution. */
export async function createChildSession(request: ChildBootstrap, policy: ChildSessionPolicy, signal: AbortSignal): Promise<AgentSession> {
  signal.throwIfAborted();
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  // Start untrusted so project code/settings cannot run before Pi decides.
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const trustStore = new ProjectTrustStore(agentDir);
  const services = await createAgentSessionServices({
    cwd, agentDir, settingsManager, modelRuntimeSignal: signal,
    resourceLoaderOptions: { extensionFactories: policy.builtInExtensions },
    resourceLoaderReloadOptions: {
      resolveProjectTrust: ({ extensionsResult }) => policy.resolveProjectTrust({
        cwd, trustStore, extensionsResult, defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
        projectTrustContext: {
          cwd, mode: "json", hasUI: false,
          ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: (message) => console.error(message) },
        },
        onExtensionError: (message) => console.error(message),
      }),
    },
  });
  signal.throwIfAborted();
  for (const diagnostic of services.diagnostics) console.error(diagnostic.message);
  const loadErrors = services.resourceLoader.getExtensions().errors;
  if (loadErrors.length) throw new Error(loadErrors.map((error) => `${error.path}: ${error.error}`).join("\n"));
  if (services.diagnostics.some((diagnostic) => diagnostic.type === "error")) throw new Error("Child resource initialization failed.");
  // Model references are exact provider/id identities, not fuzzy CLI patterns.
  const separator = request.model?.indexOf("/") ?? -1;
  const model = request.model && separator > 0
    ? services.modelRuntime.getModel(request.model.slice(0, separator), request.model.slice(separator + 1)) : undefined;
  if (request.model && !model) throw new Error(`Requested child model is unavailable: ${request.model}`);
  const { session } = await createAgentSessionFromServices({
    services, model, tools: request.tools,
    // Pi 1.0.4 retains omitted MCP tools for nested calls unless an MCP name
    // occurs in the allowlist. An active-name check alone cannot restrict them.
    excludeTools: [
      ...(request.tools.some((name) => name.startsWith("mcp__")) ? [] : ["mcp__*"]),
      ...MCP_RESOURCE_TOOLS.filter((name) => !request.tools.includes(name)),
    ],
    thinkingLevel: request.thinking,
    sessionManager: SessionManager.inMemory(cwd),
  });
  try {
    await session.bindExtensions({ mode: "json", onError: (error) => console.error(error.error) });
    signal.throwIfAborted();
    const missingTools = () => {
      const available = new Set(session.getAllTools().map((tool) => tool.name));
      return request.tools.filter((tool) => !available.has(tool));
    };
    // MCP connects in the background. Never prompt with a partial loadout;
    // registration has Pi's 10s startup budget and the execution abort signal.
    const until = Date.now() + 10_000;
    while (missingTools().some(isMcpTool) && Date.now() < until) {
      await delay(25, undefined, { signal });
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
    return session;
  } catch (error) {
    // Startup owns the session until it returns; failed initialization must
    // release partially bound integrations too, without masking its cause.
    await closeChildSession(session).catch((cleanupError) => console.error(cleanupError));
    throw error;
  }
}

export async function closeChildSession(session: AgentSession): Promise<void> {
  try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
  finally { session.dispose(); }
}
