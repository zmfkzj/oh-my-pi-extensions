// Shared by the root's Pi-level checks: finds a Pi install (the root manifest does not depend on Pi) and starts real Pi
// sessions (SDK, faux model, in-memory settings and session) with chosen extensions loaded through Pi's own resource loader.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_NAME = "@earendil-works/pi-coding-agent";
/** The Pi version these checks validate; OMP_PI_VERSION selects another (for example an older Pi still supported). */
export const PI_VERSION = process.env.OMP_PI_VERSION || "1.4.0";

const versionOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; } catch { return undefined; } };
function isPiPackage(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === PI_NAME && existsSync(join(dir, "dist/index.js")); } catch { return false; }
}
/** The Pi package `name` (pi-ai, pi-tui) installed next to the coding agent at `dir`, or in its own node_modules. */
const siblingOf = (dir, name) => [join(dir, "node_modules/@earendil-works", name), join(dir, "..", name)].find(path => existsSync(join(path, "dist/index.js")));

function describe(dir) {
  const ai = siblingOf(dir, "pi-ai");
  const tui = siblingOf(dir, "pi-tui");
  return { dir, ai, tui, version: versionOf(dir), aiVersion: ai && versionOf(ai), tuiVersion: tui && versionOf(tui) };
}
const matches = (found) => found.ai && found.version === PI_VERSION && found.aiVersion === PI_VERSION && (!found.tui || found.tuiVersion === PI_VERSION);
const label = (found) => `${found.dir} (pi-coding-agent ${found.version}); pi-ai ${found.aiVersion ?? "missing"} at ${found.ai ?? "missing"}; pi-tui ${found.tuiVersion ?? "missing"} at ${found.tui ?? "missing"}`;

/**
 * The Pi install to validate, at exactly PI_VERSION (coding agent, pi-ai and, when present, pi-tui). OMP_PI_DIR names it
 * explicitly and must match; otherwise the `pi` on PATH, then a submodule's copy. Throws instead of falling back to another
 * version or skipping, so a check never passes on a Pi it was not meant to validate.
 */
export function findPi() {
  const report = found => { console.log(describePi(found)); return found; };
  if (process.env.OMP_PI_DIR) {
    const dir = resolve(process.env.OMP_PI_DIR);
    if (!isPiPackage(dir)) throw new Error(`OMP_PI_DIR=${dir} is not a ${PI_NAME} package with dist/index.js`);
    const found = describe(dir);
    if (!matches(found)) throw new Error(`OMP_PI_DIR is ${label(found)}; these checks validate Pi ${PI_VERSION} (set OMP_PI_VERSION to validate another)`);
    return report(found);
  }
  const candidates = [];
  try {
    let dir = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()));
    for (let i = 0; i < 6; i++, dir = dirname(dir)) candidates.push(dir);
  } catch { /* no pi on PATH */ }
  for (const sub of ["orche", "pi-gui", "pi-commit", "browser", "session-bus"]) candidates.push(join(root, sub, "node_modules", PI_NAME));
  const seen = candidates.filter(isPiPackage).map(describe);
  const found = seen.find(matches);
  if (found) return report(found);
  throw new Error(`No Pi ${PI_VERSION} found (set OMP_PI_DIR to a ${PI_NAME} ${PI_VERSION} package directory). Seen: ${seen.map(label).join("; ") || "none"}`);
}

/** One line naming the Pi a check actually runs on. */
export const describePi = (found) => `Pi under test: ${label(found)}`;

/** The root manifest's extension entries whose path matches. */
export function manifestExtensions(match) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return manifest.pi.extensions.filter(path => match(path)).map(path => resolve(root, path));
}

/**
 * Real Pi runtime/loader, faux model, isolated credentials/settings, and loopback-only fetch. `OMP_PI_DIR` selects SDK
 * code; `PI_CODING_AGENT_DIR` is ONLY the temporary user data directory. Never use one for both purposes.
 * Native tool_search/MCP factories mirror the CLI (the SDK does not add them automatically). Every model request records
 * declarations/context. `persistent` uses real JSONL; `runtime` supports native new/resume, `session.reload()` native reload.
 * `setup` runs before loading resources; `bind:false` is useful for command discovery without session_start.
 */
export async function startPiSession(found, {
  extensionPaths = [], extensionFactories = [], settings = {}, steps = [], platform,
  persistent = false, nativeExtensions = true, resourceOptions = {}, sessionOptions = {}, setup, bind = true, env = {},
} = {}) {
  if (!matches(describe(found.dir))) throw new Error(`Session requires Pi ${PI_VERSION}: ${label(describe(found.dir))}`);
  const pi = await import(pathToFileURL(join(found.dir, "dist/index.js")).href);
  const ai = await import(pathToFileURL(join(found.ai, "dist/index.js")).href);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "omp-pi-session-")));
  const agentDir = join(cwd, "agent");
  const environment = {
    PI_CODING_AGENT_DIR: agentDir, PI_AGENT_HOME: agentDir, PI_OFFLINE: "1",
    XDG_RUNTIME_DIR: join(cwd, "run"), PI_SESSION_BUS_DIR: join(agentDir, "session-bus"),
    CLIPROXYAPI_BASE_URL: "http://127.0.0.1:9", CLIPROXYAPI_API_KEY: "", PI_CLIPROXYAPI_BUNDLED: "on",
    ...env,
  };
  const savedEnv = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const realFetch = globalThis.fetch;
  const blockedRequests = [];
  let runtime, partialSession, runtimeFd, disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (runtime) await runtime.dispose();
      else if (partialSession) await partialSession.abort();
    } finally {
      try { (runtime?.session ?? partialSession)?.dispose(); }
      finally {
        globalThis.fetch = realFetch;
        for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        if (runtimeFd !== undefined) closeSync(runtimeFd);
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  };
  try {
    mkdirSync(join(agentDir, "tmp"), { recursive: true });
    mkdirSync(environment.XDG_RUNTIME_DIR, { recursive: true });
    // Linux's AF_UNIX path limit is shorter than many scratch paths. /proc is only an alias of our scratch directory,
    // never the user's /run/user directory, and the descriptor is closed after all endpoints shut down.
    if (process.platform === "linux") {
      runtimeFd = openSync(environment.XDG_RUNTIME_DIR, "r");
      environment.XDG_RUNTIME_DIR = `/proc/${process.pid}/fd/${runtimeFd}`;
    }
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
    // Prevent the bundled provider's optional live pricing catalog request, even with a local model catalog.
    writeFileSync(join(agentDir, "tmp/models-dev-cache.json"), JSON.stringify({ timestamp: Date.now(), providers: {} }));
    Object.assign(process.env, environment);
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        blockedRequests.push(url.origin + url.pathname);
        throw new Error(`Offline Pi test blocked fetch to ${url.origin}`);
      }
      return realFetch(input, { ...init, redirect: "error" });
    };
    const requests = [], notifications = [], errors = [];
    const faux = ai.fauxProvider({ provider: `omp-faux-${Math.random().toString(36).slice(2)}` });
    const record = step => (context, options, state, model) => {
      requests.push({ tools: ai.getCurrentTools(context.messages), systemPrompt: ai.getCurrentSystemPrompt(context.messages), messages: context.messages });
      return typeof step === "function" ? step(context, options, state, model) : step;
    };
    const respond = more => faux.appendResponses((typeof more === "function" ? more(ai) : more).map(record));
    respond(steps);
    const modelRuntime = await pi.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const builtins = nativeExtensions ? [pi.createToolSearchExtension(), pi.createMcpExtension()] : [];
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const withPlatform = async run => {
      if (platform) Object.defineProperty(process, "platform", { ...realPlatform, value: platform });
      try { return await run(); } finally { if (platform) Object.defineProperty(process, "platform", realPlatform); }
    };
    const noop = () => undefined;
    const uiContext = {
      notify: (message, level) => notifications.push({ message, level }), confirm: async () => false, select: async () => undefined,
      input: async () => undefined, editor: async () => undefined, custom: async () => undefined, onTerminalInput: () => noop,
      getEditorText: () => "", getAllThemes: () => [], getToolsExpanded: () => false, setTheme: () => ({ success: false, error: "UI not available" }),
      ...Object.fromEntries(["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget",
        "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent",
        "getEditorComponent", "getTheme", "setToolsExpanded"].map(name => [name, noop])),
    };
    await setup?.({ cwd, agentDir, pi, ai });
    const factory = async ({ cwd: targetCwd, sessionManager, sessionStartEvent }) => {
      const services = await pi.createAgentSessionServices({
        cwd: targetCwd, agentDir, modelRuntime, settingsManager: pi.SettingsManager.inMemory({ ...settings, compaction: { enabled: false } }),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          ...resourceOptions, additionalExtensionPaths: extensionPaths, extensionFactories: [...builtins, ...extensionFactories],
        },
      });
      const loaded = services.resourceLoader.getExtensions().errors;
      if (loaded.length) throw new Error(`Pi extension load failed: ${JSON.stringify(loaded)}`);
      const created = await pi.createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent, model: faux.getModel(), ...sessionOptions,
      });
      partialSession = created.session;
      return { services, diagnostics: services.diagnostics, ...created };
    };
    runtime = await pi.createAgentSessionRuntime(factory, {
      cwd, agentDir, sessionManager: persistent ? pi.SessionManager.create(cwd, join(cwd, "sessions")) : pi.SessionManager.inMemory(cwd),
    });
    const rebind = session => withPlatform(() => session.bindExtensions({ mode: "tui", uiContext, onError: error => errors.push(error), commandContextActions: {
      newSession: options => runtime.newSession(options), switchSession: path => runtime.switchSession(path),
      fork: id => runtime.fork(id), reload: () => withPlatform(() => runtime.session.reload()),
      waitForIdle: () => runtime.session.agent.waitForIdle(),
    } }));
    runtime.setRebindSession(rebind);
    if (bind) await rebind(runtime.session);
    return { pi, ai, runtime, get session() { return runtime.session; }, get loader() { return runtime.services.resourceLoader; },
      faux, requests, respond, notifications, errors, blockedRequests, cwd, agentDir, withPlatform, dispose };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Pi setup and cleanup failed"); }
    throw error;
  }
}

/** Model-facing size of declarations: the JSON a request carries per tool (name, description, parameters). */
export function declarationSize(tools) {
  const json = tools.map(tool => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  return { count: tools.length, chars: json.reduce((sum, text) => sum + text.length, 0), bytes: json.reduce((sum, text) => sum + Buffer.byteLength(text), 0) };
}
