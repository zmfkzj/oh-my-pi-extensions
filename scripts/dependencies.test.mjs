// Unit checks of the umbrella's dependency commands (extensions/dependencies/): `/oh-my-pi doctor|install-deps` over
// fake package providers and fixture checkouts, and the computer-use provider over a fixture node_modules. Nothing is
// installed or downloaded: npm and the driver are fake runners.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEPENDENCY_CHANNEL, registerDependencyProvider } from "../extensions/dependencies/contract.js";
import { createComputerUseProvider, driverTarget, registerComputerUseCommand } from "../extensions/dependencies/computer-use.js";
import { createDependencyExtension } from "../extensions/dependencies/index.js";
import {
  collectProviders, completeUmbrellaArgs, formatAggregate, PACKAGES, parseUmbrellaArgs, registerUmbrellaCommand, runPackages,
} from "../extensions/dependencies/umbrella.js";
import { readFileSync } from "node:fs";
import { root as repoRoot } from "./pi-harness.mjs";

// Pi's event bus (dist/core/event-bus.js): handlers run synchronously inside emit.
function eventBus() {
  const emitter = new EventEmitter();
  return { emit: (channel, data) => emitter.emit(channel, data), on: (channel, handler) => { emitter.on(channel, handler); return () => emitter.off(channel, handler); } };
}
function fakePi() {
  const commands = new Map();
  return { events: eventBus(), commands, registerCommand: (name, options) => commands.set(name, options) };
}
function fakeCtx() {
  const notifications = [];
  const statuses = [];
  return { notifications, statuses, ctx: { cwd: "/tmp", hasUI: true, isProjectTrusted: () => false, ui: { notify: (message, level) => notifications.push({ message, level }), setStatus: (key, text) => statuses.push([key, text]) } } };
}
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const provider = (id, check, install = check) => ({ id, label: `pkg-${id}`, command: `/${id}`, check: check ?? install, install });
const report = (...items) => ({ items });

test("the package table is the root manifest's extensions, the dependencies entry aside", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(PACKAGES.map(pkg => pkg.entry), manifest.pi.extensions.filter(path => path !== "./extensions/dependencies/index.js"));
  assert.ok(manifest.pi.extensions.includes("./extensions/dependencies/index.js"));
  assert.equal(new Set(PACKAGES.map(pkg => pkg.id)).size, 10);
});

test("collectProviders takes synchronous answers, keeps the first of an id and counts duplicates", () => {
  const events = eventBus();
  const a = provider("orche", async () => report());
  registerDependencyProvider(events, a);
  registerDependencyProvider(events, provider("orche", async () => report()));
  registerDependencyProvider(events, provider("browser", async () => report()));
  events.on(DEPENDENCY_CHANNEL, (data) => data.provide({ id: "broken" })); // not a provider: ignored
  const { providers, duplicates } = collectProviders(events);
  assert.deepEqual([...providers.keys()], ["orche", "browser"]);
  assert.equal(providers.get("orche"), a);
  assert.equal(duplicates.get("orche"), 1);
});

test("doctor: healthy, abnormal, no-dependency, throwing, timed-out, invalid and absent packages are each reported; one never hides another", async (t) => {
  const root = tempDir(t, "omp-deps-root-");
  // Absent packages: one without files, one with missing npm dependencies, one complete but silent.
  mkdirSync(join(root, "nodeps-missing"), { recursive: true });
  writeFileSync(join(root, "nodeps-missing", "package.json"), JSON.stringify({ dependencies: { "left-pad": "1" } }));
  mkdirSync(join(root, "silent"), { recursive: true });
  writeFileSync(join(root, "silent", "package.json"), JSON.stringify({}));
  const packages = [
    { id: "ok", label: "pkg-ok", command: "/ok", entry: "./ok/index.ts", dir: "ok" },
    { id: "bad", label: "pkg-bad", command: "/bad", entry: "./bad/index.ts", dir: "bad" },
    { id: "none", label: "pkg-none", command: "/none", entry: "./none/index.ts", dir: "none" },
    { id: "throws", label: "pkg-throws", command: "/throws", entry: "./throws/index.ts", dir: "throws" },
    { id: "slow", label: "pkg-slow", command: "/slow", entry: "./slow/index.ts", dir: "slow" },
    { id: "invalid", label: "pkg-invalid", command: "/invalid", entry: "./invalid/index.ts", dir: "invalid" },
    { id: "nofiles", label: "pkg-nofiles", command: "/nofiles", entry: "./nofiles/index.ts", dir: "nofiles" },
    { id: "nodeps", label: "pkg-nodeps", command: "/nodeps", entry: "./nodeps-missing/index.ts", dir: "nodeps-missing" },
    { id: "silent", label: "pkg-silent", command: "/silent", entry: "./silent/index.ts", dir: "silent" },
    { id: "late", label: "pkg-late", command: "/late", entry: "./late/index.ts", dir: "late" },
  ];
  let installs = 0;
  const installer = async () => { installs++; return report({ name: "x", status: "installed" }); };
  const providers = new Map([
    ["ok", provider("ok", async () => report({ name: "tool", status: "ok", detail: "v1" }), installer)],
    ["bad", provider("bad", async () => report({ name: "tool", status: "error", detail: "missing", action: "install tool" }, { name: "chrome", status: "warn", optional: true, action: "install chrome" }), installer)],
    ["none", provider("none", async () => ({ items: [], note: "No external dependencies: needs only Pi and Node.js." }), installer)],
    ["throws", provider("throws", async () => { throw new Error("boom"); }, installer)],
    ["slow", provider("slow", () => new Promise(() => {}), installer)],
    ["invalid", provider("invalid", async () => ({ nope: true }), installer)],
    ["late", provider("late", async () => report({ name: "server", status: "unverified", action: "curl it" }), installer)],
  ]);
  const installNpm = async () => { installs++; return []; };
  const results = await runPackages("check", {}, { providers, root, packages, timeoutMs: 200, installNpm });
  assert.equal(installs, 0, "doctor never installs");
  assert.deepEqual(results.map(result => result.pkg.id), packages.map(pkg => pkg.id), "every package, in order");
  const byId = Object.fromEntries(results.map(result => [result.pkg.id, result]));
  assert.equal(byId.throws.report.items[0].status, "error");
  assert.match(byId.throws.report.items[0].detail, /boom/);
  assert.match(byId.throws.report.items[0].action, /\/throws doctor/);
  assert.match(byId.slow.report.items[0].detail, /timed out/);
  assert.match(byId.invalid.report.items[0].detail, /invalid report/);
  assert.equal(byId.nofiles.state, "not loaded");
  assert.match(byId.nofiles.report.items[0].action, /git submodule update --init nofiles/);
  assert.match(byId.nodeps.report.items[0].detail, /missing left-pad/);
  assert.match(byId.nodeps.report.items[0].action, /\/oh-my-pi install-deps nodeps/);
  assert.match(byId.silent.report.items[0].action, /startup output/);

  const { text, level } = formatAggregate(results, "check");
  assert.equal(level, "error");
  assert.match(text, /^\/oh-my-pi doctor: 10 packages: 1 healthy, 1 no external dependencies, 4 abnormal, 1 unverified, 3 not loaded$/m);
  assert.match(text, /^\[ok\] pkg-ok: healthy {2}\(\/ok doctor\)$/m);
  assert.match(text, /^\[bad\] pkg-bad: abnormal/m);
  assert.match(text, /^ {2}\[error\] tool: missing\n {6}-> install tool$/m);
  assert.match(text, /^ {2}\[warn\] chrome \(optional\)\n {6}-> install chrome$/m);
  assert.match(text, /^\[none\] pkg-none: no external dependencies[^\n]*\n {2}No external dependencies: needs only Pi and Node\.js\.$/m);
  assert.match(text, /^\[late\] pkg-late: unverified/m, "a later package still reports after a throw and a timeout");
  assert.match(text, /Needs attention: bad \(abnormal\), throws \(abnormal\), slow \(abnormal\), invalid \(abnormal\), nofiles \(not loaded\), nodeps \(not loaded\), silent \(not loaded\), late \(unverified\)\./);
});

test("install-deps: runs packages one at a time, installs an absent package's npm dependencies, and reports partial failure next to successes", async (t) => {
  const root = tempDir(t, "omp-deps-install-");
  mkdirSync(join(root, "absent"), { recursive: true });
  writeFileSync(join(root, "absent", "package.json"), JSON.stringify({ dependencies: { "left-pad": "1" } }));
  const order = [];
  let active = 0;
  const step = (id, items) => async () => { order.push(`start ${id}`); assert.equal(active++, 0, "sequential"); await new Promise(resolve => setTimeout(resolve, 5)); active--; order.push(`end ${id}`); return report(...items); };
  let present = false;
  const providers = new Map([
    ["a", provider("a", null, async () => { const r = await step("a", [{ name: "tool", status: present ? "ok" : "installed", action: "Run /reload" }])(); present = true; return r; })],
    ["b", provider("b", null, async () => { throw new Error("network down"); })],
    ["c", provider("c", null, step("c", [{ name: "kwin", status: "manual", action: "sudo apt install kwin-wayland" }]))],
  ]);
  const packages = ["a", "b", "c", "absent"].map(id => ({ id, label: `pkg-${id}`, command: `/${id}`, entry: `./${id}/index.ts`, dir: id }));
  const npmCalls = [];
  const installNpm = async (dir) => { npmCalls.push(dir); return [{ name: "npm dependencies", status: "installed", detail: "installed left-pad", action: "Run /reload to load them" }]; };
  const results = await runPackages("install", {}, { providers, root, packages, installNpm });
  assert.deepEqual(order, ["start a", "end a", "start c", "end c"]);
  assert.deepEqual(npmCalls, [join(root, "absent")]);
  const { text, level } = formatAggregate(results, "install");
  assert.equal(level, "error");
  assert.match(text, /^\/oh-my-pi install-deps: 4 packages: 1 installed, 1 failed, 1 manual action required, 1 not loaded$/m);
  assert.match(text, /^ {2}\[failed\] dependency install: network down\n {6}-> Run \/b install-deps on its own/m);
  assert.match(text, /^\[absent\] pkg-absent: not loaded/m);
  assert.match(text, /\[manual\] package loaded: not loaded in this session\n {6}-> Run \/reload, then \/oh-my-pi install-deps absent again/);
  assert.match(text, /Something was installed: run \/reload/);
  // Repeating is safe: the provider now reports the tool as already available.
  const again = await runPackages("install", {}, { providers, root, packages: packages.slice(0, 1), installNpm });
  assert.match(formatAggregate(again, "install").text, /1 already available/);
});

test("/oh-my-pi parses packages, completes, and runs through the command with progress cleared", async () => {
  assert.deepEqual(parseUmbrellaArgs(""), { kind: "help" });
  assert.equal(parseUmbrellaArgs("doctor").packages.length, 10);
  assert.deepEqual(parseUmbrellaArgs("install-deps browser orche").packages.map(pkg => pkg.id), ["orche", "browser"]);
  assert.match(parseUmbrellaArgs("doctor nope").message, /Unknown package nope/);
  assert.match(parseUmbrellaArgs("fix").message, /Unknown subcommand fix/);
  assert.deepEqual(completeUmbrellaArgs("").map(item => item.value), ["doctor", "install-deps", "help"]);
  assert.deepEqual(completeUmbrellaArgs("in").map(item => item.value), ["install-deps"]);
  assert.deepEqual(completeUmbrellaArgs("doctor or").map(item => item.value), ["doctor orche"]);
  assert.deepEqual(completeUmbrellaArgs("doctor orche b").map(item => item.value), ["doctor orche browser"]);
  assert.equal(completeUmbrellaArgs("help x"), null);

  const pi = fakePi();
  registerUmbrellaCommand(pi, { root: "/nonexistent-root" });
  for (const pkg of PACKAGES) registerDependencyProvider(pi.events, provider(pkg.id, async () => report({ name: "x", status: "ok" })));
  const { ctx, notifications, statuses } = fakeCtx();
  await pi.commands.get("oh-my-pi").handler("doctor", ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /10 packages: 10 healthy/);
  assert.deepEqual(statuses.at(-1), ["oh-my-pi", undefined]);
  await pi.commands.get("oh-my-pi").handler("doctor xyz", ctx);
  assert.equal(notifications.at(-1).level, "warning");
});

test("/oh-my-pi install-deps refuses to overlap itself", async () => {
  const pi = fakePi();
  registerUmbrellaCommand(pi, { root: "/nonexistent-root" });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  registerDependencyProvider(pi.events, provider("orche", null, async () => { await gate; return report({ name: "x", status: "ok" }); }));
  const { ctx, notifications } = fakeCtx();
  const first = pi.commands.get("oh-my-pi").handler("install-deps orche", ctx);
  await new Promise(resolve => setImmediate(resolve));
  await pi.commands.get("oh-my-pi").handler("install-deps orche", ctx);
  assert.match(notifications.at(-1).message, /already running/);
  release();
  await first;
  assert.match(notifications.at(-1).message, /1 already available/);
});

// --- computer-use -------------------------------------------------------------------------------------------------

function computerUseFixture(t, { driver = true, platform = "linux", arch = "x64" } = {}) {
  const root = tempDir(t, "omp-cu-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "oh-my-pi-extensions", dependencies: { "@amaster.ai/pi-computer-use": "^0.1.22" } }));
  const installPackage = () => {
    const pkg = join(root, "node_modules", "@amaster.ai", "pi-computer-use");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@amaster.ai/pi-computer-use", version: "0.1.22", exports: { "./package.json": "./package.json" } }));
  };
  const driverDir = join(root, "node_modules", "@amaster.ai", `pi-computer-use-cua-driver-${driverTarget(platform, arch)}`);
  const installDriver = () => {
    mkdirSync(join(driverDir, "bin"), { recursive: true });
    writeFileSync(join(driverDir, "package.json"), JSON.stringify({ name: "driver", version: "0.1.1", exports: { "./package.json": "./package.json" } }));
    writeFileSync(join(driverDir, "bin", "cua-driver"), "#!/bin/sh\n");
    chmodSync(join(driverDir, "bin", "cua-driver"), 0o755);
  };
  const npmBin = join(root, "bin");
  mkdirSync(npmBin);
  writeFileSync(join(npmBin, "npm"), "#!/bin/sh\n");
  chmodSync(join(npmBin, "npm"), 0o755);
  return { root, installPackage, installDriver, driverDir, npmBin };
}

const desktopEnv = (npmBin) => ({ PATH: npmBin, WAYLAND_DISPLAY: "wayland-0" });

test("computer-use doctor: healthy, then missing package, missing driver, broken driver, bad binaryPath, no desktop and unsupported platform", async (t) => {
  const f = computerUseFixture(t);
  f.installPackage(); f.installDriver();
  const calls = [];
  let driverWorks = true;
  const run = async (command, args) => { calls.push([command, ...args]); return driverWorks ? { code: 0, stdout: "cua-driver 0.28.2\n", stderr: "" } : { code: 1, stdout: "", stderr: "GLIBC_2.35 not found" }; };
  let settings = { mode: "bundled" };
  const make = (overrides = {}) => createComputerUseProvider({ root: f.root, platform: "linux", arch: "x64", env: desktopEnv(f.npmBin), run, loadSettings: async () => settings, ...overrides });
  const status = (items) => Object.fromEntries(items.map(item => [item.name, item.status]));

  let items = (await make().check({ cwd: f.root })).items;
  assert.deepEqual(status(items), { "npm package @amaster.ai/pi-computer-use": "ok", platform: "ok", "cua-driver": "ok", "desktop session": "ok", "desktop permissions": "unverified" });
  assert.ok(items.find(item => item.status === "unverified").action.includes("/computer-use-tools diagnostics"));
  assert.ok(calls.every(call => call[0] !== "npm"), "check never runs npm");

  driverWorks = false;
  items = (await make().check({})).items;
  assert.equal(status(items)["cua-driver"], "error");
  assert.match(items.find(item => item.name === "cua-driver").detail, /GLIBC_2\.35/);
  driverWorks = true;

  items = (await make({ env: { PATH: f.npmBin } }).check({})).items;
  assert.equal(status(items)["desktop session"], "warn");
  assert.match(items.find(item => item.name === "desktop session").action, /graphical desktop session/);

  settings = { mode: "path", binaryPath: "/nonexistent/cua-driver" };
  items = (await make().check({})).items;
  assert.equal(status(items)["cua-driver (settings binaryPath)"], "error");
  settings = { mode: "bundled" };

  items = (await make({ loadSettings: async () => { throw new Error("settings.json: Unexpected token"); } }).check({})).items;
  assert.equal(status(items)["pi-computer-use settings"], "error");

  rmSync(f.driverDir, { recursive: true });
  items = (await make().check({})).items;
  assert.equal(status(items)["driver package @amaster.ai/pi-computer-use-cua-driver-linux-x64"], "error");

  items = (await make({ platform: "freebsd" }).check({})).items;
  assert.equal(status(items).platform, "manual");

  rmSync(join(f.root, "node_modules"), { recursive: true });
  items = (await make().check({})).items;
  assert.equal(status(items)["npm package @amaster.ai/pi-computer-use"], "error");
  assert.match(items[0].action, /\/computer-use install-deps/);
});

test("computer-use install-deps: installs a missing package and driver with npm, is a no-op the second time, and reports npm failures", async (t) => {
  const f = computerUseFixture(t);
  const calls = [];
  let npmFails = false;
  const run = async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === "npm") {
      assert.equal(options.cwd, f.root);
      if (npmFails) return { code: 1, stdout: "", stderr: "npm ERR! network ETIMEDOUT" };
      f.installPackage(); f.installDriver();
      return { code: 0, stdout: "added 2 packages", stderr: "" };
    }
    return { code: 0, stdout: "cua-driver 0.28.2", stderr: "" };
  };
  const cu = createComputerUseProvider({ root: f.root, platform: "linux", arch: "x64", env: desktopEnv(f.npmBin), run, loadSettings: async () => ({ mode: "bundled" }) });

  npmFails = true;
  let result = await cu.install({});
  assert.equal(result.items[0].status, "failed");
  assert.match(result.items[0].detail, /ETIMEDOUT/);
  assert.match(result.items[0].action, /npm install --legacy-peer-deps/);

  npmFails = false;
  result = await cu.install({});
  assert.equal(result.items[0].status, "installed");
  assert.equal(calls.filter(call => call[0] === "npm").length, 2);
  result = await cu.install({});
  assert.equal(calls.filter(call => call[0] === "npm").length, 2, "nothing to install the second time");
  assert.equal(result.items.find(item => item.name.startsWith("npm package")).status, "ok");
  assert.match(result.items.find(item => item.name.startsWith("npm package")).detail, /already available/);

  const noNpm = computerUseFixture(t);
  const manual = await createComputerUseProvider({ root: noNpm.root, platform: "linux", arch: "x64", env: { PATH: "" }, run, loadSettings: async () => ({}) }).install({});
  assert.equal(manual.items[0].status, "manual");
  assert.match(manual.items[0].action, /Install Node\.js with npm/);
});

test("the dependencies extension answers for computer-use and registers /computer-use and /oh-my-pi", async (t) => {
  const f = computerUseFixture(t);
  f.installPackage(); f.installDriver();
  const pi = fakePi();
  createDependencyExtension({ root: f.root, computerUse: { platform: "linux", arch: "x64", env: desktopEnv(f.npmBin), run: async () => ({ code: 0, stdout: "cua-driver 0.28.2", stderr: "" }), loadSettings: async () => ({}) } })(pi);
  assert.deepEqual([...pi.commands.keys()].sort(), ["computer-use", "oh-my-pi"]);
  const { providers } = collectProviders(pi.events);
  assert.deepEqual([...providers.keys()], ["computer-use"]);
  const { ctx, notifications } = fakeCtx();
  await pi.commands.get("computer-use").handler("doctor", ctx);
  assert.match(notifications[0].message, /^pi-computer-use doctor: unverified\n/);
  await pi.commands.get("computer-use").handler("", ctx);
  assert.match(notifications.at(-1).message, /Usage: \/computer-use doctor \| install-deps/);
  assert.deepEqual(pi.commands.get("computer-use").getArgumentCompletions("in").map(item => item.value), ["install-deps"]);
  // Batch run: computer-use answered, the nine absent packages of this fixture root are reported as not loaded.
  await pi.commands.get("oh-my-pi").handler("doctor", ctx);
  assert.match(notifications.at(-1).message, /10 packages: 1 unverified, 9 not loaded/);
});

test("registerComputerUseCommand clears its status line when install throws", async () => {
  const pi = fakePi();
  registerComputerUseCommand(pi, provider("computer-use", null, async () => { throw new Error("x"); }));
  const { ctx, statuses } = fakeCtx();
  await assert.rejects(pi.commands.get("computer-use").handler("install-deps", ctx));
  assert.deepEqual(statuses.at(-1), ["computer-use", undefined]);
});
