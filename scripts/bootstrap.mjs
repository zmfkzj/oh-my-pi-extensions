// Pi clones without --recurse-submodules. Its updates fetch/reset/clean -fdx,
// never update submodules, then run npm install --omit=dev --legacy-peer-deps
// with lifecycle scripts enabled. Populate/sync submodules and restore deps here.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const fail = (message) => { throw new Error(message); };
function checked(result, label) {
  if (result.error || result.status !== 0) {
    fail(`${label}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}, signal ${result.signal}`}`);
  }
  return result.stdout;
}

function dependenciesHash(cwd) {
  const hash = createHash("sha256");
  for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json"]) {
    const path = join(cwd, name);
    const present = existsSync(path);
    hash.update(`${name}\0${present ? "1" : "0"}\0`);
    if (present) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
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
          const head = git(["-C", path, "symbolic-ref", "-q", "HEAD"]);
          if (head.error || (head.status !== 0 && head.status !== 1)) checked(head, `Inspect ${path} HEAD`);
          const status = checked(git(["-C", path, "status", "--porcelain"]), `Inspect ${path} worktree`);
          update = head.status === 1 && status.trim() === "";
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
          // npm may create or update the lockfile during a successful install.
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
