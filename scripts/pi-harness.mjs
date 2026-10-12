// Shared by the root's Pi-level checks: finds a Pi install (the root manifest does not depend on Pi) and starts real Pi
// sessions (SDK, faux model, in-memory settings and session) with chosen extensions loaded through Pi's own resource loader.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_NAME = "@earendil-works/pi-coding-agent";

function isPiPackage(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === PI_NAME && existsSync(join(dir, "dist/index.js")); } catch { return false; }
}

/** PI_CODING_AGENT_DIR, else the `pi` on PATH, else a submodule's copy; with the pi-ai package next to it. */
export function findPi() {
  const candidates = [];
  if (process.env.PI_CODING_AGENT_DIR && isPiPackage(process.env.PI_CODING_AGENT_DIR)) candidates.push(process.env.PI_CODING_AGENT_DIR);
  try {
    let dir = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
    for (let i = 0; i < 6; i++, dir = dirname(dir)) candidates.push(dir);
  } catch { /* no pi on PATH */ }
  for (const sub of ["orche", "pi-gui", "pi-commit", "browser", "session-bus"]) candidates.push(join(root, sub, "node_modules", PI_NAME));
  for (const dir of candidates.filter(isPiPackage)) {
    const ai = [join(dir, "..", "pi-ai"), join(dir, "node_modules/@earendil-works/pi-ai")].find(path => existsSync(join(path, "dist/index.js")));
    if (ai) return { dir, ai, version: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version };
  }
  return undefined;
}

/** The root manifest's extension entries whose path matches. */
export function manifestExtensions(match) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return manifest.pi.extensions.filter(path => match(path)).map(path => resolve(root, path));
}

/**
 * A real Pi session over `extensionPaths`. Pi's agent dir is a fresh temporary one (`settings` is written to its
 * settings.json, the only settings extensions such as pi-computer-use read), so the user's settings and credentials are
 * never read. `platform` overrides `process.platform` only while the extensions' session_start handlers run.
 * Every model request records the declared tools and the system prompt in `requests`. `steps` are faux responses, or a
 * function of pi-ai's module (for `fauxAssistantMessage` / `fauxToolCall`) that returns them; `respond()` appends more.
 * @param {{ dir: string, ai: string }} found
 * @param {{ extensionPaths: string[], settings?: object, steps?: any[] | ((ai: any) => any[]), platform?: string }} options
 */
export async function startPiSession(found, { extensionPaths, settings = {}, steps = [], platform }) {
  const pi = await import(pathToFileURL(join(found.dir, "dist/index.js")).href);
  const ai = await import(pathToFileURL(join(found.ai, "dist/index.js")).href);
  const cwd = mkdtempSync(join(tmpdir(), "omp-pi-session-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  const savedEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_AGENT_HOME", "PI_OFFLINE"].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
  process.env.PI_OFFLINE = "1";
  const requests = [];
  const faux = ai.fauxProvider({ provider: `omp-faux-${Math.random().toString(36).slice(2)}` });
  const record = step => (context, options, state, model) => {
    requests.push({ tools: ai.getCurrentTools(context.messages), systemPrompt: ai.getCurrentSystemPrompt(context.messages) });
    return typeof step === "function" ? step(context, options, state, model) : step;
  };
  const respond = (more) => faux.appendResponses((typeof more === "function" ? more(ai) : more).map(record));
  respond(steps);
  const runtime = await pi.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new pi.DefaultResourceLoader({
    cwd, agentDir, settingsManager, additionalExtensionPaths: extensionPaths,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), resourceLoader: loader, settingsManager,
    sessionManager: pi.SessionManager.inMemory(cwd),
  });
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const withPlatform = async (run) => {
    if (platform) Object.defineProperty(process, "platform", { ...realPlatform, value: platform });
    try { return await run(); } finally { if (platform) Object.defineProperty(process, "platform", realPlatform); }
  };
  const notifications = [];
  // Spread by Pi (ExtensionRunner.wrapUIPromptContext), so a plain object; confirmations are declined, as without a UI.
  const noop = () => undefined;
  const uiContext = {
    notify: (message, level) => notifications.push({ message, level }), confirm: async () => false, select: async () => undefined,
    input: async () => undefined, editor: async () => undefined, custom: async () => undefined, onTerminalInput: () => noop,
    getEditorText: () => "", getAllThemes: () => [], getToolsExpanded: () => false, setTheme: () => ({ success: false, error: "UI not available" }),
    ...Object.fromEntries(["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget",
      "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent",
      "getEditorComponent", "getTheme", "setToolsExpanded"].map(name => [name, noop])),
  };
  await withPlatform(() => session.bindExtensions({ uiContext }));
  const dispose = async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(cwd, { recursive: true, force: true });
  };
  return { pi, ai, session, loader, faux, requests, respond, notifications, cwd, agentDir, withPlatform, dispose };
}

/** Model-facing size of declarations: the JSON a request carries per tool (name, description, parameters). */
export function declarationSize(tools) {
  const json = tools.map(tool => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  return { count: tools.length, chars: json.reduce((sum, text) => sum + text.length, 0), bytes: json.reduce((sum, text) => sum + Buffer.byteLength(text), 0) };
}
