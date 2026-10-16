// Pi-level check of the dependency commands: the root manifest's extensions loaded through Pi's own resource loader
// (temporary agent dir, faux model; see pi-harness.mjs). Every bundled package must answer the umbrella's request with
// its provider, and `/oh-my-pi doctor` plus each package's own `doctor` must report through Pi's command path. The
// checks inspect this machine read-only, so their statuses are not asserted; install-deps is not run here (it would
// install for real; its behaviour is covered with fakes in scripts/dependencies.test.mjs and each package's tests).
import assert from "node:assert/strict";
import test from "node:test";
import { collectProviders, PACKAGES } from "../extensions/dependencies/umbrella.js";
import { findPi, manifestExtensions, startPiSession } from "./pi-harness.mjs";

const found = findPi();
const STATUS = /^ {2}\[(ok|installed|warn|error|failed|manual|unverified)\] /;

test("every bundled package answers the umbrella, and /oh-my-pi doctor and each package's doctor report through Pi", { timeout: 600_000 }, async (t) => {
  const h = await startPiSession(found, { extensionPaths: manifestExtensions(() => true) });
  t.after(() => h.dispose());
  assert.deepEqual(h.loader.getExtensions().errors, []);

  // The providers, through Pi's shared event bus (the dependencies extension's own `pi.events`).
  const dependencies = h.loader.getExtensions().extensions.find(extension => extension.path.endsWith("extensions/dependencies/index.js"));
  assert.ok(dependencies, "the dependencies extension is loaded");
  // Pi's loader passes one event bus to every extension (DefaultResourceLoader.eventBus).
  const { providers, duplicates } = collectProviders(h.loader.eventBus);
  assert.deepEqual([...providers.keys()].sort(), PACKAGES.map(pkg => pkg.id).sort(), "all ten packages answer");
  for (const pkg of PACKAGES) {
    assert.equal(providers.get(pkg.id).label, pkg.label, pkg.id);
    assert.equal(providers.get(pkg.id).command, pkg.command, pkg.id);
  }
  assert.equal(duplicates.size, 0);

  // The batch command: one section per package, none "not loaded", each item with a status and abnormal ones with an action.
  await h.session.prompt("/oh-my-pi doctor");
  const batch = h.notifications.at(-1);
  assert.match(batch.message, /^\/oh-my-pi doctor: 10 packages: /);
  assert.doesNotMatch(batch.message.split("\n")[0], /not loaded/, batch.message);
  for (const pkg of PACKAGES) assert.match(batch.message, new RegExp(`^\\[${pkg.id}\\] ${pkg.label}: `, "m"), pkg.id);
  const lines = batch.message.split("\n");
  lines.forEach((line, index) => {
    const status = STATUS.exec(line)?.[1];
    if (["warn", "error", "failed", "manual"].includes(status)) assert.match(lines[index + 1] ?? "", /^ {6}-> \S/, `action for: ${line}`);
  });
  assert.doesNotMatch(batch.message, /\[(installed|failed)\]/, "doctor installs nothing");

  // Each package's own doctor subcommand, through Pi.
  for (const pkg of PACKAGES) {
    const before = h.notifications.length;
    const entriesBefore = h.session.sessionManager.getEntries().length;
    await h.session.prompt(`${pkg.command} doctor`);
    // Workbench's TUI output is a renderable transcript entry, not a notification.
    const records = h.session.sessionManager.getEntries().slice(entriesBefore)
      .filter(entry => entry.type === "custom" && entry.customType === "pi-workbench.command-output").map(entry => entry.data.text);
    const own = [...h.notifications.slice(before).map(notification => notification.message), ...records].join("\n");
    assert.match(own, new RegExp(`${pkg.label} doctor: `), `${pkg.command} doctor: ${own.slice(0, 300)}`);
  }
});
