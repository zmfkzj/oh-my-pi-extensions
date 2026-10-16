// Export CURRENT working files (including untracked additions and dirty submodules), then test production-only installs.
// No source checkout is changed and no commit is created. Managed-gitlink transitions are tested separately in bootstrap.test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findPi, root } from "./pi-harness.mjs";

const found = findPi();
assert.equal(found.version, "1.3.0");
const base = resolve(process.env.OMP_INSTALL_TEST_DIR || tmpdir());
mkdirSync(base, { recursive: true });
const sandbox = mkdtempSync(join(base, "pi-install-")), artifact = join(sandbox, "artifact");
mkdirSync(artifact);
const env = { PATH: process.env.PATH, HOME: join(sandbox, "home"), TMPDIR: join(sandbox, "tmp"),
  PI_OFFLINE: "1", OMP_PI_VERSION: "1.3.0", OMP_PI_DIR: found.dir, npm_config_omit: "dev",
  npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
  npm_config_cache: process.env.OMP_INSTALL_NPM_CACHE || join(sandbox, "npm-cache"),
  PI_CODING_AGENT_DIR: join(sandbox, "agent"), PI_AGENT_HOME: join(sandbox, "agent"),
};
for (const key of ["HOME", "TMPDIR", "PI_CODING_AGENT_DIR"]) mkdirSync(env[key], { recursive: true });
const exec = (cwd, cmd, args) => {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300_000, maxBuffer: 30 * 1024 * 1024, env });
  assert.equal(result.status, 0, `${cwd}: ${cmd} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const subs = exec(root, "git", ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"])
  .trim().split("\n").map(line => line.slice(line.indexOf(" ") + 1));
const identity = {};
for (const sub of ["", ...subs]) {
  const source = join(root, sub);
  const files = exec(source, "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    const src = join(source, file);
    if (!existsSync(src) || lstatSync(src).isDirectory()) continue; // deleted files and gitlink directory entries
    const relative = join(sub, file), dest = join(artifact, relative);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { preserveTimestamps: true });
    identity[relative] = createHash("sha256").update(readFileSync(src)).digest("hex");
  }
  // Branch/dirty checkout prevents bootstrap from resetting the uncommitted artifact to old gitlinks.
  exec(join(artifact, sub), "git", ["init", "--quiet"]);
}
const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
const evidence = { digest, files: Object.keys(identity).length, host: found, identity, stages: [] };
writeFileSync(join(sandbox, "artifact.json"), JSON.stringify(evidence, null, 2));
console.log(`Current-tree artifact ${digest}: ${evidence.files} files at ${artifact}`);
function unchanged() {
  for (const [file, hash] of Object.entries(identity)) {
    if (file.endsWith("package-lock.json")) continue; // npm can rewrite locks in developer checkouts; bootstrap tests pin this contract
    assert.equal(createHash("sha256").update(readFileSync(join(artifact, file))).digest("hex"), hash, `installed source changed: ${file}`);
  }
}
const checks = ["command-completions", "browser-lifecycle", "main-tool-surface", "mcp-lifecycle", "images-pi", "workbench-bus"];
for (const stage of ["fresh", "reinstall-after-clean"]) {
  if (stage !== "fresh") for (const sub of ["", ...subs]) rmSync(join(artifact, sub, "node_modules"), { recursive: true, force: true });
  const installed = exec(artifact, "npm", ["ci", "--omit=dev", "--legacy-peer-deps", "--offline"]);
  writeFileSync(join(sandbox, `${stage}-install.log`), installed);
  unchanged();
  for (const sub of subs) assert.ok(!existsSync(join(artifact, sub, "node_modules/@earendil-works/pi-coding-agent")), `${sub}: no bundled development SDK`);
  const tested = exec(artifact, process.execPath, ["--test", ...checks.map(name => `scripts/${name}.test.mjs`)]);
  writeFileSync(join(sandbox, `${stage}-tests.log`), tested);
  unchanged();
  evidence.stages.push({ stage, install: "npm ci --omit=dev --legacy-peer-deps --offline (postinstall enabled)", checks, passed: true });
  writeFileSync(join(sandbox, "artifact.json"), JSON.stringify(evidence, null, 2));
  console.log(`${stage}: production install + ${checks.length} real-host test files passed; source identity preserved`);
}
console.log(`Install evidence: ${sandbox}/artifact.json`);
