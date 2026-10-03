// Pi clones without --recurse-submodules. Its updates fetch/reset/clean -fdx,
// never update submodules, then run npm install --omit=dev --legacy-peer-deps
// with lifecycle scripts enabled. Populate/sync submodules and restore deps here.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const lockfiles = ["package-lock.json", "npm-shrinkwrap.json"];
const fail = (message) => { throw new Error(message); };
function checked(result, label) {
  if (result.error || result.status !== 0) {
    fail(`${label}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}, signal ${result.signal}`}`);
  }
  return result.stdout;
}

function dependenciesHash(cwd) {
  const hash = createHash("sha256");
  for (const name of ["package.json", ...lockfiles]) {
    const path = join(cwd, name);
    const present = existsSync(path);
    hash.update(`${name}\0${present ? "1" : "0"}\0`);
    if (present) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

// Only detached, otherwise-clean worktrees belong to Pi. Never touch a
// developer checkout's lockfiles, including staged changes or deletions.
function restoreManagedLockfiles(path) {
  const head = git(["-C", path, "symbolic-ref", "-q", "HEAD"]);
  if (head.error || (head.status !== 0 && head.status !== 1)) checked(head, `Inspect ${path} HEAD`);
  const status = checked(git(["-C", path, "status", "--porcelain", "-z"]), `Inspect ${path} worktree`);
  const changes = status.split("\0").filter(Boolean).map((entry) => ({ status: entry.slice(0, 2), file: entry.slice(3) }));
  if (head.status !== 1 || changes.some((change) =>
    !lockfiles.includes(change.file) || (change.status !== " M" && change.status !== "??"))) return false;
  for (const change of changes) {
    if (change.status === "??") rmSync(join(root, path, change.file));
    else checked(git(["-C", path, "checkout", "--", change.file]), `Restore ${path}/${change.file}`);
  }
  if (changes.length) console.log(`[bootstrap] Cleaned npm lockfile changes in ${path}.`);
  return true;
}

try {
  if (!existsSync(join(root, ".gitmodules"))) {
    console.log("[bootstrap] Skipping: no .gitmodules at repo root.");
  } else {
    const worktree = git(["rev-parse", "--is-inside-work-tree"]);
    if (worktree.status !== 0 || worktree.stdout.trim() !== "true") {
      console.log("[bootstrap] Skipping: repo root is not a git work tree.");
    } else {
      const entries = checked(git(["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]), "List submodules");
      for (const entry of entries.trimEnd().split("\n").filter(Boolean)) {
        const path = entry.match(/^submodule\..*?\.path (.*)$/)?.[1];
        if (!path) fail(`Invalid submodule entry: ${entry}`);
        const cwd = join(root, path);
        const manifest = join(cwd, "package.json");
        let update = !existsSync(manifest);
        if (!update) {
          update = restoreManagedLockfiles(path);
        }
        if (update) {
          console.log(`[bootstrap] Syncing ${path} to its recorded commit.`);
          checked(git(["submodule", "update", "--init", "--recursive", "--", path]), `Update ${path}`);
        } else {
          console.log(`[bootstrap] Skipping git update for ${path}: on a branch or dirty (developer checkout).`);
        }
        const { dependencies = {} } = JSON.parse(readFileSync(manifest, "utf8"));
        const stamp = join(cwd, "node_modules", ".pi-bootstrap-dependencies.sha256");
        const changed = !existsSync(stamp) || readFileSync(stamp, "utf8") !== dependenciesHash(cwd);
        if (changed || Object.keys(dependencies).some((name) => !existsSync(join(cwd, "node_modules", name)))) {
          console.log(`[bootstrap] Installing missing or changed dependencies in ${path}.`);
          const windows = process.platform === "win32";
          // Inherit npm_config_omit from Pi; local installs may also need dev deps.
          checked(spawnSync(windows ? "npm.cmd" : "npm", ["install", "--legacy-peer-deps"], {
            cwd, stdio: "inherit", shell: windows,
          }), `Install dependencies in ${path}`);
          // Restore npm's lockfile changes before hashing, but only for Pi-managed checkouts.
          if (update) restoreManagedLockfiles(path);
          mkdirSync(join(cwd, "node_modules"), { recursive: true });
          writeFileSync(stamp, dependenciesHash(cwd));
        }
      }
    }
  }
} catch (error) {
  console.error(`[bootstrap] Failed: ${error.message}`);
  process.exitCode = 1;
}
