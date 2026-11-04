// Adoption and rollback on LOCAL refs only. A stable snapshot records the umbrella commit, every submodule gitlink and checkout
// HEAD, the configuration digests the evaluation used and the evaluation evidence. Adoption moves the local branch
// `eval-loop/stable` in orche to the adopted commit and writes a matching umbrella commit (same tree, orche gitlink replaced) on
// the umbrella's `eval-loop/stable` branch with git plumbing - no checkout, no working-tree change, no push, no production branch.
// Rollback restores both refs to a recorded snapshot and verifies the result.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./worktree.mjs";
import { Ledger, digestOf, sha256 } from "./util.mjs";

const refOf = (repo, ref) => { try { return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim(); } catch { return null; } };

/** Submodule paths and recorded gitlinks of an umbrella commit. */
export function gitlinks(umbrella, commit = "HEAD") {
  const out = {};
  for (const line of git(umbrella, ["ls-tree", "-r", commit]).split("\n")) { const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line); if (m) out[m[2]] = m[1]; }
  return out;
}

/** Snapshot of the current stable state (what a rollback restores). */
export function snapshot({ umbrella, orchePath = "orche", branch, configFiles = [], evaluation = null }) {
  const orche = join(umbrella, orchePath);
  const umbrellaStable = refOf(umbrella, `refs/heads/${branch}`);
  const orcheStable = refOf(orche, `refs/heads/${branch}`);
  const base = umbrellaStable ?? refOf(umbrella, "HEAD");
  const links = gitlinks(umbrella, base);
  const checkouts = {};
  for (const path of Object.keys(gitlinks(umbrella, "HEAD"))) { try { checkouts[path] = git(join(umbrella, path), ["rev-parse", "HEAD"]).trim(); } catch { checkouts[path] = null; } }
  const configs = Object.fromEntries(configFiles.map(file => [file, existsSync(file) ? sha256(readFileSync(file)) : null]));
  return { at: new Date().toISOString(), branch, umbrella: { head: refOf(umbrella, "HEAD"), stable: umbrellaStable, base, gitlinks: links }, orche: { stableRef: orcheStable, effective: orcheStable ?? links[orchePath] ?? null }, checkouts, configs, evaluation, digest: digestOf({ links, orcheStable, umbrellaStable, configs }), checkoutsNote: "checkout HEADs are recorded, never moved by eval-loop" };
}

/** Write an umbrella commit equal to `parent`'s tree with the gitlink at `path` set to `commit` (no working tree, no index change). */
export function umbrellaCommit(umbrella, parent, path, commit, message) {
  const dir = mkdtempSync(join(tmpdir(), "el-index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    git(umbrella, ["read-tree", parent], env);
    git(umbrella, ["update-index", "--cacheinfo", `160000,${commit},${path}`], env);
    const tree = git(umbrella, ["write-tree"], env).trim();
    return git(umbrella, ["commit-tree", tree, "-p", parent, "-m", message], env).trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export class Deployer {
  constructor({ umbrella, stateDir, branch = "eval-loop/stable", orchePath = "orche", mode = "refs" }) {
    Object.assign(this, { umbrella, branch, orchePath, mode });
    this.history = new Ledger(join(stateDir, "stable-history.jsonl"));
  }
  get orche() { return join(this.umbrella, this.orchePath); }
  current(configFiles) { return snapshot({ umbrella: this.umbrella, orchePath: this.orchePath, branch: this.branch, configFiles }); }

  /** Adopt `commit` (an orche commit that exists locally). Returns { previous, next }. */
  adopt({ commit, candidateId, evaluation, configFiles = [] }) {
    const previous = this.current(configFiles);
    this.history.append({ type: "pre-adopt", candidateId, snapshot: previous });
    if (this.mode === "dry") { this.history.append({ type: "adopt-dry", candidateId, commit }); return { previous, next: previous, dry: true }; }
    if (!refOf(this.orche, commit)) throw new Error(`orche commit ${commit} not found locally`);
    const parent = previous.umbrella.base;
    const umbrellaNext = umbrellaCommit(this.umbrella, parent, this.orchePath, commit, `eval-loop: adopt ${candidateId} (orche ${commit.slice(0, 12)})\n\nAdopted by pi-eval-loop after the holdout adoption gate. Evaluation: ${evaluation?.reportPath ?? "see state"}.`);
    git(this.orche, ["update-ref", `refs/heads/${this.branch}`, commit, ...(previous.orche.stableRef ? [previous.orche.stableRef] : [])]);
    git(this.umbrella, ["update-ref", `refs/heads/${this.branch}`, umbrellaNext, ...(previous.umbrella.stable ? [previous.umbrella.stable] : [])]);
    const next = this.current(configFiles);
    next.evaluation = evaluation;
    this.history.append({ type: "adopted", candidateId, commit, umbrellaCommit: umbrellaNext, snapshot: next });
    return { previous, next };
  }

  /** The snapshot before the latest adoption (the rollback target), or undefined. */
  previousStable() { return this.history.records().filter(r => r.type === "pre-adopt").at(-1)?.snapshot; }

  /** Restore the refs of `target` (default: the snapshot before the latest adoption); verify; record. */
  rollback({ reason, target } = {}) {
    target ??= this.previousStable();
    if (!target) throw new Error("no recorded stable snapshot to roll back to");
    const before = this.current(Object.keys(target.configs ?? {}));
    const restore = (repo, ref, value) => { if (value) git(repo, ["update-ref", `refs/heads/${ref}`, value]); else if (refOf(repo, `refs/heads/${ref}`)) git(repo, ["update-ref", "-d", `refs/heads/${ref}`]); };
    if (this.mode !== "dry") {
      restore(this.orche, this.branch, target.orche.stableRef);
      restore(this.umbrella, this.branch, target.umbrella.stable);
    }
    const after = this.current(Object.keys(target.configs ?? {}));
    const problems = [];
    if (this.mode !== "dry") {
      if ((after.umbrella.stable ?? null) !== (target.umbrella.stable ?? null)) problems.push("umbrella stable ref not restored");
      if ((after.orche.stableRef ?? null) !== (target.orche.stableRef ?? null)) problems.push("orche stable ref not restored");
      if (after.orche.effective !== target.orche.effective) problems.push("effective stable orche commit differs");
      for (const [file, digest] of Object.entries(target.configs ?? {})) if ((after.configs?.[file] ?? null) !== digest) problems.push(`configuration ${file} differs from the stable snapshot (not modified by eval-loop; restore it manually)`);
      for (const [path, sha] of Object.entries(target.umbrella.gitlinks)) if (gitlinks(this.umbrella, after.umbrella.base)[path] !== sha) problems.push(`gitlink ${path} differs after rollback`);
    }
    this.history.append({ type: "rolled-back", reason, from: before, to: target, problems });
    return { before, after, problems };
  }
}
