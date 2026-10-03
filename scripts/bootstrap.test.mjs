import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

/**
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} [dependencies]
 */
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
if (fs.existsSync("rewrite-lockfiles")) {
  for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
    if (fs.existsSync(name)) fs.writeFileSync(name, '{"lockfileVersion":3,"npmRewritten":true}');
  }
}
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
  return { root, cwd, manifest, run, calls, success };
}

function git(cwd, args) {
  const result = spawnSync("git", ["-c", "user.name=Bootstrap Test", "-c", "user.email=bootstrap@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function submoduleFixture(t, lockfiles = ["package-lock.json"]) {
  const result = fixture(t);
  const { root, cwd } = result;
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\ninstall.log\nfail-install\nrewrite-lockfiles\n");
  writeFileSync(join(cwd, "README.md"), "old commit\n");
  for (const name of lockfiles) writeFileSync(join(cwd, name), '{"lockfileVersion":2}');
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "--quiet", "-m", "Initial dependencies"]);
  const previous = git(cwd, ["rev-parse", "HEAD"]);
  git(root, ["submodule", "add", "--force", "./fixture", "fixture"]);
  writeFileSync(join(cwd, "README.md"), "recorded commit\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "--quiet", "-m", "Recorded commit"]);
  const recorded = git(cwd, ["rev-parse", "HEAD"]);
  git(root, ["add", ".gitmodules", "fixture"]);
  git(root, ["commit", "--quiet", "-m", "Record submodule"]);
  git(cwd, ["checkout", "--quiet", "--detach", previous]);
  return { ...result, previous, recorded };
}

function expectedDependenciesHash(cwd) {
  const hash = createHash("sha256");
  for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json"]) {
    const path = join(cwd, name);
    const present = existsSync(path);
    hash.update(`${name}\0${present ? "1" : "0"}\0`);
    if (present) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
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

for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
  test(`bootstrap restores a detached submodule's modified ${name} before syncing`, (t) => {
    const { cwd, recorded, run, calls, success } = submoduleFixture(t, [name]);
    const original = readFileSync(join(cwd, name), "utf8");
    writeFileSync(join(cwd, name), '{"lockfileVersion":3,"modified":true}');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[bootstrap\] Cleaned npm lockfile changes in fixture\./);
    assert.match(result.stdout, /\[bootstrap\] Syncing fixture to its recorded commit\./);
    assert.equal(git(cwd, ["rev-parse", "HEAD"]), recorded);
    assert.equal(readFileSync(join(cwd, name), "utf8"), original);
    assert.equal(git(cwd, ["status", "--porcelain"]), "");
    success();
    assert.equal(calls().length, 1, "restored lockfiles must not cause a reinstall loop");
  });

  test(`bootstrap removes a detached submodule's untracked ${name} before syncing`, (t) => {
    const { cwd, recorded, run, calls, success } = submoduleFixture(t, []);
    writeFileSync(join(cwd, name), '{"lockfileVersion":3}');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[bootstrap\] Cleaned npm lockfile changes in fixture\./);
    assert.match(result.stdout, /\[bootstrap\] Syncing fixture to its recorded commit\./);
    assert.equal(git(cwd, ["rev-parse", "HEAD"]), recorded);
    assert.equal(existsSync(join(cwd, name)), false);
    assert.equal(git(cwd, ["status", "--porcelain"]), "");
    success();
    assert.equal(calls().length, 1, "removed lockfiles must not cause a reinstall loop");
  });
}

test("bootstrap preserves lockfiles in a detached submodule with other dirty files", (t) => {
  const { cwd, previous, run } = submoduleFixture(t);
  const lockfile = '{"lockfileVersion":3,"modified":true}';
  writeFileSync(join(cwd, "package-lock.json"), lockfile);
  writeFileSync(join(cwd, "README.md"), "developer changes\n");
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[bootstrap\] Skipping git update for fixture: on a branch or dirty \(developer checkout\)\./);
  assert.doesNotMatch(result.stdout, /Cleaned npm lockfile changes/);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), previous);
  assert.equal(readFileSync(join(cwd, "package-lock.json"), "utf8"), lockfile);
  assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "developer changes\n");
});

test("bootstrap preserves lockfiles in a submodule on a branch", (t) => {
  const { cwd, previous, run } = submoduleFixture(t);
  git(cwd, ["checkout", "--quiet", "-b", "developer"]);
  const lockfile = '{"lockfileVersion":3,"modified":true}';
  writeFileSync(join(cwd, "package-lock.json"), lockfile);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[bootstrap\] Skipping git update for fixture: on a branch or dirty \(developer checkout\)\./);
  assert.doesNotMatch(result.stdout, /Cleaned npm lockfile changes/);
  assert.equal(git(cwd, ["symbolic-ref", "--short", "HEAD"]), "developer");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), previous);
  assert.equal(readFileSync(join(cwd, "package-lock.json"), "utf8"), lockfile);
});

for (const lockfiles of [["package-lock.json", "npm-shrinkwrap.json"], []]) {
  test(`bootstrap cleans npm's ${lockfiles.length ? "tracked" : "untracked"} lockfiles before stamping a detached submodule`, (t) => {
    const { cwd, recorded, run, calls, success } = submoduleFixture(t, lockfiles);
    writeFileSync(join(cwd, "rewrite-lockfiles"), "");
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[bootstrap\] Cleaned npm lockfile changes in fixture\./);
    assert.equal(git(cwd, ["rev-parse", "HEAD"]), recorded);
    assert.equal(git(cwd, ["status", "--porcelain"]), "");
    for (const name of lockfiles) assert.equal(readFileSync(join(cwd, name), "utf8"), '{"lockfileVersion":2}');
    if (!lockfiles.length) assert.equal(existsSync(join(cwd, "package-lock.json")), false);
    const stamp = join(cwd, "node_modules", ".pi-bootstrap-dependencies.sha256");
    assert.equal(readFileSync(stamp, "utf8"), expectedDependenciesHash(cwd));
    success();
    assert.equal(calls().length, 1, "the stamp must hash restored lockfiles, not npm's changes");
  });
}

for (const onBranch of [false, true]) {
  test(`bootstrap keeps npm's lockfile rewrites in a ${onBranch ? "branch" : "dirty detached"} developer checkout`, (t) => {
    const { cwd, previous, run, calls, success } = submoduleFixture(t, ["package-lock.json", "npm-shrinkwrap.json"]);
    if (onBranch) git(cwd, ["checkout", "--quiet", "-b", "developer"]);
    else writeFileSync(join(cwd, "README.md"), "developer changes\n");
    writeFileSync(join(cwd, "rewrite-lockfiles"), "");
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipping git update for fixture/);
    assert.doesNotMatch(result.stdout, /Cleaned npm lockfile changes/);
    assert.equal(git(cwd, ["rev-parse", "HEAD"]), previous);
    for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
      assert.equal(readFileSync(join(cwd, name), "utf8"), '{"lockfileVersion":3,"npmRewritten":true}');
    }
    const stamp = join(cwd, "node_modules", ".pi-bootstrap-dependencies.sha256");
    assert.equal(readFileSync(stamp, "utf8"), expectedDependenciesHash(cwd));
    success();
    assert.equal(calls().length, 1);
  });
}
