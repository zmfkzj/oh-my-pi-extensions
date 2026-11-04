// A/B/C comparison of the optimizer itself:
//   A  baseline: the stable harness, no optimization;
//   B  quality-only loop: failure analysis, patch, repeated screening, development - but one greedy trajectory (the current best is
//      the only parent; no Pareto archive, no multi-objective promotion);
//   C  quality-first Pareto loop: the full system.
// A's baseline runs are measured once and shared by B and C (same harness, protocol, environment and unit keys); B and C then run as
// SEPARATE trajectories with the same tasks, model, protocol, proposer and candidate budget. Their final candidates and A are
// evaluated together on the holdout in ONE pass (one recorded use). C's result also goes through the adoption gate.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { adoptionCompare, adoptionDecision, criticalProblems } from "./gate.mjs";
import { compareChecks } from "./checks.mjs";
import { holdoutLedger, holdoutStatus } from "./datasets.mjs";
import { finalAttempts, pairsOf, summarize } from "./metrics.mjs";
import { compare, describeArm } from "./stats.mjs";
import { atomicWrite, atomicWriteJson, readJson } from "./util.mjs";

const SHARED = ["runs.jsonl", "grading.json", "protocol.lock.json", "datasets.json"];

function seedTrajectory(fromDir, toDir, baseState) {
  mkdirSync(toDir, { recursive: true });
  if (existsSync(join(toDir, "state.json"))) return;
  for (const f of SHARED) if (existsSync(join(fromDir, f))) cpSync(join(fromDir, f), join(toDir, f));
  cpSync(join(fromDir, "candidates"), join(toDir, "candidates"), { recursive: true });
  atomicWriteJson(join(toDir, "state.json"), { phase: "search", cycle: 1, counters: { candidates: 0, noProgress: 0, consecutiveInfra: 0 }, stable: baseState.stable, startedAt: new Date().toISOString(), sharedBaselineFrom: fromDir });
}

/**
 * loopFactory({ stateDir, strategy }) -> Loop. Returns { ok, summary }. Resumable: every trajectory keeps its own state.
 */
export async function runAblation({ stateDir, loopFactory, protocolPath, pids, log = () => {} }) {
  loopFactory ??= async (opts) => (await import("./app.mjs")).realLoop({ ...opts, protocolPath, pids });
  const A = await loopFactory({ stateDir: join(stateDir, "A"), strategy: "pareto" });
  if (!(await A.prepare())) return { ok: false, summary: { phase: "blocked", blocked: A.state.blocked } };
  if (["prepare", "baselines"].includes(A.state.phase)) { A.setPhase("baselines"); await A.baselines(); }
  A.state.role = "A (baseline, no optimization)"; A.save();
  const trajectories = {};
  for (const [name, strategy] of [["B", "greedy"], ["C", "pareto"]]) {
    seedTrajectory(A.stateDir, join(stateDir, name), A.state);
    const loop = await loopFactory({ stateDir: join(stateDir, name), strategy });
    loop.idPrefix = `${name}-c`;
    loop.stopBefore = "holdout";
    loop.state.strategy = strategy; loop.state.role = name === "B" ? "B (quality-only loop)" : "C (quality-first Pareto loop)"; loop.save();
    trajectories[name] = loop;
  }
  await Promise.all(Object.values(trajectories).map(loop => loop.runCycle()));
  for (const [name, loop] of Object.entries(trajectories)) if (!["holdout", "done"].includes(loop.state.phase)) return { ok: false, summary: { phase: `${name}: ${loop.state.phase}`, blocked: loop.state.blocked, halted: loop.state.halted } };
  // The final harness of every condition (no selection = the stable harness itself).
  const finalOf = (loop) => loop.state.selection?.selected ?? null;
  const arms = { A: A.harness("stable") };
  for (const [name, loop] of Object.entries(trajectories)) { const id = finalOf(loop); arms[name] = id ? { ...loop.harness(id), id } : arms.A; }
  const p = A.protocol;
  const resultPath = join(stateDir, "ablation.json");
  const saved = readJson(resultPath, {});
  if (!saved.holdoutUse) {
    const status = A.holdoutDir ? holdoutStatus(A.split.holdout.map(id => A.tasksById[id]), A.holdoutDir, p, { orcheDir: A.orche }) : { independent: false, why: "no holdout" };
    saved.independence = status;
    saved.holdoutUse = A.holdoutDir ? holdoutLedger(A.holdoutDir).append({ type: "use", ablation: stateDir, protocolDigest: A.protocolDigest, arms: Object.fromEntries(Object.entries(arms).map(([k, h]) => [k, { id: h.id, commit: h.commit }])), independentBefore: status.independent, why: status.why }) : { none: true };
    atomicWriteJson(resultPath, saved);
  }
  const units = A.units("holdout", p.holdout.repeats);
  for (const h of new Map(Object.values(arms).map(h => [h.id, h])).values()) await A.evaluator.evaluate(h, units, `ablation-holdout:${h.id}`);
  const records = A.records();
  const tasks = A.split.holdout, meta = A.tasksById, seed = `${p.seed}:ablation`;
  const pairs = (a, b) => pairsOf(records, { a, b, split: "holdout", tasks, meta });
  const one = (id) => pairs(id, id).map(t => ({ ...t, a: t.b }));
  const conditions = {};
  for (const [name, h] of Object.entries(arms)) {
    const loop = name === "A" ? A : trajectories[name];
    const own = loop.records().filter(r => r.candidate_id !== "pure" && !String(r.candidate_id).startsWith("multi"));
    const optimizationRuns = name === "A" ? 0 : finalAttempts(loop.records()).filter(r => r.context?.startsWith("screen:") || r.context?.startsWith("develop:")).length;
    const proposals = name === "A" ? [] : loop.archive.all().filter(c => c.origin === "proposer");
    const proposerUsage = proposals.reduce((s, c) => ({ requests: s.requests + (c.proposer?.usage?.requests ?? 0), input: s.input + (c.proposer?.usage?.input ?? 0), output: s.output + (c.proposer?.usage?.output ?? 0) }), { requests: 0, input: 0, output: 0 });
    const optRecs = name === "A" ? [] : finalAttempts(loop.records()).filter(r => r.context?.startsWith("screen:") || r.context?.startsWith("develop:"));
    conditions[name] = {
      final: h.id, commit: h.commit ?? null, holdout: describeArm(one(h.id), { draws: p.bootstrap.draws, seed: `${seed}:${name}` }), holdoutSummary: summarize(records, h.id, "holdout"),
      candidatesProposed: proposals.length, candidateStatuses: proposals.reduce((acc, c) => { acc[c.status] = (acc[c.status] ?? 0) + 1; return acc; }, {}),
      optimizationRuns, optimizationTokens: { input: optRecs.reduce((s, r) => s + r.input_tokens, 0), output: optRecs.reduce((s, r) => s + r.output_tokens, 0), requests: optRecs.reduce((s, r) => s + r.model_requests, 0) }, proposerUsage,
      searchStop: name === "A" ? null : loop.state.searchStop, selection: name === "A" ? null : loop.state.selection, records: own.length,
    };
  }
  const contrast = (a, b) => arms[a].id === arms[b].id ? { identical: true, note: `${a} and ${b} are the same harness (${arms[a].id})` } : (() => { const c = compare(pairs(arms[a].id, arms[b].id), { draws: p.bootstrap.draws, seed: `${seed}:${a}-${b}`, level: "task", event: (d) => d.overall > 0 }); return { support: c.support, delta: c.delta, point: c.point }; })();
  const comparisons = { "B vs A (loop effect, quality-only)": contrast("A", "B"), "C vs A (loop effect, Pareto)": contrast("A", "C"), "C vs B (added effect of Pareto exploration)": contrast("B", "C") };
  // C's deployment decision: the full adoption gate on this holdout pass.
  let adoption = { verdict: "KEEP_STABLE", reasons: ["C selected no candidate"] };
  if (arms.C.id !== arms.A.id) {
    const cmp = adoptionCompare(pairs(arms.A.id, arms.C.id), p, `${seed}:adopt`);
    const holdRecs = finalAttempts(records.filter(r => r.split === "holdout" && [arms.A.id, arms.C.id].includes(r.candidate_id)));
    const envs = new Set(holdRecs.map(r => r.environment_digest));
    let checks = { pass: false, problems: ["no checks runner"] };
    if (A.checks) { const s = await A.checks(arms.A.dir, ["typecheck", "test"], join(stateDir, "checks", "stable")); const c = await A.checks(arms.C.dir, ["typecheck", "test"], join(stateDir, "checks", arms.C.id)); checks = { ...compareChecks(s, c), results: c.results }; }
    const decision = adoptionDecision(cmp, p, { holdoutIndependent: saved.independence.independent, holdoutWhy: saved.independence.why, critical: criticalProblems(records.filter(r => r.split === "holdout"), arms.C.id, { reference: arms.A.id }), checksPassed: checks.pass, checksDetail: checks.problems?.join("; ") || "ok", routeOk: envs.size === 1 && holdRecs.every(r => r.terminal_status !== "route_violation"), routeDetail: `${envs.size} environment digest(s)`, infraRate: holdRecs.length ? holdRecs.filter(r => ["infra_error", "model_unavailable"].includes(r.terminal_status)).length / holdRecs.length : 0 });
    adoption = { ...decision, support: cmp.support, delta: cmp.delta, checks: { pass: checks.pass, problems: checks.problems, environmentFailures: checks.environmentFailures } };
    if (decision.adopt && !saved.adopted) {
      const res = A.deployer.adopt({ commit: arms.C.commit, candidateId: arms.C.id, evaluation: { ablation: resultPath, support: cmp.support }, configFiles: [join(A.stateDir, "protocol.lock.json")] });
      saved.adopted = { at: new Date().toISOString(), previous: res.previous.digest, next: res.next.digest };
    }
  }
  const result = { ...saved, generatedAt: new Date().toISOString(), arms: Object.fromEntries(Object.entries(arms).map(([k, h]) => [k, { id: h.id, commit: h.commit ?? null }])), conditions, comparisons, adoption, simulated: records.some(r => r.simulated) };
  atomicWriteJson(resultPath, result);
  atomicWrite(join(stateDir, "ablation.md"), ablationMarkdown(result), 0o644);
  return { ok: true, summary: { arms: result.arms, comparisons: Object.fromEntries(Object.entries(comparisons).map(([k, v]) => [k, v.identical ? v.note : `support ${v.support.toFixed(3)}, delta ${v.delta.overall.mean.toFixed(3)}`])), adoption: { verdict: adoption.verdict, reasons: adoption.reasons }, report: join(stateDir, "ablation.md") } };
}

const pct = (x) => (x === undefined || x === null || Number.isNaN(x) ? "–" : `${(100 * x).toFixed(1)}%`);
export function ablationMarkdown(r) {
  const L = ["# A/B/C ablation of pi-eval-loop", ""];
  if (r.simulated) L.push("> SIMULATED runs present: pipeline check, not a measurement.", "");
  L.push(`Holdout independence at its use: ${r.independence?.independent ? "yes" : "NO"} (${r.independence?.why}).`, "");
  L.push("| condition | final harness | holdout Q_overall | Q_hard | Q_consistency | holdout success | proposals | optimization runs (screen+dev) | optimization tokens in/out | proposer requests | search stop |", "|---|---|---|---|---|---|---:|---:|---|---:|---|");
  for (const [name, c] of Object.entries(r.conditions)) L.push(`| ${name} | ${c.final} | ${pct(c.holdout.overall?.mean)} [${pct(c.holdout.overall?.lo95)}, ${pct(c.holdout.overall?.hi95)}] | ${pct(c.holdout.hard?.mean)} | ${pct(c.holdout.consistency?.mean)} | ${c.holdoutSummary.task_success}/${c.holdoutSummary.runs} | ${c.candidatesProposed} | ${c.optimizationRuns} | ${c.optimizationTokens.input}/${c.optimizationTokens.output} | ${c.proposerUsage.requests} | ${c.searchStop ?? "–"} |`);
  L.push("", "## Contrasts (task-level paired Bayesian bootstrap; support = P(overall improves))", "");
  for (const [k, v] of Object.entries(r.comparisons)) L.push(`- ${k}: ${v.identical ? v.note : `support ${v.support.toFixed(3)}, overall delta ${v.delta.overall.mean.toFixed(3)} [${v.delta.overall.lo95.toFixed(3)}, ${v.delta.overall.hi95.toFixed(3)}]`}`);
  L.push("", `Statements need support >= 0.95 to count as evidence of an improvement; anything lower is uncertain and reported as such.`, "", `## C adoption gate: ${r.adoption.verdict}`, "", ...(r.adoption.reasons ?? []).map(x => `- ${x}`), "");
  if (r.adopted) L.push(`Adopted on local refs at ${r.adopted.at}.`, "");
  return L.join("\n");
}
