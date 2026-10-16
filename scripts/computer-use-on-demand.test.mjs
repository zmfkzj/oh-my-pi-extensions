// On-demand loading of the physical-desktop tools (extensions/computer-use): unit checks of the wrapper with a fake
// ExtensionAPI, and real Pi sessions (Pi's loader, faux model, temporary agent dir) over the root manifest's entry and
// the real @amaster.ai/pi-computer-use. The driver never starts: settings give it a missing custom binary, and the
// manifest path forces process.platform "darwin" during session_start, where upstream registers its bundled tool
// manifest without starting the driver. No user desktop, settings or credentials are touched.
import assert from "node:assert/strict";
import test from "node:test";
import { CONNECT, CORE_GROUP, LOADER, createComputerUseOnDemand, loadsOnDemand } from "../extensions/computer-use/on-demand.js";
import { declarationSize, findPi, manifestExtensions, startPiSession } from "./pi-harness.mjs";

// ---------------------------------------------------------------------------------------------- unit (fake API)

function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  let active = [];
  const pi = {
    registerTool(def) {
      const isNew = !tools.has(def.name);
      tools.set(def.name, def);
      if (isNew && (def.exposure ?? "direct") === "direct" && def.defaultActive !== false && !active.includes(def.name)) active.push(def.name);
    },
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    getAllTools: () => [...tools.values()].map(def => ({ name: def.name, exposure: def.exposure ?? "direct" })),
    getActiveTools: () => [...active],
    setActiveTools(names) { active = names.filter(name => tools.has(name)); },
  };
  const emit = async (event, ctx) => { for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx); };
  return { pi, tools, commands, emit, active: () => active };
}

/** A stand-in with upstream's registration pattern: loader at load, driver tools then core profile at session start. */
function fakeUpstream({ connectFirst = false } = {}) {
  return (pi) => {
    const driver = new Set();
    const register = (names) => { for (const name of names) { driver.add(`computer_use_${name}`); pi.registerTool({ name: `computer_use_${name}`, label: name, description: name, parameters: {}, execute: async () => ({ content: [{ type: "text", text: `ran ${name}` }], details: undefined }) }); } };
    const applyCore = () => pi.setActiveTools(pi.getActiveTools().filter(name => !driver.has(name) || ["click", "type_text"].includes(name.slice(13))));
    pi.registerTool({
      name: LOADER, label: LOADER, description: "upstream loader", parameters: { upstream: true },
      promptGuidelines: ["Only the core computer-use tools are active by default."],
      execute: async (_id, params) => {
        if (!params.group) return { content: [{ type: "text", text: "Computer-use tool groups:\n- window (1 tools, inactive): windows" }], details: undefined };
        pi.setActiveTools([...pi.getActiveTools(), "computer_use_list_windows"]);
        return { content: [{ type: "text", text: `Activated group "${params.group}"` }], details: undefined };
      },
    });
    pi.on("session_start", async () => {
      if (connectFirst) {
        pi.registerTool({ name: CONNECT, label: CONNECT, description: "retry", parameters: {}, execute: async () => { register(["click", "type_text", "list_windows"]); applyCore(); return { content: [{ type: "text", text: "Cua Driver connected; registered 3 platform tools." }], details: undefined }; } });
        return;
      }
      register(["click", "type_text", "list_windows"]);
      applyCore();
    });
  };
}

const wrapper = (upstream, config = {}) => createComputerUseOnDemand({
  upstream, coreTools: ["click", "type_text"], groups: { window: { summary: "windows", tools: ["list_windows"] } },
  loadConfig: () => ({ toolProfile: "core", ...config }), loaderParameters: groups => ({ type: "object", properties: { group: { type: "string", enum: groups } } }),
});

test("unit: on-demand is the default for upstream's core profile; full or loadOnDemand:false opt out", () => {
  assert.equal(loadsOnDemand({ toolProfile: "core" }), true);
  assert.equal(loadsOnDemand({}), true);
  assert.equal(loadsOnDemand({ toolProfile: "full" }), false);
  assert.equal(loadsOnDemand({ toolProfile: "core", loadOnDemand: false }), false);
});

test("unit: driver tools start inactive, the loader loads core and delegates groups, upstream's core filter keeps loaded tools", async () => {
  const f = fakePi();
  wrapper(fakeUpstream())(f.pi);
  await f.emit("session_start", {});
  assert.deepEqual(f.active(), [LOADER], "only the small loader is declared at start");
  assert.equal(f.tools.get("computer_use_click").defaultActive, false);
  assert.deepEqual(f.tools.get(LOADER).parameters.properties.group.enum, [CORE_GROUP, "window"]);
  assert.match(f.tools.get(LOADER).promptGuidelines[0], /loaded on demand/);
  const loader = f.tools.get(LOADER);
  const loaded = await loader.execute("1", { group: CORE_GROUP });
  assert.match(loaded.content[0].text, /^Loaded the core computer-use tools \(2\)/);
  assert.deepEqual(f.active(), [LOADER, "computer_use_click", "computer_use_type_text"]);
  assert.match((await loader.execute("2", { group: CORE_GROUP })).content[0].text, /^Already loaded/);
  assert.match((await loader.execute("3", { group: "window" })).content[0].text, /Activated group "window"/, "other groups stay upstream's");
  assert.match((await loader.execute("4", {})).content[0].text, /^Computer-use tool groups:\n- core \(2 tools, loaded\)/);
  // A second session_start (reload, resume): upstream re-registers and re-applies its core filter; nothing loaded is dropped.
  await f.emit("session_start", {});
  assert.deepEqual(f.active().sort(), [LOADER, "computer_use_click", "computer_use_list_windows", "computer_use_type_text"].sort());
});

test("unit: a later driver connect loads core like upstream's start-up; failures load nothing", async () => {
  const f = fakePi();
  wrapper(fakeUpstream({ connectFirst: true }))(f.pi);
  await f.emit("session_start", {});
  const before = await f.tools.get(LOADER).execute("1", { group: CORE_GROUP });
  assert.equal(before.isError, true);
  assert.match(before.content[0].text, /connect the driver first with computer_use_connect/);
  const connected = await f.tools.get(CONNECT).execute("2", {});
  assert.match(connected.content.at(-1).text, /Loaded the core computer-use tools \(2\).*Load other groups with computer_use_tools/);
  assert.deepEqual(f.active().sort(), [CONNECT, LOADER, "computer_use_click", "computer_use_type_text"].sort());
});

test("unit: opt-out passes upstream through unchanged; other tools and commands are never touched", async () => {
  const f = fakePi();
  wrapper(fakeUpstream(), { toolProfile: "full" })(f.pi);
  await f.emit("session_start", {});
  assert.equal(f.tools.get(LOADER).description, "upstream loader");
  assert.equal(f.tools.get("computer_use_click").defaultActive, undefined);
  assert.deepEqual(f.active(), [LOADER, "computer_use_click", "computer_use_type_text"], "upstream's own core start-up");
  const g = fakePi();
  wrapper((pi) => { pi.registerTool({ name: "mcp__computer_use__dispatch", label: "d", description: "private desktop", parameters: {} }); pi.registerCommand("gui", { handler: async () => {} }); })(g.pi);
  await g.emit("session_start", {});
  assert.equal(g.tools.get("mcp__computer_use__dispatch").defaultActive, undefined, "pi-gui's private-desktop names are not this prefix");
  assert.deepEqual(g.active(), ["mcp__computer_use__dispatch"]);
  assert.ok(g.commands.has("gui"));
});

// ------------------------------------------------------------------------------- real Pi sessions (Pi's loader)

const found = findPi();
const entry = manifestExtensions(path => path.includes("computer-use"));
const MISSING_DRIVER = { mode: "path", binaryPath: "/nonexistent/cua-driver" };
const physical = (tools) => tools.map(tool => tool.name).filter(name => name.startsWith("computer_use_"));
const results = (session) => session.messages.filter(message => message.role === "toolResult")
  .map(message => ({ name: message.toolName, isError: message.isError === true, text: message.content.map(block => block.text ?? "").join("\n") }));
const call = (ai, name, args) => ai.fauxAssistantMessage(ai.fauxToolCall(name, args), { stopReason: "toolUse" });

test("manifest: the physical-desktop entry is the on-demand wrapper, not the package itself", () => {
  assert.deepEqual(entry.map(path => path.slice(path.lastIndexOf("/extensions/"))), ["/extensions/computer-use/index.js"]);
});

test("Pi session: only the loader is declared; core, groups and calls work after loading; unloaded tools are not callable; reload keeps them", { timeout: 120_000 }, async (t) => {
  const h = await startPiSession(found, {
    extensionPaths: entry, platform: "darwin", settings: { "pi-computer-use": MISSING_DRIVER },
    steps: ai => [
      call(ai, "computer_use_clipboard_read", {}),
      call(ai, LOADER, { group: CORE_GROUP }),
      call(ai, LOADER, { group: "window" }),
      call(ai, "computer_use_list_apps", {}),
      call(ai, LOADER, {}),
      ai.fauxAssistantMessage("done"),
    ],
  });
  t.after(() => h.dispose());
  assert.deepEqual(h.loader.getExtensions().errors, []);
  assert.ok(h.session.getAllTools().filter(tool => tool.name.startsWith("computer_use_")).length > 50, "every driver tool stays registered");
  await h.session.prompt("operate my screen");

  const [first, afterCore, afterWindow] = h.requests;
  assert.deepEqual(physical(first.tools), [LOADER], "first request: the loader only");
  assert.match(first.systemPrompt, /computer_use_\* tools act on the user's physical screen and are loaded on demand/);
  assert.doesNotMatch(first.systemPrompt, /Only the core computer-use tools are active by default/, "upstream's guideline is replaced, not repeated");
  assert.ok(declarationSize(first.tools.filter(tool => tool.name === LOADER)).chars < 2_000);
  assert.deepEqual(physical(afterCore.tools), [LOADER], "the clipboard call failed: nothing loaded by it");
  assert.equal(physical(h.requests[2].tools).length, 15, "loader + the 14 core tools after group core");
  assert.ok(physical(h.requests[3].tools).includes("computer_use_list_windows"), "upstream's window group still loads");
  assert.ok(afterWindow);

  const out = results(h.session);
  assert.equal(out[0].isError, true, "an unloaded tool is not callable");
  assert.match(out[1].text, /^Loaded the core computer-use tools \(14\): computer_use_list_apps/);
  assert.match(out[2].text, /Activated group "window"/);
  assert.equal(out[3].isError, true);
  assert.match(out[3].text, /Failed to connect to cua-driver/, "a loaded tool runs upstream's execute (driver missing, nothing started)");
  assert.match(out[4].text, /^Computer-use tool groups:\n- core \(14 tools, loaded\)/);

  // /reload: upstream re-registers everything and re-applies its core profile; what this session loaded stays declared.
  const loadedBefore = h.session.getActiveToolNames().filter(name => name.startsWith("computer_use_")).sort();
  await h.withPlatform(() => h.session.reload());
  assert.deepEqual(h.session.getActiveToolNames().filter(name => name.startsWith("computer_use_")).sort(), loadedBefore);
});

test("Pi session: /computer-use-tools core loads the core set; completions offer core", { timeout: 120_000 }, async (t) => {
  const h = await startPiSession(found, { extensionPaths: entry, platform: "darwin", settings: { "pi-computer-use": MISSING_DRIVER } });
  t.after(() => h.dispose());
  const command = h.session.extensionRunner.getRegisteredCommands().find(item => item.name === "computer-use-tools");
  assert.deepEqual(command.getArgumentCompletions("c").map(item => item.value), ["core", "cursor", "clipboard"]);
  await h.session.prompt("/computer-use-tools core");
  assert.equal(h.session.getActiveToolNames().filter(name => name.startsWith("computer_use_")).length, 15);
  assert.ok(h.notifications.some(item => /Loaded the core computer-use tools \(14\)/.test(item.message)));
});

test("Pi session: opting out restores upstream's start-up core set", { timeout: 120_000 }, async (t) => {
  const h = await startPiSession(found, {
    extensionPaths: entry, platform: "darwin", settings: { "pi-computer-use": { ...MISSING_DRIVER, loadOnDemand: false } },
    steps: ai => [ai.fauxAssistantMessage("OK")],
  });
  t.after(() => h.dispose());
  await h.session.prompt("hi");
  assert.equal(physical(h.requests[0].tools).length, 15);
  assert.match(h.requests[0].tools.find(tool => tool.name === LOADER).description, /^List and activate additional computer-use tool groups/);
});

test("Pi session (Linux path): failed discovery keeps the recovery surface; loading core then asks for a connect", { timeout: 120_000 }, async (t) => {
  const h = await startPiSession(found, {
    extensionPaths: entry, settings: { "pi-computer-use": MISSING_DRIVER },
    steps: ai => [call(ai, LOADER, { group: CORE_GROUP }), call(ai, CONNECT, {}), ai.fauxAssistantMessage("done")],
  });
  t.after(() => h.dispose());
  if (process.platform === "darwin") return; // the manifest path; covered above
  await h.session.prompt("operate my screen");
  assert.deepEqual(physical(h.requests[0].tools).sort(), [CONNECT, LOADER].sort());
  const out = results(h.session);
  assert.match(out[0].text, /connect the driver first with computer_use_connect/);
  assert.match(out[1].text, /Cua Driver is still unavailable/);
});
