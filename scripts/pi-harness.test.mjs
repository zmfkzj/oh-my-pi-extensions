import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findPi, PI_VERSION, startPiSession } from "./pi-harness.mjs";

const found = findPi();
function env(t, key, value) {
  const old = process.env[key]; process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
test("explicit invalid SDK fails instead of using PATH or a submodule", t => {
  env(t, "OMP_PI_DIR", "/nonexistent/required-pi-sdk");
  assert.throws(findPi, /not a .*pi-coding-agent package/);
});
test("explicit older or mixed SDK/AI versions fail required validation", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, "pi-coding-agent");
  for (const name of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
    mkdirSync(join(root, name, "dist"), { recursive: true });
    writeFileSync(join(root, name, "dist/index.js"), "");
    writeFileSync(join(root, name, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, version: "1.2.0" }));
  }
  env(t, "OMP_PI_DIR", host);
  assert.throws(findPi, new RegExp(`1\\.2\\.0.*these checks validate Pi ${PI_VERSION.replaceAll(".", "\\.")}`));
  writeFileSync(join(host, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: PI_VERSION }));
  assert.throws(findPi, /pi-ai 1\.2\.0/);
});
test("initialization failure restores environment, fetch and temporary files", async () => {
  const oldEnv = { ...process.env }, fetch = globalThis.fetch;
  let cwd;
  await assert.rejects(startPiSession(found, { setup(info) { cwd = info.cwd; throw new Error("injected setup failure"); } }), /injected setup failure/);
  assert.equal(existsSync(cwd), false);
  assert.deepEqual({ ...process.env }, oldEnv);
  assert.equal(globalThis.fetch, fetch);
});
test("loader failure restores isolation before returning an error", async () => {
  const oldEnv = { ...process.env }, fetch = globalThis.fetch;
  let cwd;
  await assert.rejects(startPiSession(found, {
    setup(info) { cwd = info.cwd; },
    extensionFactories: [() => { throw new Error("injected loader failure"); }],
  }), /injected loader failure/);
  assert.equal(existsSync(cwd), false);
  assert.deepEqual({ ...process.env }, oldEnv);
  assert.equal(globalThis.fetch, fetch);
});
test("even a failing shutdown restores environment and disposes the session", async t => {
  const oldEnv = { ...process.env }, fetch = globalThis.fetch;
  const h = await startPiSession(found);
  const spy = t.mock.method(h.session, "dispose");
  t.mock.method(h.runtime, "dispose", async () => { throw new Error("injected shutdown failure"); });
  await assert.rejects(h.dispose(), /injected shutdown failure/);
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(existsSync(h.cwd), false);
  assert.deepEqual({ ...process.env }, oldEnv);
  assert.equal(globalThis.fetch, fetch);
  await h.dispose(); // idempotent, no second shutdown
});
