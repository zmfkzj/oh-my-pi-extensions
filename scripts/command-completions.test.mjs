// Integration check of every command the bundled extensions add: loads package.json's `pi.extensions` with Pi's own resource loader
// and session, then builds the slash-command autocomplete exactly as Pi's interactive mode does (built-ins first, extension commands
// under their invocation name, built-in name conflicts skipped) and drives it through Pi's CombinedAutocompleteProvider.
// The shared harness requires an exact SDK version, isolated credentials and fail-closed initialization cleanup.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPi, manifestExtensions, root, startPiSession } from "./pi-harness.mjs";

const found = findPi();
const load = async () => {
  assert.ok(found.tui, "mandatory Pi autocomplete validation requires pi-tui");
  const { CombinedAutocompleteProvider } = await import(pathToFileURL(join(found.tui, "dist/index.js")).href);
  const { BUILTIN_SLASH_COMMANDS } = await import(pathToFileURL(join(found.dir, "dist/core/slash-commands.js")).href);
  const h = await startPiSession(found, { extensionPaths: manifestExtensions(() => true), bind: false });
  const { session, loader, cwd } = h;
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
  return { loader, registered, builtins, commands, provider, cwd, suggest, complete, dispose: h.dispose };
};

test("bundled extension commands are listed and complete in Pi's slash-command autocomplete", { timeout: 120_000 }, async (t) => {
  const h = await load();
  t.after(() => h.dispose());

  assert.deepEqual(h.loader.getExtensions().errors, []);
  const byExtension = Object.fromEntries(h.loader.getExtensions().extensions.map(extension => [extension.path.slice(root.length + 1), [...extension.commands.keys()].sort()]));
  assert.deepEqual(byExtension["browser/src/extension/index.ts"], ["browser"]);
  assert.deepEqual(byExtension["orche/src/extension/index.ts"], ["orche"]);
  assert.deepEqual(byExtension["pi-gui/src/index.ts"], ["gui"]);
  assert.deepEqual(byExtension["pi-commit/src/index.ts"], ["commit"]);
  assert.deepEqual(byExtension["session-bus/src/index.ts"], ["bus", "queue"]);
  assert.deepEqual(byExtension["images/src/index.ts"], ["images"], "images: its dependency doctor/install-deps command");
  assert.deepEqual(byExtension["pi-workbench/index.js"], ["workbench"]);
  assert.deepEqual(byExtension["codegraph/src/index.ts"], ["codegraph"]);
  // The official CLIProxyAPI provider, loaded through the bundle (no separate install in this agent dir).
  assert.deepEqual(byExtension["cliproxyapi/src/index.ts"], ["cliproxyapi", "cliproxyapi-refresh", "continue", "fast", "pause"]);
  // The umbrella's dependency commands: the batch /oh-my-pi and the physical-desktop package's /computer-use.
  assert.deepEqual(byExtension["extensions/dependencies/index.js"], ["computer-use", "oh-my-pi"]);

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
  assert.equal(await h.complete("/wor", "workbench"), "/workbench ");
  assert.equal(await h.complete("/codeg", "codegraph"), "/codegraph ");
  assert.equal(await h.complete("/cliproxyapi-r", "cliproxyapi-refresh"), "/cliproxyapi-refresh ");
  assert.equal(await h.complete("/oh-", "oh-my-pi"), "/oh-my-pi ");

  // Arguments: the chosen value replaces everything after the command, nested choices included.
  for (const name of ["browser", "orche", "commit", "bus", "queue", "gui", "workbench", "codegraph", "images", "cliproxyapi", "computer-use", "oh-my-pi"]) {
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
  assert.equal(await h.complete("/workbench u", "use "), "/workbench use ");
  assert.equal(await h.complete("/workbench use co", "use coding"), "/workbench use coding");
  assert.equal(await h.complete("/workbench use ", "use off"), "/workbench use off");
  assert.equal(await h.complete("/workbench list ga", "list game"), "/workbench list game");
  assert.equal(await h.complete("/workbench skill ponytail-r", "skill ponytail-review"), "/workbench skill ponytail-review");
  assert.equal(await h.complete("/codegraph sy", "sync"), "/codegraph sync");
  assert.equal(await h.complete("/codegraph i", "init"), "/codegraph init");
  // Every package's dependency subcommands, and the umbrella's batch commands with package ids.
  for (const command of ["browser", "orche", "commit", "bus", "gui", "workbench", "codegraph", "images", "cliproxyapi", "computer-use"]) {
    assert.equal(await h.complete(`/${command} doc`, "doctor"), `/${command} doctor`, `/${command} doctor`);
    assert.equal(await h.complete(`/${command} install-d`, "install-deps"), `/${command} install-deps`, `/${command} install-deps`);
  }
  assert.equal(await h.complete("/oh-my-pi d", "doctor"), "/oh-my-pi doctor");
  assert.equal(await h.complete("/oh-my-pi install-deps br", "install-deps browser"), "/oh-my-pi install-deps browser");

  // Free text, unknown words and finished arguments get no suggestions, so Enter submits them.
  for (const line of ["/orche single fix the s", "/queue fix the lint", "/bus send peer hello", "/browser xyz", "/commit --model op", "/orche workers",
    "/workbench use coding", "/workbench use coding ", "/workbench status x", "/workbench skill coding", "/workbench list auto", "/workbench xyz",
    "/codegraph sync", "/codegraph xyz"]) {
    assert.equal(await h.suggest(line), null, line);
  }
});

test("Tab with no candidate list open completes /workbench arguments through the wrapper Workbench registers, and leaves the rest to Pi", { timeout: 120_000 }, async (t) => {
  const h = await load();
  t.after(() => h.dispose());
  writeFileSync(join(h.cwd, "alpha.txt"), "a\n");

  // The factory the loaded Workbench extension registers from its session_start handler through ctx.ui.addAutocompleteProvider;
  // Pi's interactive mode applies such factories over its own provider (pi-workbench/tests/pi-editor.mjs drives that path through
  // bindExtensions and Pi's Editor). Only Workbench's handler runs here: the other extensions' session starts are not needed.
  const workbench = h.loader.getExtensions().extensions.find(extension => extension.path.endsWith("pi-workbench/index.js"));
  const wrappers = [];
  for (const handler of [workbench.handlers.get("session_start") ?? []].flat()) {
    await handler({ type: "session_start", reason: "startup" }, { ui: { addAutocompleteProvider: factory => wrappers.push(factory) } });
  }
  assert.equal(wrappers.length, 1, "Workbench registers one autocomplete wrapper");
  const wrapped = wrappers.reduce((provider, wrap) => wrap(provider), h.provider);
  const signal = new AbortController().signal;
  const forced = async (provider, line) => (await provider.getSuggestions([line], 0, line.length, { signal, force: true }))?.items.map(item => item.value) ?? null;
  const catalog = JSON.parse(readFileSync(join(root, "pi-workbench", "catalog.json"), "utf8"));

  // Pi's own provider: its file gate declines `/workbench ` (a command and a space), and a forced Tab lists files after `use `.
  assert.equal(h.provider.shouldTriggerFileCompletion(["/workbench "], 0, 11), false);
  assert.ok((await forced(h.provider, "/workbench use "))?.includes("alpha.txt"), "without the wrapper: the project's files");
  // With the wrapper: Workbench candidates at each argument position, never files.
  assert.equal(wrapped.shouldTriggerFileCompletion(["/workbench "], 0, 11), true);
  assert.deepEqual(await forced(wrapped, "/workbench "), ["list", "use ", "skill ", "cancel", "status", "doctor", "install-deps", "help"]);
  assert.deepEqual(await forced(wrapped, "/workbench use "), [...catalog.profiles.map(profile => `use ${profile.id}`), "use auto", "use off"]);
  assert.deepEqual(await forced(wrapped, "/workbench skill "), catalog.skills.map(skill => `skill ${skill.id}`));
  assert.deepEqual(await forced(wrapped, "/workbench list "), catalog.profiles.map(profile => `list ${profile.id}`));
  assert.deepEqual(await forced(wrapped, "/workbench skill ponytail"), ["skill ponytail", "skill ponytail-review"], "an exact id next to a longer one");
  for (const line of ["/workbench use coding ", "/workbench xyz ", "/workbench status ", "/workbench cancel "]) assert.equal(await forced(wrapped, line), null, line);
  const choice = (await wrapped.getSuggestions(["/workbench use "], 0, 15, { signal, force: true })).items.find(item => item.value === "use coding");
  assert.equal(wrapped.applyCompletion(["/workbench use "], 0, 15, choice, "use ").lines[0], "/workbench use coding");
  // Everything else stays Pi's: forced Tab after other commands and in plain text (file paths), and completion while typing.
  for (const line of ["/orche ", "/browser engine ", "look at ./al"]) {
    assert.equal(wrapped.shouldTriggerFileCompletion([line], 0, line.length), h.provider.shouldTriggerFileCompletion([line], 0, line.length), line);
    assert.deepEqual(await forced(wrapped, line), await forced(h.provider, line), line);
  }
  assert.ok((await forced(wrapped, "look at ./al"))?.some(value => value.endsWith("alpha.txt")), "file completion in plain text");
  for (const line of ["/workbench use co", "/orche mode d", "/wor", "/"]) {
    assert.deepEqual(await wrapped.getSuggestions([line], 0, line.length, { signal }), await h.suggest(line), line);
  }
});
