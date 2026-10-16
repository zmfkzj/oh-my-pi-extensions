import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findPi, manifestExtensions, root, startPiSession } from "./pi-harness.mjs";

const found = findPi();
const fixture = join(root, "scripts/fixtures/stdio-mcp.mjs");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const entries = path => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const call = (ai, name, args = {}) => ai.fauxAssistantMessage(ai.fauxToolCall(name, args), { stopReason: "toolUse" });
async function exited(pids) {
  const deadline = Date.now() + 6000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(pids.every(pid => !alive(pid)), `orphan MCP processes: ${pids.filter(alive)}`);
}
function cleanup(t, getLog) {
  // Emergency cleanup is last; assertions in the test run before it and cannot be hidden by killing leaked processes.
  t.after(() => { for (const { event, pid } of entries(getLog())) if (event === "spawn" && alive(pid)) process.kill(pid, "SIGKILL"); });
}

test("combined GUI/CodeGraph worker factories share one MCP owner; reload/new/shutdown stop every child", { timeout: 60_000 }, async t => {
  const paths = [];
  let log;
  cleanup(t, () => log);
  const h = await startPiSession(found, {
    extensionPaths: paths, nativeExtensions: false, persistent: true,
    setup({ cwd, agentDir }) {
      log = join(cwd, "connections.jsonl");
      const script = join(cwd, "worker-capabilities.ts");
      const server = name => ({ command: process.execPath, args: [fixture, log, name], exposure: "direct" });
      writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { codegraph: { ...server("codegraph"), exposure: "deferred" },
        forbidden_user_server: { command: "/must-not-start-user-server" } } }));
      writeFileSync(script, `import { guiSessionExtension, workerMcpExtension } from ${JSON.stringify(join(root, "pi-gui/src/worker.ts"))};
import { answerWorkerCapability } from ${JSON.stringify(join(root, "codegraph/src/worker.ts"))};
export default async function(pi) {
  let answer;
  answerWorkerCapability({capability:'codegraph', cwd:${JSON.stringify(cwd)}, provide: value => answer=value}, {agentDir:${JSON.stringify(agentDir)}, env:{PI_CODEGRAPH_MCP:'always'}});
  if (!answer || answer.error) throw new Error(JSON.stringify(answer));
  if (answer.extensionFactories[0] !== workerMcpExtension()) throw new Error('duplicate worker MCP factory');
  const gui = guiSessionExtension({server:${JSON.stringify(server("computer_use"))}, policy:{allowPhysicalDesktop:false, readOnlyRole:'answer'}, log:{write(){}}, label:'fixture'});
  for (const factory of new Set([workerMcpExtension(), gui, ...answer.extensionFactories])) await factory(pi);
}`);
      paths.push(script);
    },
  });
  t.after(() => h.dispose());
  for (const transition of ["startup", "reload", "new"]) {
    const before = entries(log).filter(e => e.event === "spawn").map(e => e.pid);
    if (transition === "reload") await h.session.reload();
    if (transition === "new") await h.runtime.newSession();
    if (transition !== "startup") await exited(before);
    h.respond(ai => [call(ai, "mcp__computer_use__list_desktop", { scope: "windows" }), call(ai, "mcp__codegraph__codegraph_explore", { query: "local" }),
      call(ai, "mcp__computer_use__act", {}), ai.fauxAssistantMessage("done")]);
    await h.session.prompt("Use both worker capabilities, then attempt forbidden act.");
    const errors = h.session.messages.filter(m => m.role === "toolResult" && m.isError);
    assert.match(JSON.stringify(errors.at(-1)), /read-only/);
    assert.ok(!entries(log).some(e => e.event === "call:act"), "read-only GUI policy blocks before stdio");
    const active = entries(log).filter(e => e.event === "spawn" && alive(e.pid));
    assert.deepEqual(active.map(e => e.server).sort(), ["codegraph", "computer_use"]);
    for (const child of active) assert.equal(entries(log).filter(e => e.event === "initialize" && e.pid === child.pid).length, 1);
    assert.equal(h.session.getAllTools().filter(tool => tool.name === "mcp__codegraph__codegraph_explore").length, 1);
    assert.ok(!h.session.getAllTools().some(tool => tool.name.includes("forbidden_user_server")));
  }
  const pids = entries(log).filter(e => e.event === "spawn").map(e => e.pid);
  assert.equal(pids.length, 6, "exactly two server processes per lifecycle");
  assert.deepEqual(h.errors, []);
  await h.dispose();
  await exited(pids);
});

test("browser/physical-desktop/codegraph with real MCP: deferred restored tool survives late reconnect", { timeout: 60_000 }, async t => {
  let log;
  cleanup(t, () => log);
  const h = await startPiSession(found, {
    persistent: true, platform: "darwin",
    extensionPaths: manifestExtensions(path => path.startsWith("./browser/") || path.includes("computer-use") || path.startsWith("./codegraph/")),
    settings: { "pi-computer-use": { mode: "path", binaryPath: "/nonexistent/cua-driver" } },
    setup({ cwd, agentDir }) {
      log = join(cwd, "connections.jsonl");
      writeFileSync(join(agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath }));
      writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { codegraph: {
        command: process.execPath, args: [fixture, log, "codegraph", "100"], exposure: "deferred",
      } } }));
    },
  });
  t.after(() => h.dispose());
  h.respond(ai => [call(ai, "tool_search", { query: "mcp__codegraph__codegraph_explore", limit: 1 }),
    call(ai, "computer_use_tools", { group: "core" }), call(ai, "tool_search", { query: "browser_tabs", limit: 1 }), ai.fauxAssistantMessage("loaded")]);
  await h.session.prompt("Load tools.");
  const file = h.session.sessionFile;
  const expected = ["mcp__codegraph__codegraph_explore", "computer_use_list_apps", "browser_tabs"];
  for (const transition of ["reload", "resume"]) {
    const before = entries(log).filter(e => e.event === "spawn").map(e => e.pid);
    if (transition === "reload") await h.withPlatform(() => h.session.reload());
    else { await h.runtime.newSession(); await h.runtime.switchSession(file); }
    await exited(before);
    // A deferred MCP connection is asynchronous. Wait for registration without changing the active set ourselves.
    const deadline = Date.now() + 5000;
    while (!h.session.getAllTools().some(t => t.name === expected[0]) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    h.respond(ai => [ai.fauxAssistantMessage("restored")]);
    await h.session.prompt("Continue.");
    const names = h.requests.at(-1).tools.map(t => t.name);
    for (const name of expected) assert.ok(names.includes(name), `${transition} lost ${name}`);
    assert.equal(entries(log).filter(e => e.event === "spawn" && alive(e.pid)).length, 1);
  }
  const pids = entries(log).filter(e => e.event === "spawn").map(e => e.pid);
  assert.deepEqual(h.errors, []);
  await h.dispose();
  await exited(pids);
});
