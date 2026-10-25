// Required Pi 1.4.0 gate. Does not install/upgrade packages or modify the user's Pi data; every suite runs in an isolated
// HOME/agent directory. Optional live integrations keep their own explicit skips; every local suite here is mandatory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkPiVersions, packages, root } from "./pi-versions.mjs";
import { findPi, PI_VERSION } from "./pi-harness.mjs";

assert.equal(PI_VERSION, "1.4.0", "test:compat is the mandatory 1.4.0 gate; use individual tests for another host version");
const versions = checkPiVersions();
const found = findPi();
const logs = process.env.OMP_COMPAT_LOG_DIR ? resolve(process.env.OMP_COMPAT_LOG_DIR) : mkdtempSync(join(tmpdir(), "omp-compat-"));
mkdirSync(logs, { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL/.test(key)) delete env[key];
for (const key of ["LIVE_IMAGES", "BROWSER_RUN_INTEGRATION", "BROWSER_RUN_CHROME_INTEGRATION", "ORCHE_RUN_LIVE", "PI_WORKBENCH_AI_MODULE", "PI_WORKBENCH_TUI_MODULE"]) delete env[key];
Object.assign(env, { PI_OFFLINE: "1", OMP_PI_VERSION: "1.4.0", OMP_PI_DIR: found.dir,
  PI_WORKBENCH_HOST_MODULE: join(found.dir, "dist/index.js"),
  SESSION_BUS_SMOKE: "1", SESSION_BUS_PI: join(found.dir, "dist/cli.js"),
  HOME: join(logs, "home"), XDG_CONFIG_HOME: join(logs, "config"),
  npm_config_cache: join(logs, "npm-cache"), PYTHONDONTWRITEBYTECODE: "1",
  PI_CODING_AGENT_DIR: join(logs, "agent"), PI_AGENT_HOME: join(logs, "agent"), TMPDIR: join(logs, "tmp"),
  XDG_RUNTIME_DIR: join(logs, "runtime"), PI_SESSION_BUS_DIR: join(logs, "bus"),
});
for (const key of ["HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "TMPDIR", "XDG_RUNTIME_DIR"]) mkdirSync(env[key], { recursive: true });
let socketTmp = env.TMPDIR;
if (process.platform === "linux") {
  // Only the socket fallback needs an alias. TMPDIR stays canonical: ownership/symlink guards must see real paths.
  const fd = openSync(env.XDG_RUNTIME_DIR, "r");
  env.XDG_RUNTIME_DIR = `/proc/${process.pid}/fd/${fd}`;
  process.on("exit", () => closeSync(fd));
  const tmpFd = openSync(env.TMPDIR, "r");
  socketTmp = `/proc/${process.pid}/fd/${tmpFd}`;
  process.on("exit", () => closeSync(tmpFd));
}
const results = [];
async function run(name, dir, args) {
  const command = `npm ${args.join(" ")}`;
  console.log(`\n=== ${name}: ${command} (${dir}) ===`);
  const log = join(logs, `${name}.log`), fd = openSync(log, "w");
  // session-bus's low-level socket fixtures bind directly; its Git/session fixtures canonicalize their repo paths.
  const childEnv = dir === join(root, "session-bus") ? { ...env, TMPDIR: socketTmp } : env;
  const child = spawn("npm", args, { cwd: dir, env: childEnv, detached: process.platform !== "win32", stdio: ["ignore", fd, fd] });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
  }, 300_000);
  const result = await new Promise(resolve => {
    child.on("error", error => resolve({ status: null, error }));
    child.on("close", (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(timer); closeSync(fd);
  if (timedOut) result.error = new Error("suite exceeded 300 seconds; process group killed");
  const output = readFileSync(log, "utf8");
  const summary = output.split("\n").filter(line => /Test Files|Tests\s|ℹ (tests|pass|fail|skipped|cancelled)|# (tests|pass|fail|skipped)|[0-9]+ (pass|fail|skip)|"ok":|error TS|FAIL|^✖|^﹣/.test(line));
  console.log(summary.join("\n") || output.slice(-600));
  console.log(`exit=${result.status}, log=${log}`);
  results.push({ name, command, cwd: dir, status: result.status, signal: result.signal, error: result.error?.message, log, summary });
  writeFileSync(join(logs, "results.json"), JSON.stringify({ host: found, versions,
    optionalPythonSuitesExcluded: env.PI_WORKBENCH_SKIP_PYTHON_TESTS === "1", results }, null, 2));
  if (result.status !== 0) process.exitCode = 1; // keep checking independent packages to report all failures
}
await run("root", root, ["test"]);
for (const sub of packages) {
  await run(`${sub}-typecheck`, join(root, sub), ["run", "typecheck"]);
  await run(sub, join(root, sub), ["test"]);
}
await run("workbench", join(root, "pi-workbench"), ["test"]);
await run("workbench-session", join(root, "pi-workbench"), ["run", "test:pi-session"]);
await run("workbench-editor", join(root, "pi-workbench"), ["run", "test:pi-editor"]);
// Assert the runner itself has not accidentally omitted a required entrypoint/package suite.
assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pi.extensions.length, 11);
assert.equal(results.length, 20);
console.log(`\nPi 1.4.0 gate: ${results.filter(result => result.status === 0).length}/${results.length} commands passed. Evidence: ${logs}/results.json`);
