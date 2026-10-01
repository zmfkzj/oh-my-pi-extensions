import { afterEach, describe, it, expect, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
afterEach(() => vi.restoreAllMocks());
const tools = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tools("coordinator_decision", { decision: value });
const plan = tools("plan_exploration", { explorers: [{ role: "explorer-path", angle: "code" }, { role: "explorer-cause", angle: "cause" }, { role: "explorer-repro", angle: "repro" }] });
const tasks: ToolCall["arguments"][] = [
  { id: "core", description: "fix core", owner: "A1", files: ["core.js"], status: "pending" as const },
  { id: "test", description: "test interface", owner: "A2", files: ["test.js"], dependsOn: ["core"], status: "pending" as const },
  { id: "docs", description: "document", owner: "A3", files: ["README.md"], status: "pending" as const },
];
const proposal = (id: string) => tools("report_result", { kind: "backlog_proposal", summary: "proposal", data: { sourceAgentId: id, items: [{ title: id, description: "work", files: [id + ".js"] }] } });
const done = (kind: string) => tools("report_result", { kind, summary: "done", data: { status: "done" } });
async function configured(sequences: FauxResponseStep[][]) {
  const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");
  const classification = decision({ type: "classify", taskClass: "diagnose_fix", workerCount: 3, language: "en", reason: "Unexplained defect requires independent investigation" });
  const all = await Promise.all(sequences.map((sequence, index) => fauxRuntime(index === 0 ? [classification, ...sequence] : sequence)));
  const runtime = all[0]!.runtime;
  for (const item of all.slice(1)) runtime.registerNativeProvider(item.faux.provider);
  const roles = ["coordinator", "explorer-path", "explorer-cause", "explorer-repro", "verifier"];
  return { runtime, all, disposeSpy, routes: { routes: Object.fromEntries(roles.map((role, index) => [role, { model: all[index]!.route.model }])) } };
}
const acceptance = decision({ type: "root_cause_accepted", cause: "stale credential invalidation", sourceAgentId: "A1", evidence: ["reproduced"] });
describe("LLM coordinator with real persistent Pi sessions", () => {
  for (const repair of [false, true]) it(`mid-exploration convergence, dependency reuse${repair ? " and verification repair" : ""}`, async () => {
    const entered = deferred(); const idle = deferred(); const accepted = deferred();
    const events: RunEvent[] = []; const contexts: string[] = [];
    const interrupted: FauxResponseStep = async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return reply("aborted");
    };
    const f = await configured([
      [plan, async () => { await idle.promise; return acceptance; }, decision({ type: "assign", tasks }), decision(repair ? { type: "verification_failed", reason: "edge case" } : { type: "complete", summary: "verified" }), ...(repair ? [decision({ type: "assign", tasks: [tasks[0]!] }), decision({ type: "complete", summary: "repaired" })] : [])],
      [async () => { await entered.promise; await idle.promise; return tools("send_message", { to: "main", content: "PRIVATE_A1_INVESTIGATION_EVIDENCE", signal: { kind: "root_cause_found", cause: "stale credential invalidation", evidence: ["reproduced"] } }); }, async (context, options, providerState, model) => { await accepted.promise; return interrupted(context, options, providerState, model); }, proposal("A1"), context => { contexts.push(JSON.stringify(context)); return tools("send_message", { to: "A2", content: "core interface stable" }); }, done("implement"), ...(repair ? [done("fix")] : [])],
      [tools("report_result", { kind: "explore", summary: "PRIVATE_A2_EXPLORATION_EVIDENCE" }), proposal("A2"), context => { contexts.push(JSON.stringify(context)); return done("implement"); }],
      [interrupted, proposal("A3"), done("implement")],
      [tools("report_result", { kind: "verify", summary: repair ? "edge case fails" : "tests pass", data: { passed: !repair } }), ...(repair ? [tools("report_result", { kind: "verify", summary: "all pass", data: { passed: true } })] : [])],
    ]);
    const report = await runOrchestrated({ problem: "fix", cwd: process.cwd(), routes: f.routes, modelRuntime: f.runtime, limits: { overallMs: 10000, decisionMs: 1000, assignmentMs: 1000, explorationMs: 1000 }, sink: event => {
      events.push(event);
      if (event.type === "assignment_outcome" && event.outcome.agentId === "A2" && event.outcome.kind === "explore") idle.resolve();
      if (event.type === "root_cause_accepted") accepted.resolve();
    } });
    expect(report.status).toBe("done");
    expect(events.filter(event => event.type === "preempted").map(event => event.agentId).sort()).toEqual(["A1", "A3"]);
    const started = events.filter(event => event.type === "assignment_started");
    const outcomes = events.filter(event => event.type === "assignment_outcome");
    expect(outcomes.map(event => event.outcome.assignmentId).sort()).toEqual(started.map(event => event.assignment.id).sort());
    const coreDone = events.findIndex(event => event.type === "task_finished" && event.taskId === "core");
    const testStart = events.findIndex(event => event.type === "task_dispatched" && event.taskId === "test");
    expect(testStart).toBeGreaterThan(coreDone);
    expect(contexts[0]).toContain("PRIVATE_A1_INVESTIGATION_EVIDENCE");
    expect(contexts[0]).not.toContain("PRIVATE_A2_EXPLORATION_EVIDENCE");
    expect(contexts[1]).toContain("PRIVATE_A2_EXPLORATION_EVIDENCE");
    expect(contexts[1]).toContain("core interface stable");
    expect(events.some(event => event.type === "message_sent" && event.message.from === "A1" && event.message.to === "A2")).toBe(true);
    if (repair) expect(events.filter(event => event.type === "verification").map(event => event.passed)).toEqual([false, true]);
    for (const provider of f.all) expect(provider.faux.getPendingResponseCount()).toBe(0);
    expect(f.disposeSpy).toHaveBeenCalledTimes(5);
  });
  it("repairs invalid decisions twice then fails", async () => {
    const invalid = decision({ type: "complete", summary: "premature approval" });
    const f = await configured([[plan, invalid, invalid, invalid], [tools("report_result", { kind: "explore", summary: "claim", data: { cause: "cause" } })], [reply("none")], [reply("none")], []]);
    const report = await runOrchestrated({ problem: "fix", cwd: process.cwd(), routes: f.routes, modelRuntime: f.runtime });
    expect(report).toMatchObject({ status: "failed", summary: expect.stringContaining("bounded repairs") });
    expect(f.all[0]!.faux.state.callCount).toBe(5);
    expect(f.disposeSpy).toHaveBeenCalledTimes(4);
  });
  it("all explorers without a cause fail in a bounded decision", async () => {
    const f = await configured([[plan, decision({ type: "fail", reason: "no evidence" })], [reply("none")], [reply("none")], [reply("none")], []]);
    const report = await runOrchestrated({ problem: "fix", cwd: process.cwd(), routes: f.routes, modelRuntime: f.runtime });
    expect(report).toMatchObject({ status: "failed", summary: "no evidence" });
    expect(f.disposeSpy).toHaveBeenCalledTimes(4);
  });
  it("exploration timeout disposes running sessions", async () => {
    let aborted = 0;
    const stall: FauxResponseStep = async (_context, options) => {
      await new Promise<void>(resolve => { options?.signal?.addEventListener("abort", () => { aborted++; resolve(); }, { once: true }); });
      return reply("aborted");
    };
    const f = await configured([[plan], [stall], [stall], [stall], []]);
    const report = await runOrchestrated({ problem: "fix", cwd: process.cwd(), routes: f.routes, modelRuntime: f.runtime, limits: { explorationMs: 50 } });
    expect(report).toMatchObject({ status: "failed", summary: expect.stringContaining("Exploration timeout") });
    expect(f.disposeSpy).toHaveBeenCalledTimes(4);
    expect(aborted).toBe(3);
  });
  for (const testOwner of ["A1", "A2"]) {
    it(`audits cross-task writes by worker ownership: test owner ${testOwner}`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), "orche-ownership-"));
      const explored = deferred();
      const finishedExplorers = new Set<string>();
      const events: RunEvent[] = [];
      const backlog: ToolCall["arguments"][] = [
        { id: "core", description: "fix core", owner: "A1", files: ["core.js"], status: "pending" },
        { id: "regression", description: "add regression", owner: testOwner, files: ["test/**"], dependsOn: ["core"], status: "pending" },
      ];
      const f = await configured([
        [plan, async () => { await explored.promise; return acceptance; }, decision({ type: "assign", tasks: backlog }), decision({ type: "complete", summary: "verified" })],
        [tools("report_result", { kind: "explore", summary: "cause", data: { cause: "stale credential invalidation", evidence: ["reproduced"] } }),
          proposal("A1"), tools("write", { path: "test/service.test.js", content: "export const regression = true;\n" }),
          done("implement"), ...(testOwner === "A1" ? [done("implement")] : [])],
        [tools("report_result", { kind: "explore", summary: "No additional cause" }), proposal("A2"), ...(testOwner === "A2" ? [done("implement")] : [])],
        [tools("report_result", { kind: "explore", summary: "No additional cause" }), proposal("A3")],
        [tools("report_result", { kind: "verify", summary: "verified", data: { passed: true } })],
      ]);
      try {
        const report = await runOrchestrated({
          problem: "fix", cwd: workspace, routes: f.routes, modelRuntime: f.runtime,
          sink: event => {
            events.push(event);
            if (event.type === "assignment_outcome" && event.outcome.kind === "explore") {
              finishedExplorers.add(event.outcome.agentId);
              if (finishedExplorers.size === 3) explored.resolve();
            }
          },
        });
        expect(await readFile(join(workspace, "test/service.test.js"), "utf8")).toBe("export const regression = true;\n");
        const violations = events.filter(event => event.type === "ownership_violation");
        if (testOwner === "A1") {
          expect(report.status).toBe("done");
          expect(violations).toEqual([]);
          expect(report.ownershipViolations).toEqual([]);
        } else {
          expect(report.status).toBe("failed");
          expect(violations).toMatchObject([{ agentId: "A1", file: "test/service.test.js", ownerTaskIds: ["regression"] }]);
          expect(report.ownershipViolations).toEqual([{ agentId: "A1", file: "test/service.test.js" }]);
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
  for (const explicitlyBlocked of [false, true]) {
    it(`handles completed implementation RESULT with ${explicitlyBlocked ? "explicit blocked status" : "no status field"}`, async () => {
      const explored = deferred();
      const finishedExplorers = new Set<string>();
      const events: RunEvent[] = [];
      const reason = "Required interface is missing";
      const implementation = tools("report_result", {
        kind: "implement",
        summary: explicitlyBlocked ? "Cannot implement this task" : "Implemented and checked",
        data: explicitlyBlocked ? { status: "blocked", reason } : { evidence: ["Focused checks passed"] },
      });
      const f = await configured([
        [plan, async () => { await explored.promise; return acceptance; }, decision({ type: "assign", tasks: [tasks[0]!] }),
          ...(explicitlyBlocked ? [] : [decision({ type: "complete", summary: "verified" })])],
        [tools("report_result", { kind: "explore", summary: "cause", data: { cause: "stale credential invalidation", evidence: ["reproduced"] } }), proposal("A1"), implementation],
        [tools("report_result", { kind: "explore", summary: "No additional cause" }), proposal("A2")],
        [tools("report_result", { kind: "explore", summary: "No additional cause" }), proposal("A3")],
        explicitlyBlocked ? [] : [tools("report_result", { kind: "verify", summary: "verified", data: { passed: true } })],
      ]);
      const report = await runOrchestrated({
        problem: "fix", cwd: process.cwd(), routes: f.routes, modelRuntime: f.runtime,
        sink: event => {
          events.push(event);
          if (event.type === "assignment_outcome" && event.outcome.kind === "explore") {
            finishedExplorers.add(event.outcome.agentId);
            if (finishedExplorers.size === 3) explored.resolve();
          }
        },
      });
      expect(report.tasks[0]?.status).toBe(explicitlyBlocked ? "blocked" : "done");
      expect(report.status).toBe(explicitlyBlocked ? "failed" : "done");
      if (explicitlyBlocked) {
        expect(report.summary).toContain(reason);
        expect(events.some(event => event.type === "verification")).toBe(false);
      } else {
        expect(events.some(event => event.type === "verification" && event.passed)).toBe(true);
      }
      expect(f.disposeSpy).toHaveBeenCalledTimes(5);
    });
  }
  it("delivers main NOTES from proposal and implementation waits once to the next decision", async () => {
    const explored = deferred();
    const finishedExplorers = new Set<string>();
    const prompts: string[] = [];
    const events: RunEvent[] = [];
    const f = await configured([
      [plan, async () => { await explored.promise; return acceptance; },
        context => {
          prompts.push(JSON.stringify(context.messages.findLast(message => message.role === "user")));
          return decision({ type: "assign", tasks: [tasks[0]!] });
        },
        context => {
          prompts.push(JSON.stringify(context.messages.findLast(message => message.role === "user")));
          return decision({ type: "verification_failed", reason: "additional check" });
        },
        context => {
          prompts.push(JSON.stringify(context.messages.findLast(message => message.role === "user")));
          return decision({ type: "assign", tasks: [tasks[0]!] });
        },
        context => {
          prompts.push(JSON.stringify(context.messages.findLast(message => message.role === "user")));
          return decision({ type: "complete", summary: "verified" });
        }],
      [tools("report_result", { kind: "explore", summary: "cause", data: { cause: "stale credential invalidation", evidence: ["reproduced"] } }),
        tools("send_message", { to: "main", content: "PROPOSAL_NOTE_941", signal: { kind: "proposal_info_signal" } }), proposal("A1"),
        tools("send_message", { to: "main", content: "EXECUTE_NOTE_942", signal: { kind: "implementation_info_signal" } }),
        done("implement"), done("fix")],
      [tools("report_result", { kind: "explore", summary: "No additional cause" }), proposal("A2")],
      [tools("report_result", { kind: "explore", summary: "No additional cause" }), proposal("A3")],
      [tools("report_result", { kind: "verify", summary: "additional check", data: { passed: false } }),
        tools("report_result", { kind: "verify", summary: "verified", data: { passed: true } })],
    ]);
    const report = await runOrchestrated({
      problem: "fix", cwd: process.cwd(), routes: f.routes, modelRuntime: f.runtime,
      sink: event => {
        events.push(event);
        if (event.type === "assignment_outcome" && event.outcome.kind === "explore") {
          finishedExplorers.add(event.outcome.agentId);
          if (finishedExplorers.size === 3) explored.resolve();
        }
      },
    });
    expect(report.status).toBe("done");
    expect(prompts[0]).toContain("PROPOSAL_NOTE_941");
    expect(prompts[0]).toContain("proposal_info_signal");
    expect(prompts[1]).toContain("EXECUTE_NOTE_942");
    expect(prompts[1]).toContain("implementation_info_signal");
    expect(prompts.join("\n").match(/PROPOSAL_NOTE_941/g)).toHaveLength(1);
    expect(prompts.join("\n").match(/EXECUTE_NOTE_942/g)).toHaveLength(1);
    const started = events.filter(event => event.type === "assignment_started");
    const outcomes = events.filter(event => event.type === "assignment_outcome");
    expect(outcomes.map(event => event.outcome.assignmentId).sort()).toEqual(started.map(event => event.assignment.id).sort());
  });
  for (const corrected of [true, false]) {
    it(`repairs invalid proposals once: ${corrected ? "corrected payload proceeds" : "invalid twice fails"}`, async () => {
      const explored = deferred();
      const finishedExplorers = new Set<string>();
      const events: RunEvent[] = [];
      let correctionContext = "";
      const invalid = tools("report_result", { kind: "backlog_proposal", summary: "invalid proposal", data: { sourceAgentId: "A1", items: [1, 2, 3] } });
      const f = await configured([
        [plan, async () => { await explored.promise; return acceptance; },
          ...(corrected ? [decision({ type: "assign", tasks: [tasks[0]!] }), decision({ type: "complete", summary: "verified" })] : [])],
        [tools("report_result", { kind: "explore", summary: "cause", data: { cause: "stale credential invalidation", evidence: ["reproduced"] } }),
          invalid, context => { correctionContext = JSON.stringify(context); return corrected ? proposal("A1") : invalid; },
          ...(corrected ? [done("implement")] : [])],
        [tools("report_result", { kind: "explore", summary: "No additional cause" }), proposal("A2")],
        [tools("report_result", { kind: "explore", summary: "No additional cause" }), proposal("A3")],
        corrected ? [tools("report_result", { kind: "verify", summary: "verified", data: { passed: true } })] : [],
      ]);
      const report = await runOrchestrated({
        problem: "fix", cwd: process.cwd(), routes: f.routes, modelRuntime: f.runtime,
        sink: event => {
          events.push(event);
          if (event.type === "assignment_outcome" && event.outcome.kind === "explore") {
            finishedExplorers.add(event.outcome.agentId);
            if (finishedExplorers.size === 3) explored.resolve();
          }
        },
      });
      expect(report.status).toBe(corrected ? "done" : "failed");
      expect(events.filter(event => event.type === "assignment_started" && event.agentId === "A1" && event.assignment.kind === "backlog_proposal")).toHaveLength(2);
      expect(correctionContext).toContain('"items":[1,2,3]');
      if (!corrected) expect(report.summary).toContain("after one corrective assignment");
      expect(f.disposeSpy).toHaveBeenCalledTimes(corrected ? 5 : 4);
    });
  }
});
