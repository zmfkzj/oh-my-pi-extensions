// The candidate's own relevant checks (orche typecheck and test suite), run on the candidate worktree inside the sandbox (no
// network, host hidden) with orche's installed dependencies bound read-only. A candidate that breaks them is a critical failure.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "./util.mjs";
import { runSandboxed } from "./sandbox.mjs";

export const CHECKS = {
  typecheck: ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "."],
  test: ["node_modules/vitest/vitest.mjs", "run", "--reporter=dot"],
};

export async function runChecks({ worktree, env, which = ["typecheck"], logDir, timeoutMs = 20 * 60_000 }) {
  ensureDir(logDir);
  const results = {};
  for (const name of which) {
    const home = mkdtempSync(join(tmpdir(), "el-c-"));
    // Vite/vitest write their config bundle and cache inside node_modules: give them private writable directories.
    const scratchBinds = [".vite", ".vite-temp"].filter(name => existsSync(join(env.orche, "node_modules", name))).map(name => ({ from: ensureDir(join(home, name)), to: `/tmp/check/orche/node_modules/${name}`, rw: true }));
    const run = await runSandboxed({
      binds: [{ from: env.nodeDir }, { from: worktree, to: "/tmp/check/orche", rw: true }, { from: join(env.orche, "node_modules"), to: "/tmp/check/orche/node_modules" }, ...scratchBinds, { from: home, to: "/tmp/check/home", rw: true }],
      env: { PATH: `${env.nodeDir}/bin:/usr/bin:/bin`, HOME: "/tmp/check/home", TMPDIR: "/tmp/check/home", LANG: "C.UTF-8", TZ: "UTC", CI: "1", PI_OFFLINE: "1" },
      cwd: "/tmp/check/orche", command: [env.node, ...CHECKS[name]],
    }, { guardMs: timeoutMs, keep: 256 * 1024 });
    rmSync(home, { recursive: true, force: true });
    writeFileSync(join(logDir, `${name}.log`), run.text);
    const clean = run.text.replace(/\x1b\[[0-9;]*m/g, "");
    const failing = [...new Set([...clean.matchAll(/^ FAIL {1,2}(.+)$/gm)].map(m => m[1].trim()))];
    results[name] = { pass: run.code === 0 && !run.guardFired, exit: run.code, timeout: run.guardFired, ms: run.ms, failing, tail: clean.slice(-1500) };
  }
  return { pass: Object.values(results).every(r => r.pass), results };
}

/**
 * Relevant-check gate for adoption: the candidate's typecheck must pass and its test suite may not fail any test that passes for the
 * stable harness in the SAME sandboxed environment (tests that need local untracked results, ripgrep or git metadata fail for both
 * and are listed as environment failures, never silently ignored).
 */
export function compareChecks(stable, candidate) {
  const problems = [];
  if (!candidate.results.typecheck?.pass) problems.push("candidate typecheck fails");
  const stableFailing = new Set(stable.results.test?.failing ?? []);
  const candFailing = candidate.results.test?.failing ?? [];
  const introduced = candFailing.filter(name => !stableFailing.has(name));
  if (candidate.results.test && !candidate.results.test.pass && !candFailing.length) problems.push("candidate test run failed without a parsable failure list");
  if (introduced.length) problems.push(`tests failing only with the candidate: ${introduced.slice(0, 5).join(" | ")}`);
  if (candidate.results.test?.timeout) problems.push("candidate test run timed out");
  return { pass: problems.length === 0, problems, introduced, environmentFailures: [...stableFailing] };
}
