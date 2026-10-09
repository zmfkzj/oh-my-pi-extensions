// Integration check of every command the bundled extensions add: loads package.json's `pi.extensions` with Pi's own resource loader
// and session, then builds the slash-command autocomplete exactly as Pi's interactive mode does (built-ins first, extension commands
// under their invocation name, built-in name conflicts skipped) and drives it through Pi's CombinedAutocompleteProvider.
// Pi itself is not a dependency of this manifest: set PI_CODING_AGENT_DIR, or the `pi` on PATH or a submodule's copy is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_NAME = "@earendil-works/pi-coding-agent";

function isPiPackage(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === PI_NAME && existsSync(join(dir, "dist/index.js")); } catch { return false; }
}
function findPi() {
  const candidates = [];
  if (process.env.PI_CODING_AGENT_DIR) candidates.push(process.env.PI_CODING_AGENT_DIR);
  try {
    let dir = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
    for (let i = 0; i < 6; i++, dir = dirname(dir)) candidates.push(dir);
  } catch { /* no pi on PATH */ }
  for (const sub of ["orche", "pi-gui", "pi-commit", "browser", "session-bus"]) candidates.push(join(root, sub, "node_modules", PI_NAME));
  const dir = candidates.find(isPiPackage);
  if (!dir) return undefined;
  const tui = [join(dir, "..", "pi-tui"), join(dir, "node_modules/@earendil-works/pi-tui")].find(path => existsSync(join(path, "dist/index.js")));
  return tui && existsSync(join(dir, "dist/core/slash-commands.js")) ? { dir, tui } : undefined;
}

const found = findPi();
const load = async () => {
  const pi = await import(pathToFileURL(join(found.dir, "dist/index.js")).href);
  const { CombinedAutocompleteProvider } = await import(pathToFileURL(join(found.tui, "dist/index.js")).href);
  const { BUILTIN_SLASH_COMMANDS } = await import(pathToFileURL(join(found.dir, "dist/core/slash-commands.js")).href);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-command-completions-"));
  const agentDir = join(cwd, "agent");
  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new pi.DefaultResourceLoader({
    cwd, agentDir, settingsManager, additionalExtensionPaths: manifest.pi.extensions.map(path => resolve(root, path)),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, sessionManager: pi.SessionManager.inMemory(cwd) });
  const builtins = new Set(BUILTIN_SLASH_COMMANDS.map(command => command.name));
  const registered = session.extensionRunner.getRegisteredCommands();
  const commands = [
    ...BUILTIN_SLASH_COMMANDS.map(command => ({ name: command.name, description: command.description })),
    ...registered.filter(command => !builtins.has(command.name))
      .map(command => ({ name: command.invocationName, description: command.description, getArgumentCompletions: command.getArgumentCompletions })),
  ];
  const provider = new CombinedAutocompleteProvider(commands, cwd);
  const suggest = async (line) => provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
  const complete = async (line, value) => {
    const suggestions = await suggest(line);
    assert.ok(suggestions, `no suggestions for ${JSON.stringify(line)}`);
    const item = suggestions.items.find(candidate => candidate.value === value);
    assert.ok(item, `${JSON.stringify(line)} offers ${JSON.stringify(suggestions.items.map(candidate => candidate.value))}, not ${JSON.stringify(value)}`);
    return provider.applyCompletion([line], 0, line.length, item, suggestions.prefix).lines[0];
  };
  const dispose = () => { session.dispose(); rmSync(cwd, { recursive: true, force: true }); };
  return { loader, registered, builtins, commands, suggest, complete, dispose };
};

test("bundled extension commands are listed and complete in Pi's slash-command autocomplete", { skip: found ? false : "Pi (@earendil-works/pi-coding-agent with pi-tui) not found; set PI_CODING_AGENT_DIR", timeout: 120_000 }, async (t) => {
  const prev = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const h = await load();
  t.after(() => { h.dispose(); if (prev === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = prev; });

  assert.deepEqual(h.loader.getExtensions().errors, []);
  const byExtension = Object.fromEntries(h.loader.getExtensions().extensions.map(extension => [extension.path.slice(root.length + 1), [...extension.commands.keys()].sort()]));
  assert.deepEqual(byExtension["browser/src/extension/index.ts"], ["browser"]);
  assert.deepEqual(byExtension["orche/src/extension/index.ts"], ["orche"]);
  assert.deepEqual(byExtension["pi-gui/src/index.ts"], ["gui"]);
  assert.deepEqual(byExtension["pi-commit/src/index.ts"], ["commit"]);
  assert.deepEqual(byExtension["session-bus/src/index.ts"], ["bus", "queue"]);
  assert.deepEqual(byExtension["images/src/index.ts"], [], "the command-less images extension stays command-less");

  // Names: no built-in conflict, no renamed duplicate, every one in the `/` menu exactly once next to the built-ins.
  for (const command of h.registered) {
    assert.ok(!h.builtins.has(command.name), `/${command.name} conflicts with a built-in`);
    assert.equal(command.invocationName, command.name, `/${command.name} is registered more than once`);
  }
  const names = h.commands.map(command => command.name);
  assert.equal(new Set(names).size, names.length);
  const menu = (await h.suggest("/")).items.map(item => item.value);
  for (const name of ["model", "settings", "reload", ...h.registered.map(command => command.name)]) assert.equal(menu.filter(value => value === name).length, 1, `/${name} in the / menu`);
  assert.equal(await h.complete("/bro", "browser"), "/browser ");
  assert.equal(await h.complete("/orc", "orche"), "/orche ");
  assert.equal(await h.complete("/comm", "commit"), "/commit ");
  assert.equal(await h.complete("/que", "queue"), "/queue ");

  // Arguments: the chosen value replaces everything after the command, nested choices included.
  for (const name of ["browser", "orche", "commit", "bus", "queue", "gui"]) {
    assert.equal(typeof h.registered.find(command => command.name === name)?.getArgumentCompletions, "function", `/${name} completes arguments`);
  }
  assert.equal(await h.complete("/browser engine c", "engine chrome"), "/browser engine chrome");
  assert.equal(await h.complete("/browser allow", "allow-private-network off"), "/browser allow-private-network off");
  assert.equal(await h.complete("/orche mode d", "mode direct"), "/orche mode direct");
  assert.equal(await h.complete("/orche sin", "single "), "/orche single ");
  assert.equal(await h.complete("/commit --dry-run --h", "--dry-run --help"), "/commit --dry-run --help");
  assert.equal(await h.complete("/bus wake of", "wake off"), "/bus wake off");
  assert.equal(await h.complete("/queue d", "done"), "/queue done");
  assert.equal(await h.complete("/gui view s", "view stop"), "/gui view stop", "the existing /gui completions are kept");

  // Free text, unknown words and finished arguments get no suggestions, so Enter submits them.
  for (const line of ["/orche single fix the s", "/queue fix the lint", "/bus send peer hello", "/browser xyz", "/commit --model op", "/orche workers"]) {
    assert.equal(await h.suggest(line), null, line);
  }
});
