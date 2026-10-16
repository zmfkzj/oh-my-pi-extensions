// Real host lifecycle + actual browser entrypoint. Model is faux; no browser engine/network is started.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findPi, manifestExtensions, startPiSession } from "./pi-harness.mjs";

const found = findPi();
const entry = manifestExtensions(path => path.startsWith("./browser/"));
const direct = ["browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_type", "browser_wait", "browser_screenshot", "browser_evaluate", "browser_fetch"].sort();
const names = h => h.requests.at(-1).tools.map(tool => tool.name);
const browsers = h => names(h).filter(name => name.startsWith("browser_")).sort();
const tool = (ai, name, args) => ai.fauxAssistantMessage(ai.fauxToolCall(name, args), { stopReason: "toolUse" });
const other = pi => pi.on("session_start", () => pi.registerTool({
  name: "other_lookup", label: "Other", description: "A late deferred extension tool", exposure: "deferred",
  parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
}));
async function open(t, options = {}) {
  const h = await startPiSession(found, {
    extensionPaths: entry, extensionFactories: [other], persistent: true,
    setup: ({ agentDir }) => writeFileSync(join(agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath })),
    ...options,
  });
  t.after(() => h.dispose());
  return h;
}
async function capture(h) { h.respond(ai => [ai.fauxAssistantMessage("ok")]); await h.session.prompt("Show the current declarations."); }

test("browser: fresh -> search -> persisted resume -> reload -> native new session; other late tools survive", async t => {
  const h = await open(t);
  await capture(h);
  assert.deepEqual(browsers(h), direct);
  h.respond(ai => [tool(ai, "tool_search", { query: "browser_tabs", limit: 1 }), tool(ai, "tool_search", { query: "other_lookup", limit: 1 }), ai.fauxAssistantMessage("loaded")]);
  await h.session.prompt("Load the tabs and lookup tools.");
  const expected = [...direct, "browser_tabs"].sort();
  assert.deepEqual(browsers(h), expected);
  assert.ok(names(h).includes("other_lookup"));
  const file = h.session.sessionFile;
  await h.runtime.newSession();
  await capture(h);
  assert.deepEqual(browsers(h), direct);
  assert.ok(!names(h).includes("other_lookup"));
  await h.runtime.switchSession(file);
  await capture(h);
  assert.deepEqual(browsers(h), expected);
  assert.ok(names(h).includes("other_lookup"));
  await h.session.reload();
  await capture(h);
  assert.deepEqual(browsers(h), expected);
  assert.ok(names(h).includes("other_lookup"));
  await h.runtime.newSession();
  await capture(h);
  assert.deepEqual(browsers(h), direct);
  assert.ok(!names(h).includes("other_lookup"));
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.blockedRequests, []);
});

for (const [label, sessionOptions, settings, expected] of [
  ["--no-tools (SDK noTools: all)", { noTools: "all" }, {}, []],
  ["explicit allowlist", { tools: ["read"] }, {}, ["read"]],
  ["CLI exclusions", { excludeTools: ["browser_*", "tool_search"] }, {}, ["read", "bash", "edit", "write"]],
  ["CLI default modifiers", { tools: ["-browser_navigate", "-tool_search"] }, {}, undefined],
  ["configured built-in defaults (not an extension allowlist)", {}, { defaultTools: ["read"] }, ["read", ...direct, "tool_search"]],
  ["configured negative defaults", {}, { defaultTools: ["-browser_navigate", "-tool_search"] }, undefined],
]) {
  test(`browser: initialization/reload honours ${label}`, async t => {
    // Present the same CLI modifiers to the extension as to the host's SDK options. Full CLI process coverage below
    // separately verifies the actual argument-to-session wiring.
    const argv = process.argv;
    if (label === "CLI default modifiers") process.argv = [argv[0], argv[1], "--tools", "-browser_navigate,-tool_search"];
    t.after(() => { process.argv = argv; });
    const h = await open(t, { sessionOptions, settings });
    for (const reload of [false, true]) {
      if (reload) await h.session.reload();
      await capture(h);
      if (expected) assert.deepEqual(names(h).sort(), expected.sort());
      else {
        assert.ok(!names(h).includes("browser_navigate"));
        assert.ok(!names(h).includes("tool_search"));
        assert.ok(names(h).includes("browser_snapshot"));
      }
    }
  });
}

for (const flags of [["--no-tools"], ["--tools", "read"], ["--tools", "-browser_navigate,-tool_search"], []]) {
  test(`browser real CLI declarations: ${flags.join(" ") || "settings.json negative defaults"}`, { timeout: 60_000 }, t => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-browser-cli-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const agentDir = join(cwd, "agent"), capture = join(cwd, "declared.json"), fixture = join(cwd, "faux.js");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath }));
    if (!flags.length) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["-browser_navigate", "-tool_search"] }));
    writeFileSync(fixture, `import { writeFileSync } from 'node:fs';
import { fauxProvider, fauxAssistantMessage, getCurrentTools } from '@earendil-works/pi-ai';
export default function(pi) {
  const faux = fauxProvider({provider: 'browser-cli-test', models: [{id: 'test'}]});
  faux.setResponses([context => { writeFileSync(process.env.OMP_CAPTURE, JSON.stringify(getCurrentTools(context.messages).map(t => t.name))); return fauxAssistantMessage('ok'); }]);
  pi.registerProvider(faux.provider);
}`);
    const result = spawnSync(process.execPath, [join(found.dir, "dist/cli.js"), "--offline", "--no-extensions", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files", "--no-session", "-e", entry[0], "-e", fixture,
      "--provider", "browser-cli-test", "--model", "test", "--print", ...flags, "Say ok"], {
      cwd, timeout: 45_000, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: tmpdir(),
        PI_CODING_AGENT_DIR: agentDir, PI_AGENT_HOME: agentDir, PI_OFFLINE: "1", OMP_CAPTURE: capture, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    const declared = JSON.parse(readFileSync(capture, "utf8"));
    if (flags[0] === "--no-tools") assert.deepEqual(declared, []);
    else if (flags[1] === "read") assert.deepEqual(declared, ["read"]);
    else {
      assert.ok(!declared.includes("browser_navigate"));
      assert.ok(!declared.includes("tool_search"));
      assert.ok(declared.includes("browser_snapshot"));
    }
  });
}
