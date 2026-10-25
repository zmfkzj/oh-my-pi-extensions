// Pi 1.4.0 restores a resumed session's or /tree target's active tools from ALL its recorded tool changes, and activates
// extension tools the branch never added or removed (for example from extensions installed after the session was
// recorded) unless they are registered with `defaultActive: false` or a non-direct exposure. This checks that the
// umbrella's on-demand/deferred surfaces stay on demand under that rule: a session recorded WITHOUT the umbrella
// extensions is reopened (resume, /reload, /tree) WITH the actual browser, physical-desktop and session-bus entries.
// Faux model; no browser engine, desktop driver or network is started.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { findPi, manifestExtensions, startPiSession } from "./pi-harness.mjs";

const found = findPi();
const entries = manifestExtensions(path => path.startsWith("./browser/") || path.includes("computer-use") || path.startsWith("./session-bus/"));
const browserDirect = ["browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_type", "browser_wait", "browser_screenshot", "browser_evaluate", "browser_fetch"];
const LOADER = "computer_use_tools";
const call = (ai, name, args = {}) => ai.fauxAssistantMessage(ai.fauxToolCall(name, args), { stopReason: "toolUse" });
const declared = h => h.requests.at(-1).tools.map(tool => tool.name);
const empty = { type: "object", properties: {} };
const ok = async () => ({ content: [{ type: "text", text: "ok" }], details: undefined });

/** Tools present when the old session was recorded; `drop_me` is removed (and recorded as removed) during that session. */
const before = pi => {
  for (const name of ["keep_me", "drop_me"]) pi.registerTool({ name, label: name, description: name, parameters: empty, execute: ok });
  pi.registerTool({ name: "remover", label: "remover", description: "remove drop_me", parameters: empty,
    execute: async () => { pi.setActiveTools(pi.getActiveTools().filter(name => name !== "drop_me")); return ok(); } });
};
/** The same tools after "installing" new ones: an ordinary direct tool, an opt-in tool and a deferred one. */
const after = pi => {
  before(pi);
  pi.registerTool({ name: "new_direct", label: "new", description: "new direct tool", parameters: empty, execute: ok });
  pi.registerTool({ name: "new_optional", label: "opt", description: "opt-in tool", defaultActive: false, parameters: empty, execute: ok });
  pi.registerTool({ name: "new_deferred", label: "def", description: "deferred tool", exposure: "deferred", parameters: empty, execute: ok });
};

test("session recorded before the umbrella was installed: resume, /reload and /tree keep on-demand surfaces on demand", { timeout: 120_000 }, async t => {
  // 1. Record a session with only the old tools; drop_me's removal is recorded in a later system message.
  const old = await startPiSession(found, { persistent: true, nativeExtensions: false, extensionFactories: [before] });
  t.after(() => old.dispose());
  old.respond(ai => [call(ai, "remover"), ai.fauxAssistantMessage("removed")]);
  await old.session.prompt("Remove drop_me.");
  assert.ok(!declared(old).includes("drop_me") && declared(old).includes("keep_me"));
  const recorded = readFileSync(old.session.sessionFile, "utf8"), oldCwd = old.cwd, name = basename(old.session.sessionFile);
  await old.dispose();

  // 2. Reopen it in a host that now loads the umbrella's browser, physical-desktop and session-bus entries.
  let file;
  const h = await startPiSession(found, {
    persistent: true, platform: "darwin", extensionPaths: entries, extensionFactories: [after],
    settings: { "pi-computer-use": { mode: "path", binaryPath: "/nonexistent/cua-driver" } },
    setup({ cwd, agentDir }) {
      writeFileSync(join(agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath }));
      mkdirSync(join(cwd, "imported"), { recursive: true });
      file = join(cwd, "imported", name);
      writeFileSync(file, recorded.replaceAll(JSON.stringify(oldCwd).slice(1, -1), JSON.stringify(cwd).slice(1, -1)));
    },
  });
  t.after(() => h.dispose());
  assert.deepEqual(h.loader.getExtensions().errors, []);
  const check = (label, { onDemand = [], removalKept = true } = {}) => {
    const names = declared(h);
    assert.ok(names.includes("keep_me"), `${label}: recorded tool kept`);
    if (removalKept) assert.ok(!names.includes("drop_me"), `${label}: recorded removal kept`);
    assert.ok(names.includes("new_direct"), `${label}: Pi 1.4.0 activates an ordinary tool the branch never mentioned`);
    assert.ok(!names.includes("new_optional") && !names.includes("new_deferred"), `${label}: opt-in/deferred tools stay inactive`);
    assert.ok(!names.includes("queue_done"), `${label}: session-bus queue_done stays opt-in`);
    for (const tool of [...browserDirect, "tool_search", LOADER]) assert.ok(names.includes(tool), `${label}: ${tool} declared`);
    assert.ok(!names.includes("browser_tabs"), `${label}: deferred browser specialist tools are not declared`);
    assert.deepEqual(names.filter(n => n.startsWith("computer_use_") && n !== LOADER).sort(), [...onDemand].sort(), `${label}: physical-desktop driver tools only as loaded`);
  };
  await h.runtime.switchSession(file);
  assert.ok(h.session.getAllTools().filter(tool => tool.name.startsWith("computer_use_")).length > 50, "driver tools are registered");
  h.respond(ai => [ai.fauxAssistantMessage("resumed")]);
  await h.session.prompt("Continue after resume.");
  check("resume");
  const resumedLeaf = h.session.sessionManager.getLeafId();

  // Load the core desktop set on this branch; reload keeps it.
  h.respond(ai => [call(ai, LOADER, { group: "core" }), ai.fauxAssistantMessage("loaded")]);
  await h.session.prompt("Load the desktop tools.");
  const core = declared(h).filter(n => n.startsWith("computer_use_") && n !== LOADER);
  assert.equal(core.length, 14);
  await h.withPlatform(() => h.session.reload());
  h.respond(ai => [ai.fauxAssistantMessage("reloaded")]);
  await h.session.prompt("Continue after reload.");
  // Pi itself (1.3.0 and 1.4.0 alike, with or without these extensions) re-activates a directly registered tool that an
  // extension removed with setActiveTools when /reload re-registers it, so drop_me is not asserted here.
  check("reload", { onDemand: core, removalKept: false });

  // /tree back to the point before the load: the loaded tools belong to the other branch; the 50+ driver tools stay off.
  await h.withPlatform(() => h.session.navigateTree(resumedLeaf));
  h.respond(ai => [ai.fauxAssistantMessage("tree")]);
  await h.session.prompt("Continue on the earlier branch.");
  check("tree");
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.blockedRequests, []);
});
