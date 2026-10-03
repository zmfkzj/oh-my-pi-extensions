import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

function fixture(t, dependencies = { "fixture-dependency": "1.0.0" }) {
  const root = mkdtempSync(join(tmpdir(), "pi-bootstrap-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "fixture");
  const bin = join(root, "bin");
  mkdirSync(cwd);
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./bootstrap.mjs", import.meta.url), join(root, "scripts", "bootstrap.mjs"));
  writeFileSync(join(root, ".gitmodules"), '[submodule "fixture"]\n\tpath = fixture\n');
  for (const directory of [root, cwd]) {
    const result = spawnSync("git", ["init", "--quiet"], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const manifest = join(cwd, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "fixture", version: "1.0.0", dependencies }));
  const installer = join(bin, "npm-stub.cjs");
  writeFileSync(installer, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync("install.log", JSON.stringify(process.argv.slice(2)) + "\\n");
if (fs.existsSync("fail-install")) process.exit(1);
const { dependencies = {} } = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.mkdirSync("node_modules", { recursive: true });
for (const name of Object.keys(dependencies)) fs.mkdirSync(path.join("node_modules", name), { recursive: true });
if (!fs.existsSync("package-lock.json")) fs.writeFileSync("package-lock.json", '{"lockfileVersion":3}');
`, { mode: 0o755 });
  copyFileSync(installer, join(bin, "npm"));
  writeFileSync(join(bin, "npm.cmd"), `@"${process.execPath}" "${installer}" %*\r\n`);
  const run = () => spawnSync(process.execPath, [join(root, "scripts", "bootstrap.mjs")], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  const calls = () => existsSync(join(cwd, "install.log"))
    ? readFileSync(join(cwd, "install.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const success = () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
  };
  return { cwd, manifest, run, calls, success };
}

test("bootstrap installs fresh dependencies, skips no-op runs, and tracks manifest and lockfile changes", (t) => {
  const { cwd, manifest, calls, success } = fixture(t);
  success();
  assert.deepEqual(calls(), [["install", "--legacy-peer-deps"]]);
  success();
  assert.equal(calls().length, 1, "a no-op run must not install");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  pkg.dependencies["fixture-dependency"] = "2.0.0";
  writeFileSync(manifest, JSON.stringify(pkg));
  success();
  assert.equal(calls().length, 2, "changed dependency versions must reinstall despite an existing directory");
  success();
  assert.equal(calls().length, 2);
  writeFileSync(join(cwd, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
  success();
  assert.equal(calls().length, 3, "lockfile-only changes must reinstall");
  success();
  assert.equal(calls().length, 3);
  writeFileSync(join(cwd, "npm-shrinkwrap.json"), '{"lockfileVersion":3}');
  success();
  assert.equal(calls().length, 4, "npm shrinkwrap changes must reinstall");
  rmSync(join(cwd, "npm-shrinkwrap.json"));
  success();
  assert.equal(calls().length, 5, "lockfile removal must reinstall");
});

test("bootstrap retries a failed install rather than stamping it as current", (t) => {
  const { cwd, manifest, run, calls, success } = fixture(t);
  success();
  const stamp = join(cwd, "node_modules", ".pi-bootstrap-dependencies.sha256");
  const previousStamp = readFileSync(stamp, "utf8");
  writeFileSync(manifest, readFileSync(manifest, "utf8") + "\n");
  writeFileSync(join(cwd, "fail-install"), "");
  assert.equal(run().status, 1);
  assert.equal(readFileSync(stamp, "utf8"), previousStamp);
  assert.equal(calls().length, 2);
  rmSync(join(cwd, "fail-install"));
  success();
  assert.equal(calls().length, 3);
  assert.notEqual(readFileSync(stamp, "utf8"), previousStamp);
  success();
  assert.equal(calls().length, 3);
});

test("bootstrap reinstalls missing dependency directories even with a current stamp", (t) => {
  const { cwd, calls, success } = fixture(t);
  success();
  rmSync(join(cwd, "node_modules", "fixture-dependency"), { recursive: true });
  success();
  assert.equal(calls().length, 2);
});

test("bootstrap creates dependencies and a stamp for a fresh package without runtime dependencies", (t) => {
  const { calls, success } = fixture(t, {});
  success();
  assert.equal(calls().length, 1);
  success();
  assert.equal(calls().length, 1);
});
