import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createOrcheTools } from "../tools/index.js";
import { createSpillExtension } from "../tools/spill.js";
export interface SessionOptions {
  route: { role: string; model: string; thinking?: ThinkingLevel };
  cwd: string;
  tools?: string[];
  customTools?: ToolDefinition[];
  instructions: string;
  /** Replaces Pi's default base system prompt; role `instructions` are still appended. */
  baseSystemPrompt?: string;
  sessionDir?: string;
  modelRuntime?: ModelRuntime;
}
let defaultRuntime: Promise<ModelRuntime> | undefined;
export async function createSession(
  options: SessionOptions,
): Promise<AgentSession> {
  const runtime = options.modelRuntime ?? await (defaultRuntime ??= ModelRuntime.create());
  const slash = options.route.model.indexOf("/");
  const model = runtime.getModel(
    options.route.model.slice(0, slash),
    options.route.model.slice(slash + 1),
  );
  if (!model) throw new Error(`Unknown model: ${options.route.model}`);
  const loader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [createSpillExtension(options.cwd)],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.baseSystemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [options.instructions],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  return (
    await createAgentSession({
      cwd: options.cwd,
      modelRuntime: runtime,
      model,
      thinkingLevel: options.route.thinking ?? "off",
      tools: options.tools,
      customTools: [...createOrcheTools({ cwd: options.cwd }), ...(options.customTools ?? [])],
      resourceLoader: loader,
      sessionManager: options.sessionDir
        ? SessionManager.create(options.cwd, options.sessionDir)
        : SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: {
          enabled: true,
          maxRetries: 1,
          baseDelayMs: 250,
          maxAgentDelayMs: 1000,
          provider: { maxRetries: 0, maxRetryDelayMs: 1000 },
        },
      }),
    })
  ).session;
}
