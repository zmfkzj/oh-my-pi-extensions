// Candidate generation. The optimizer is an agent OUTSIDE the compared harnesses: plain Pi (provider only) in the sandbox on its
// own pinned route, with exactly two things mounted: the candidate's orche worktree (read-write) and a read-only evidence
// directory holding train-split failure evidence and development aggregates. Holdout tasks, hidden tests, graders, the controller,
// the state directory and every other candidate are outside its sandbox. It writes one minimal change plus out/hypothesis.json.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE, BRIDGE_PORT, LAUNCH, MOUNTS, PLACEHOLDER_KEY, completedModelCalls, runSandboxed, startModelPath, wireEntries } from "./sandbox.mjs";
import { ensureDir } from "./util.mjs";
import { FAILURE_CLASSES } from "./analysis.mjs";

export const WORK = "/tmp/work";

/** The proposer's instruction (English; the evidence is attached as files). */
export function proposerPrompt({ parentId, targetClass, protocol, blockedClasses }) {
  return [
    "You are improving an agent harness: the pi-orche extension for the Pi coding agent, checked out (read-write) in ./harness. A harness is the code and prompts around a fixed model; you may not change the model.",
    `Evidence about how the current harness (${parentId}) fails is in ./evidence (read-only): failures.json (train-split runs: task instruction, terminal status, mechanical failure class, visible/hidden test outcome, the agent's final message), analysis.json (recurring failure classes as UNVERIFIED hypotheses) and development.json (aggregate development pass rates).`,
    `Target failure class for this candidate: ${targetClass} (${FAILURE_CLASSES[targetClass] ?? targetClass}).${blockedClasses.length ? ` Do not target these classes again (earlier attempts failed): ${blockedClasses.join(", ")}.` : ""}`,
    "Make ONE minimal, general change whose effect can be traced to one hypothesis: e.g. a system-prompt or role instruction, the task-decomposition or completion policy, verification/retry policy, tool exposure, context handoff, termination conditions or failure recovery.",
    `Rules: change only files under ${protocol.proposer.allowedPaths.map(p => `harness/${p}`).join(" or ")}; at most ${protocol.proposer.maxChangedFiles} files and ${protocol.proposer.maxDiffLines} changed lines; never edit tests, experiments, fixtures, package.json or configuration; do not mention benchmarks, evaluation, graders, hidden tests or any specific task; no network access. Prefer the simplest change. Keep the TypeScript valid (you can run: cd harness && node node_modules/typescript/bin/tsc --noEmit -p .).`,
    `When done, write ${WORK}/out/hypothesis.json: {"hypothesis": "<one sentence: what behaviour changes and why it should fix the target class>", "targetFailureClass": "${targetClass}", "expectedEffect": "<which observable outcome should improve>", "files": ["<changed paths>"]}. Then stop.`,
  ].join("\n\n");
}

/** Evidence files for the proposer: train failures (hidden test CONTENT is never included) and development aggregates. */
export function writeEvidence(dir, { trainRecords, analysis, devSummary, tasksById }) {
  ensureDir(dir);
  const failures = trainRecords.filter(r => !r.task_success).map(r => ({ task: tasksById[r.task_id]?.instruction?.slice(0, 1500), terminal: r.terminal_status, detail: String(r.terminal_detail ?? "").slice(0, 300), failureClass: r.failure_class, visibleTestsPass: r.visible_test_pass, hiddenTestsPass: r.hidden_test_pass, finalMessage: String(r.final_text_excerpt ?? "").slice(0, 600), modelRequests: r.model_requests }));
  writeFileSync(join(dir, "failures.json"), JSON.stringify(failures, null, 2));
  writeFileSync(join(dir, "analysis.json"), JSON.stringify(analysis.hypotheses, null, 2));
  writeFileSync(join(dir, "development.json"), JSON.stringify(devSummary, null, 2));
  return dir;
}

/** Run the real proposer in the sandbox. Returns { ok, hypothesis?, detail, usage }. */
export async function proposeReal({ worktree, evidenceDir, protocol, env, parentId, targetClass, blockedClasses, logDir }) {
  const route = protocol.proposer.route;
  const control = mkdtempSync(join(tmpdir(), "el-p-"));
  const box = join(control, "box"), agent = join(box, "agent"), home = join(box, "home"), tmp = join(box, "tmp"), out = join(box, "out"), sessions = join(box, "sessions");
  for (const d of [agent, home, tmp, out, sessions]) ensureDir(d);
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(env.agentDir, name))) copyFileSync(join(env.agentDir, name), join(agent, name));
  const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
  writeFileSync(join(agent, "cliproxyapi.json"), JSON.stringify({ apiKey: PLACEHOLDER_KEY, baseUrl: bridgeUrl, providerId: "cliproxyapi", providerName: "CLIProxyAPI" }), { mode: 0o600 });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: route.provider, defaultModel: route.model, defaultThinkingLevel: route.effort, quietStartup: true, transport: "sse" }));
  const launch = join(control, "launch.sh"); writeFileSync(launch, LAUNCH, { mode: 0o555 });
  const model = await startModelPath({ dir: join(control, "model"), route, maxRequests: protocol.proposer.maxRequests, upstream: env.upstream, agentDir: env.agentDir, keyOverride: env.keyOverride });
  ensureDir(logDir);
  const binds = [
    { from: env.nodeDir }, { from: env.piModules }, { from: box, to: `${WORK}/box`, rw: true }, { from: out, to: `${WORK}/out`, rw: true },
    { from: worktree, to: `${WORK}/harness`, rw: true }, { from: join(env.orche, "node_modules"), to: `${WORK}/harness/node_modules` },
    { from: evidenceDir, to: `${WORK}/evidence` },
    { from: env.provider, to: MOUNTS.provider }, { from: BRIDGE, to: MOUNTS.bridge }, { from: launch, to: MOUNTS.launch }, { from: model.socket, to: MOUNTS.socket, rw: true },
  ];
  const prompt = proposerPrompt({ parentId, targetClass, protocol, blockedClasses });
  writeFileSync(join(logDir, "prompt.txt"), prompt);
  const args = [env.piCli, "--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--no-context-files", "--offline", "-e", `${MOUNTS.provider}/extensions/index.ts`, "--model", `${route.provider}/${route.model}`, "--thinking", route.effort, "--session-dir", `${WORK}/box/sessions`, "--", prompt];
  const sandboxEnv = { PATH: `${env.nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: `${WORK}/box/home`, TMPDIR: `${WORK}/box/tmp`, LANG: "C.UTF-8", TERM: "dumb", PI_CODING_AGENT_DIR: `${WORK}/box/agent`, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1", CLIPROXYAPI_BASE_URL: bridgeUrl, CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0", EL_NODE: env.node, EL_BRIDGE_READY: `${WORK}/box/tmp/.bridge-ready` };
  let run;
  try { run = await runSandboxed({ binds, env: sandboxEnv, cwd: WORK, command: ["/bin/sh", MOUNTS.launch, env.node, ...args] }, { guardMs: protocol.proposer.wallMs, stdout: join(logDir, "events.jsonl"), stderr: join(logDir, "stderr.txt"), keep: 16 * 1024 }); }
  finally { await model.stop(); }
  const wire = wireEntries(model.wireLog);
  cpSync(model.wireLog, join(logDir, "wire.jsonl"), { force: true });
  const totals = model.totals();
  let hypothesis;
  try { hypothesis = JSON.parse(readFileSync(join(out, "hypothesis.json"), "utf8")); } catch { /* missing or invalid */ }
  rmSync(control, { recursive: true, force: true });
  const usage = { requests: totals.forwarded ?? 0, completed: completedModelCalls(wire), input: totals.input ?? 0, output: totals.output ?? 0, cached: totals.cached ?? 0, wallMs: run.ms, guardFired: run.guardFired, exit: run.code };
  if (!hypothesis || typeof hypothesis.hypothesis !== "string") return { ok: false, detail: `no valid hypothesis.json (exit ${run.code}${run.guardFired ? ", wall-time guard" : ""})`, usage };
  hypothesis.targetFailureClass = targetClass;
  return { ok: true, hypothesis, usage };
}

/**
 * Scripted proposer (tests, faux self-test, reproducible ablations): entries [{ hypothesis, targetFailureClass, edit(worktreeDir) }]
 * consumed in order per trajectory.
 */
export function scriptedProposer(entries) {
  let index = 0;
  return {
    kind: "scripted",
    async propose({ worktree }) {
      const entry = entries[index++];
      if (!entry) return { ok: false, detail: "scripted proposer exhausted", usage: { requests: 0 } };
      entry.edit(worktree);
      return { ok: true, hypothesis: { hypothesis: entry.hypothesis, targetFailureClass: entry.targetFailureClass, expectedEffect: entry.expectedEffect ?? "" }, usage: { requests: 0 } };
    },
  };
}
