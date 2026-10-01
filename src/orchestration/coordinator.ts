import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { ModelRuntime, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AgentManager } from "../agent/agent-manager.js";
import type { ManagerEvent, Outcome, ResultPayload } from "../agent/agent-handle.js";
import type { NoteMessage } from "../messaging/message.js";
import { createSession } from "../pi/session-factory.js";
import {
  createPhaseState, transition, parseCoordinatorDecision, decisionSchemaForPhase,
  type CoordinatorDecision, type CoordinatorEffect, type PhaseState, type Explorer, type Phase, type TaskClass,
} from "./phases.js";
import {
  dedupeProposals, validateBacklog, readyTasks, updateTaskStatus, isBacklogDone, normalizeOwnedPath,
  type BacklogProposal, type TaskItem,
} from "./backlog.js";
import { resolveRoute, type RouteConfig } from "./routing.js";
import type { RunEventSink, CoordinatorEvent } from "./events.js";
import { workerInstructions, explorationPrompt, proposalPrompt, implementationPrompt, verificationPrompt, answerPrompt } from "./prompts.js";
import { AdvisorEngine } from "../advisor/engine.js";
import { READ_ONLY_TOOL_NAMES, WORKER_TOOL_NAMES } from "../tools/index.js";

const proposalSchema = Type.Object({
  sourceAgentId: Type.String({ minLength: 1 }),
  items: Type.Array(Type.Object({
    title: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    files: Type.Array(Type.String({ minLength: 1 })),
    dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    suggestedOwner: Type.Optional(Type.String({ minLength: 1 })),
  })),
});
const explorationPlanSchema = Type.Object({
  explorers: Type.Array(Type.Object({ role: Type.String(), angle: Type.String({ minLength: 1 }) }), { minItems: 1, maxItems: 3 }),
});
const explorerRoles = ["explorer-path", "explorer-cause", "explorer-repro"];

export interface RunLimits {
  overallMs: number;
  explorationMs: number;
  assignmentMs: number;
  decisionMs: number;
  maxFixRounds: number;
  decisionRepairs: number;
}
export const defaultRunLimits: RunLimits = {
  overallMs: 600000,
  explorationMs: 200000,
  assignmentMs: 600000,
  decisionMs: 300000,
  maxFixRounds: 1,
  decisionRepairs: 2,
};
export interface RunOptions {
  problem: string;
  cwd: string;
  routes: RouteConfig;
  sink?: RunEventSink;
  modelRuntime?: ModelRuntime;
  limits?: Partial<RunLimits>;
  /** Replaces Pi's default base system prompt for the coordinator and every worker session (not advisors); roles are still appended. */
  baseSystemPrompt?: string;
  /** Aborting cancels the run: sessions are stopped and disposed and a failed report with summary "cancelled" is returned. */
  signal?: AbortSignal;
}
export interface RunReport {
  status: "done" | "failed";
  summary: string;
  rootCause?: string;
  tasks: readonly TaskItem[];
  startedAt: number;
  finishedAt: number;
  ownershipViolations?: readonly { agentId: string; file: string }[];
  taskClass: TaskClass | "unclassified";
  answer: string;
}
interface RunContext {
  options: RunOptions;
  limits: RunLimits;
  startedAt: number;
  state: PhaseState;
  manager: AgentManager;
  coordinator?: AgentSession;
  decisionValue: unknown;
  decisionSet: boolean;
  activeTasks: Map<string, TaskItem>;
  violations: { agentId: string; file: string }[];
  unsubscribers: (() => void)[];
  mainNotes: NoteMessage[];
  bufferedNoteIds: Set<string>;
  workerIds: string[];
  workerAnswers: Map<string, string>;
  advisors?: AdvisorEngine;
  cancelled: boolean;
}
interface RootCauseClaim {
  agentId: string;
  cause: string;
  via: "note" | "result";
  evidence: unknown;
}

function emit(ctx: RunContext, event: CoordinatorEvent): void {
  ctx.options.sink?.(event);
}
function remaining(ctx: RunContext, cap: number): number {
  return Math.max(0, Math.min(cap, ctx.limits.overallMs - (Date.now() - ctx.startedAt)));
}
/** Spawn guard: a cancelled run must not create new sessions after teardown began. */
async function spawnWorker(ctx: RunContext, options: Parameters<AgentManager["spawn"]>[0]): Promise<void> {
  if (ctx.cancelled) throw new Error("cancelled");
  await ctx.manager.spawn(options);
  if (ctx.cancelled) await ctx.manager.dispose(options.id).catch(() => undefined);
  if (ctx.cancelled) throw new Error("cancelled");
}
async function bounded<T>(ctx: RunContext, operation: Promise<T>, cap: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), remaining(ctx, cap));
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
function roster(ctx: RunContext): Explorer[] {
  const workers = ctx.manager.list();
  return ctx.workerIds
    .filter(id => workers.some(worker => worker.id === id))
    .map(agentId => ({
      agentId,
      status: ctx.manager.get(agentId).status === "running" ? "running" : "idle",
      answer: ctx.workerAnswers.get(agentId),
    }));
}
function apply(ctx: RunContext, decision: CoordinatorDecision): readonly CoordinatorEffect[] {
  const result = transition(ctx.state, decision, roster(ctx));
  if (!result.ok) throw new Error(`Rejected transition: ${JSON.stringify(result.error)}`);
  const from = ctx.state.phase;
  ctx.state = result.state;
  if (from !== ctx.state.phase) {
    emit(ctx, { type: "phase_changed", timestamp: Date.now(), from, to: ctx.state.phase });
  }
  return result.effects;
}
function bufferMainNote(ctx: RunContext, note: NoteMessage): void {
  if (ctx.bufferedNoteIds.has(note.id)) return;
  ctx.bufferedNoteIds.add(note.id);
  ctx.mainNotes.push(note);
}
async function decide(ctx: RunContext, context: unknown, expectedType?: CoordinatorDecision["type"]): Promise<CoordinatorDecision> {
  await ctx.advisors?.settle(remaining(ctx, ctx.limits.decisionMs));
  const decision = await decideOnce(ctx, context, expectedType);
  const injected = await ctx.advisors?.onDecision(decision, ctx.state.phase, remaining(ctx, ctx.limits.decisionMs));
  if (!injected) return decision;
  const reconsideration = `Advisors reviewed your previous decision ${JSON.stringify(decision)} and sent NOTES (see mainNotes). Reconsider it exactly once: resubmit it unchanged if the advice is wrong or already addressed, otherwise submit a revised decision. Advisors are advisory only; you decide.\n`;
  return decideOnce(ctx, context, expectedType, reconsideration);
}
async function decideOnce(ctx: RunContext, context: unknown, expectedType?: CoordinatorDecision["type"], reconsideration = ""): Promise<CoordinatorDecision> {
  let feedback = reconsideration;
  for (let attempt = 0; attempt <= ctx.limits.decisionRepairs; attempt++) {
    if (ctx.cancelled) throw new Error("cancelled");
    ctx.decisionSet = false;
    ctx.decisionValue = undefined;
    const unreadNotes = ctx.mainNotes.splice(0).map(({ from, content, signal }) => ({ from, content, signal }));
    const decisionContext = unreadNotes.length ? { context, mainNotes: unreadNotes } : context;
    const prompt = `Decision phase ${ctx.state.phase}. Reply in the user's language (${ctx.state.language ?? "detect from request"}; Korean requests require Korean answers). Call coordinator_decision alone with arguments {"decision":<object matching schema>}. Schema: ${JSON.stringify(decisionSchemaForPhase(ctx.state.phase, ctx.state.taskClass))}\nContext: ${JSON.stringify(decisionContext)}\n${feedback}`;
    await bounded(ctx, ctx.coordinator!.prompt(prompt), ctx.limits.decisionMs, "Coordinator decision");
    if (ctx.cancelled) throw new Error("cancelled");
    try {
      if (!ctx.decisionSet) throw new Error("No decision tool called");
      const decision = parseCoordinatorDecision(ctx.decisionValue, ctx.state.phase, ctx.state.taskClass);
      if (expectedType && decision.type !== expectedType && decision.type !== "fail") {
        throw new Error(`Expected ${expectedType}, received ${decision.type}`);
      }
      const candidate = transition(ctx.state, decision, roster(ctx));
      if (!candidate.ok) throw new Error(JSON.stringify(candidate.error));
      if (decision.type === "assign") {
        if (!decision.tasks.length || decision.tasks.some(task => task.status !== "pending" || !task.files.length)) {
          throw new Error("Backlog needs nonempty pending tasks and owned files");
        }
        const issues = validateBacklog(decision.tasks, ctx.workerIds);
        if (issues.length) throw new Error(JSON.stringify(issues));
      }
      if (decision.type === "root_cause_accepted" && !ctx.workerIds.includes(decision.sourceAgentId)) {
        throw new Error("Unknown claimant");
      }
      return decision;
    } catch (error) {
      feedback = `Repair invalid decision: ${String(error)}. Remaining repairs: ${ctx.limits.decisionRepairs - attempt}`;
    }
  }
  throw new Error("Coordinator decision invalid after bounded repairs");
}
async function waitOutcomes(ctx: RunContext, kind: string, expected: Set<string>): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const deadline = Date.now() + remaining(ctx, ctx.limits.assignmentMs);
  while (expected.size) {
    const event = await ctx.manager.wait("any", Math.max(0, deadline - Date.now()));
    if (event.type === "timeout") throw new Error(`${kind} timeout`);
    if (event.type === "message") {
      bufferMainNote(ctx, event.message);
      continue;
    }
    if (event.type !== "outcome" || event.outcome.kind !== kind || !expected.has(event.outcome.agentId)) continue;
    expected.delete(event.outcome.agentId);
    outcomes.push(event.outcome);
    if (event.outcome.status !== "completed") {
      throw new Error(`${kind} ${event.outcome.agentId}: ${event.outcome.status}`);
    }
  }
  return outcomes;
}

function forwardManagerEvent(ctx: RunContext, event: ManagerEvent): void {
  ctx.options.sink?.(event);
  if (event.type === "message_sent" && event.message.type === "note" && event.message.to === "main" && (ctx.state.phase !== "EXPLORE" || event.message.from.startsWith("advisor:"))) {
    bufferMainNote(ctx, event.message);
  }
  if (event.type === "message_sent" && event.message.type === "note" && event.message.to === "main" && event.message.signal?.kind === "root_cause_found" && event.message.signal.cause) {
    emit(ctx, {
      type: "root_cause_claimed", timestamp: event.timestamp,
      agentId: event.message.from, cause: event.message.signal.cause, via: "note",
    });
  }
  if (event.type === "assignment_outcome" && event.outcome.kind === "explore") {
    const data = event.outcome.result?.data;
    if (data && typeof data === "object" && "cause" in data && typeof data.cause === "string" && data.cause.trim()) {
      emit(ctx, {
        type: "root_cause_claimed", timestamp: event.timestamp,
        agentId: event.outcome.agentId, cause: data.cause, via: "result",
      });
    }
  }
}
async function createCoordinator(ctx: RunContext, runtime: ModelRuntime): Promise<void> {
  const phases: Phase[] = ["EXPLORE", "CONVERGE", "BACKLOG", "EXECUTE", "VERIFY"];
  const decisionSchemas = phases.map(phase => decisionSchemaForPhase(phase));
  const decisionTool: ToolDefinition = {
    name: "coordinator_decision",
    label: "Coordinator decision",
    description: "Submit exactly one structured phase decision, alone. Only the current phase's decisions are accepted.",
    parameters: Type.Object({ decision: Type.Unsafe({ anyOf: decisionSchemas }) }),
    execute: async (_id, args) => {
      if (!ctx.decisionSet && args && typeof args === "object" && "decision" in args) {
        ctx.decisionValue = args.decision;
        ctx.decisionSet = true;
      }
      return { content: [{ type: "text", text: "Decision captured" }], details: {}, terminate: true };
    },
  };
  const planTool: ToolDefinition = {
    name: "plan_exploration",
    label: "Plan exploration",
    description: "Plan the requested number of distinct investigation angles using the supplied explorer route roles.",
    parameters: explorationPlanSchema,
    execute: async (_id, args) => {
      ctx.decisionValue = args;
      ctx.decisionSet = true;
      return { content: [{ type: "text", text: "Plan captured" }], details: {}, terminate: true };
    },
  };
  ctx.coordinator = await createSession({
    baseSystemPrompt: ctx.options.baseSystemPrompt,
    cwd: ctx.options.cwd,
    route: resolveRoute(ctx.options.routes, "coordinator"),
    modelRuntime: runtime,
    tools: [...READ_ONLY_TOOL_NAMES, "coordinator_decision", "plan_exploration"],
    customTools: [decisionTool, planTool],
    instructions: "You are the coordinator. Read-only. First classify the request; do not mistake explanation, review or no-modification requests for code changes. Decisions must use structured tools alone. Reply in the user's language; Korean requests require Korean answers (한국어). Accept only evidenced causes. Merge minimal tasks, disjoint ownership, explicit dependencies and the SAME worker owners. Require actual verification for changes; answers must be grounded in read-only worker evidence. Never access hidden grading data.",
  });
  if (ctx.cancelled) {
    ctx.coordinator.dispose();
    ctx.coordinator = undefined;
    throw new Error("cancelled");
  }
  ctx.unsubscribers.push(ctx.coordinator.subscribe(event => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const usage = event.message.usage;
    emit(ctx, {
      type: "coordinator_usage", timestamp: Date.now(),
      model: `${event.message.provider}/${event.message.model}`,
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    });
  }));
}
function observeOwnership(ctx: RunContext, id: string): void {
  ctx.unsubscribers.push(ctx.manager.session(id).subscribe(event => {
    if (event.type !== "tool_execution_start" || !["edit", "write"].includes(event.toolName)) return;
    const args = event.args;
    if (!args || typeof args !== "object" || !("path" in args) || typeof args.path !== "string") return;
    const file = normalizeOwnedPath(relative(ctx.options.cwd, resolve(ctx.options.cwd, args.path)));
    const ownerTasks = ctx.state.tasks.filter(task => task.files.some(ownedPath => {
      const path = normalizeOwnedPath(ownedPath);
      return file === path || path.endsWith("/") && file.startsWith(path);
    }));
    const assignmentKind = ctx.manager.get(id).currentAssignment?.kind;
    const implementing = assignmentKind === "implement" || assignmentKind === "fix";
    if (implementing && ownerTasks.some(task => task.owner === id)) return;
    ctx.violations.push({ agentId: id, file });
    emit(ctx, {
      type: "ownership_violation", timestamp: Date.now(), agentId: id, file,
      ownerTaskIds: ownerTasks.map(task => task.id),
    });
  }));
}
async function classifyRequest(ctx: RunContext): Promise<void> {
  const decision = await decide(ctx, {
    problem: ctx.options.problem,
    requirement: "FIRST decision: classify. taskClass=answer for analysis, explanation, review, root-cause reports or any explicit do-not-modify request; change for a clear feature/refactor/migration/tests/docs/performance/robustness/trivial edit; diagnose_fix only for an unexplained defect requiring investigation before fixing. Choose workerCount 1–3 proportionately: trivial one-line edits and focused questions MUST use 1; use 2–3 only for genuinely independent substantial work. language must identify the user's response language (Korean request → ko). Include a short reason. Do not investigate or implement before classification.",
  }, "classify");
  apply(ctx, decision);
  if (decision.type !== "classify") return;
  ctx.workerIds = Array.from({ length: decision.workerCount }, (_, index) => `A${index + 1}`);
  emit(ctx, {
    type: "request_classified", timestamp: Date.now(),
    taskClass: decision.taskClass, workerCount: decision.workerCount,
    language: decision.language, reason: decision.reason,
  });
}
async function spawnChangeWorkers(ctx: RunContext, runtime: ModelRuntime): Promise<void> {
  for (const id of ctx.workerIds) {
    await spawnWorker(ctx, {
      id, role: "implementer", cwd: ctx.options.cwd, baseSystemPrompt: ctx.options.baseSystemPrompt, tools: [...WORKER_TOOL_NAMES],
      route: resolveRoute(ctx.options.routes, "implementer"), modelRuntime: runtime,
      instructions: `${workerInstructions}\nYour id is ${id}. User request: ${ctx.options.problem}\nReply in the user's language (${ctx.state.language}).`,
    });
    observeOwnership(ctx, id);
  }
}
async function runAnswer(ctx: RunContext, runtime: ModelRuntime): Promise<void> {
  for (const id of ctx.workerIds) {
    await spawnWorker(ctx, {
      id, role: "analyst", cwd: ctx.options.cwd,
      route: resolveRoute(ctx.options.routes, "analyst"), modelRuntime: runtime,
      tools: [...READ_ONLY_TOOL_NAMES], baseSystemPrompt: ctx.options.baseSystemPrompt,
      instructions: `${workerInstructions}\nYour id is ${id}. This is a strictly read-only request. Never modify or create files, including scratch files. Reply in the user's language (${ctx.state.language}; Korean requests require Korean answers).`,
    });
    observeOwnership(ctx, id);
  }
  const angles = ["Explain the relevant code and substantiate the requested answer", "Review boundary cases and contracts independently", "Check conclusions and identify review findings"];
  for (const [index, id] of ctx.workerIds.entries()) {
    ctx.manager.assign(id, "answer", answerPrompt(ctx.options.problem, angles[index]!, ctx.workerIds.filter(peer => peer !== id), ctx.state.language!));
  }
  const outcomes = await waitOutcomes(ctx, "answer", new Set(ctx.workerIds));
  for (const outcome of outcomes) {
    if (outcome.result?.summary.trim()) ctx.workerAnswers.set(outcome.agentId, outcome.result.summary);
  }
  const decision = await decide(ctx, {
    problem: ctx.options.problem,
    evidence: outcomes.map(outcome => ({ agentId: outcome.agentId, result: outcome.result })),
    requirement: "Approve an evidence-backed full user-facing answer in the user's language. When one worker already supplied a complete answer, prefer type answer_from_worker with sourceAgentId and a concise summary; its full text is passed through unchanged without regenerating it in the tool arguments. Use type answer with the full text only when substantive edits or synthesis across workers are needed. Preserve concrete file references and relevant caveats. Do not propose or perform implementation; no file changes are authorized.",
  });
  apply(ctx, decision);
}
async function planAndSpawnExplorers(ctx: RunContext, runtime: ModelRuntime): Promise<void> {
  const prompt = `Plan ${ctx.workerIds.length} distinct explorers for problem: ${ctx.options.problem}. Call plan_exploration alone with explorers matching these route roles in order: ${JSON.stringify(explorerRoles.slice(0, ctx.workerIds.length))}. Each explorer requires role and angle.`;
  await bounded(ctx, ctx.coordinator!.prompt(prompt), ctx.limits.decisionMs, "Exploration plan");
  const plan = ctx.decisionValue;
  if (!Value.Check(explorationPlanSchema, plan) || plan.explorers.length !== ctx.workerIds.length || plan.explorers.some((item, index) => item.role !== explorerRoles[index] || !item.angle.trim()) || new Set(plan.explorers.map(item => item.angle)).size !== ctx.workerIds.length) {
    throw new Error("Invalid exploration plan");
  }
  for (const [index, id] of ctx.workerIds.entries()) {
    const role = explorerRoles[index]!;
    await spawnWorker(ctx, {
      id, role, cwd: ctx.options.cwd, baseSystemPrompt: ctx.options.baseSystemPrompt, tools: [...WORKER_TOOL_NAMES],
      route: resolveRoute(ctx.options.routes, role),
      modelRuntime: runtime,
      instructions: `${workerInstructions}\nYour id is ${id}. Reply in the user's language (${ctx.state.language}). For exploration, do not create any files, including /tmp scripts. Use bash node inline or heredoc without redirection.`,
    });
    observeOwnership(ctx, id);
  }
  for (const [index, id] of ctx.workerIds.entries()) {
    const peers = ctx.workerIds.filter(peer => peer !== id);
    ctx.manager.assign(id, "explore", explorationPrompt(ctx.options.problem, plan.explorers[index]!.angle, peers));
  }
}
async function converge(ctx: RunContext, cause: string, effects: readonly CoordinatorEffect[]): Promise<void> {
  await Promise.all(effects.map(async effect => {
    if (effect.type === "redirect") {
      emit(ctx, { type: "preempted", timestamp: Date.now(), agentId: effect.agentId, action: "redirect" });
      const redirect = ctx.manager.send({
        id: randomUUID(), type: "redirect", from: "main", to: effect.agentId, kind: "backlog_proposal",
        prompt: proposalPrompt(cause, ctx.workerIds.filter(id => id !== effect.agentId)),
      });
      await bounded(ctx, redirect, ctx.limits.assignmentMs, "Redirect");
    } else if (effect.type === "assign_proposal") {
      ctx.manager.assign(effect.agentId, "backlog_proposal", proposalPrompt(cause, ctx.workerIds.filter(id => id !== effect.agentId)));
    } else if (effect.type === "stop") {
      emit(ctx, { type: "preempted", timestamp: Date.now(), agentId: effect.agentId, action: "stop" });
      await ctx.manager.stop(effect.agentId);
    }
  }));
  apply(ctx, { type: "collect_backlog" });
}
async function exploreUntilAccepted(ctx: RunContext): Promise<void> {
  const claims: RootCauseClaim[] = [];
  const finished = new Set<string>();
  const deadline = Date.now() + remaining(ctx, ctx.limits.explorationMs);
  while (ctx.state.phase === "EXPLORE") {
    const event = await ctx.manager.wait("any", Math.max(0, deadline - Date.now()));
    if (event.type === "timeout") throw new Error("Exploration timeout without accepted cause");
    let claim: RootCauseClaim | undefined;
    if (event.type === "message" && event.message.signal?.kind === "root_cause_found" && event.message.signal.cause) {
      claim = {
        agentId: event.message.from, cause: event.message.signal.cause,
        evidence: event.message.signal.evidence, via: "note",
      };
    }
    if (event.type === "outcome" && event.outcome.kind === "explore") {
      finished.add(event.outcome.agentId);
      const data = event.outcome.result?.data;
      if (data && typeof data === "object" && "cause" in data && typeof data.cause === "string" && data.cause.trim()) {
        claim = {
          agentId: event.outcome.agentId, cause: data.cause,
          evidence: "evidence" in data ? data.evidence : undefined, via: "result",
        };
      }
    }
    if (claim) claims.push(claim);
    if (!claim && finished.size !== ctx.workerIds.length) continue;
    const decision = await decide(ctx, {
      problem: ctx.options.problem, claims, allExplorersFinished: finished.size === ctx.workerIds.length,
      requirement: "Accept an evidenced strong cause NOW to preempt redundant exploration. Concrete source locations and causal reproduction/log evidence suffice; do not wait for every explorer or duplicate proof. Continue only if evidence is genuinely insufficient.",
    });
    if (decision.type === "continue_exploration" && finished.size === ctx.workerIds.length) {
      throw new Error("All explorers finished without accepted cause");
    }
    const effects = apply(ctx, decision);
    if (decision.type === "root_cause_accepted") {
      emit(ctx, { type: "root_cause_accepted", timestamp: Date.now(), agentId: decision.sourceAgentId, cause: decision.cause });
      await converge(ctx, decision.cause, effects);
    }
  }
  if (ctx.state.phase === "FAILED") throw new Error(ctx.state.failure);
}
async function collectProposals(ctx: RunContext): Promise<BacklogProposal[]> {
  const outcomes = await waitOutcomes(ctx, "backlog_proposal", new Set(ctx.workerIds));
  const proposals: BacklogProposal[] = [];
  for (const outcome of outcomes) {
    let data = outcome.result?.data;
    if (!Value.Check(proposalSchema, data)) {
      const validationError = [...Value.Errors(proposalSchema, data)]
        .map(error => `${error.path || "/"}: ${error.message}`).join("; ");
      const prompt = `Assignment: backlog_proposal. Your previous RESULT data was invalid: ${validationError}. Correct it ONCE, do not edit files. Expected data shape: ${JSON.stringify(proposalSchema)}. Example: {"sourceAgentId":"${outcome.agentId}","items":[{"title":"Fix identified cause","description":"Concrete change","files":["src/example.js"]}]}. Call report_result alone with kind backlog_proposal, summary and the corrected data object.`;
      ctx.manager.assign(outcome.agentId, "backlog_proposal", prompt);
      const [corrected] = await waitOutcomes(ctx, "backlog_proposal", new Set([outcome.agentId]));
      data = corrected!.result?.data;
      if (!Value.Check(proposalSchema, data)) {
        throw new Error(`Invalid proposal from ${outcome.agentId} after one corrective assignment`);
      }
    }
    proposals.push({ ...data, sourceAgentId: outcome.agentId });
  }
  return proposals;
}
async function executeBacklog(ctx: RunContext): Promise<void> {
  const kind = ctx.state.fixRounds ? "fix" : "implement";
  const blockedReasons: string[] = [];
  while (!isBacklogDone(ctx.state.tasks)) {
    for (const task of readyTasks(ctx.state.tasks)) {
      if (ctx.manager.get(task.owner!).status !== "idle") continue;
      ctx.activeTasks.set(task.owner!, task);
      ctx.state = { ...ctx.state, tasks: updateTaskStatus(ctx.state.tasks, task.id, "running") };
      ctx.manager.assign(task.owner!, kind, implementationPrompt(task, ctx.state.tasks, kind === "fix"));
      emit(ctx, { type: "task_dispatched", timestamp: Date.now(), taskId: task.id, agentId: task.owner! });
    }
    if (!ctx.state.tasks.some(task => task.status === "running")) {
      const details = blockedReasons.length ? `: ${blockedReasons.join("; ")}` : "";
      throw new Error(`Backlog blocked${details}`);
    }
    const event = await ctx.manager.wait("any", remaining(ctx, ctx.limits.assignmentMs));
    if (event.type === "timeout") throw new Error("Implementation timeout");
    if (event.type === "message") {
      bufferMainNote(ctx, event.message);
      continue;
    }
    if (event.type !== "outcome" || event.outcome.kind !== kind) continue;
    const task = ctx.activeTasks.get(event.outcome.agentId);
    if (!task) continue;
    ctx.activeTasks.delete(event.outcome.agentId);
    const data = event.outcome.result?.data;
    const explicitlyBlocked = data && typeof data === "object" && "status" in data && data.status === "blocked";
    const status = event.outcome.status === "completed" && !explicitlyBlocked ? "done" : "blocked";
    if (status === "blocked") {
      const reason = data && typeof data === "object" && "reason" in data && typeof data.reason === "string"
        ? data.reason
        : event.outcome.result?.summary ?? event.outcome.error ?? event.outcome.status;
      blockedReasons.push(`${task.id} (${event.outcome.agentId}): ${reason}`);
    }
    ctx.state = { ...ctx.state, tasks: updateTaskStatus(ctx.state.tasks, task.id, status) };
    emit(ctx, { type: "task_finished", timestamp: Date.now(), taskId: task.id, agentId: event.outcome.agentId, status });
  }
}
async function verifyRound(ctx: RunContext): Promise<ResultPayload | undefined> {
  apply(ctx, { type: "verify" });
  ctx.manager.assign("V1", "verify", verificationPrompt(ctx.options.problem, ctx.state.tasks));
  const [verification] = await waitOutcomes(ctx, "verify", new Set(["V1"]));
  const verificationData = verification!.result?.data;
  const passed = Boolean(verificationData && typeof verificationData === "object" && "passed" in verificationData && verificationData.passed === true);
  const summary = verification!.result?.summary ?? "Verification missing result";
  emit(ctx, { type: "verification", timestamp: Date.now(), passed, round: ctx.state.fixRounds, summary });
  const decision = await decide(ctx, {
    verification: verification!.result,
    requirement: passed ? "Complete only if evidence supports success. Your complete.summary is the final user-facing answer: concisely describe what changed and how it was verified, with relevant caveats, in the user's language." : "Verification failed: use verification_failed or fail, never complete.",
  });
  if (!passed && decision.type === "complete") throw new Error("Coordinator approved failed verification");
  apply(ctx, decision);
  return verification!.result;
}
async function mergeExecuteAndVerify(ctx: RunContext, runtime: ModelRuntime, proposals: BacklogProposal[] = []): Promise<void> {
  let mergeContext: unknown = {
    problem: ctx.options.problem, proposals: dedupeProposals(proposals), rootCause: ctx.state.rootCause, owners: ctx.workerIds,
    requirement: "Merge into nonempty pending tasks; reuse the selected owners, disjoint files, dependsOn IDs. Ownership files must be concrete repository-relative paths or recursive directory prefixes ending / (directory/** is also accepted and canonicalized). No other ownership globs. Include every file area the requested change must touch. Plan the minimal requested changes with appropriate regression coverage; reuse existing tests when sufficient. Documentation only if the user's problem asks for it. Do not investigate root causes for clear change requests.",
  };
  await spawnWorker(ctx, {
    id: "V1", role: "verifier", cwd: ctx.options.cwd,
    route: resolveRoute(ctx.options.routes, "verifier"), modelRuntime: runtime,
    instructions: `${workerInstructions}\nReply in the user's language (${ctx.state.language}).`, tools: [...READ_ONLY_TOOL_NAMES, "bash"], baseSystemPrompt: ctx.options.baseSystemPrompt,
  });
  while (ctx.state.phase !== "DONE" && ctx.state.phase !== "FAILED") {
    const merged = await decide(ctx, mergeContext);
    apply(ctx, merged);
    if (merged.type !== "assign") throw new Error(ctx.state.failure ?? "Expected backlog assignment");
    emit(ctx, { type: "backlog_created", timestamp: Date.now(), tasks: ctx.state.tasks });
    await executeBacklog(ctx);
    const verification = await verifyRound(ctx);
    mergeContext = {
      verification, previousTasks: ctx.state.tasks, owners: ctx.workerIds,
      requirement: "Create minimal fix tasks assigned to the original owning workers. Pending status and disjoint ownership. Preserve unaffected implementation.",
    };
  }
}

export async function runOrchestrated(options: RunOptions): Promise<RunReport> {
  const startedAt = Date.now();
  const overallMs = options.limits?.overallMs ?? defaultRunLimits.overallMs;
  const limits: RunLimits = {
    ...defaultRunLimits,
    explorationMs: overallMs / 3,
    assignmentMs: overallMs,
    decisionMs: overallMs / 2,
    ...options.limits,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid limit ${key}`);
  }
  if (!Number.isInteger(limits.maxFixRounds) || !Number.isInteger(limits.decisionRepairs) || limits.decisionRepairs > 2) {
    throw new Error("Invalid repair cap");
  }
  const ctx: RunContext = {
    options, limits, startedAt,
    state: createPhaseState(limits.maxFixRounds),
    manager: new AgentManager(options.modelRuntime),
    decisionValue: undefined,
    decisionSet: false,
    activeTasks: new Map(),
    violations: [],
    unsubscribers: [],
    mainNotes: [],
    bufferedNoteIds: new Set(),
    workerIds: [],
    workerAnswers: new Map(),
    cancelled: false,
  };
  ctx.unsubscribers.push(ctx.manager.subscribe(event => forwardManagerEvent(ctx, event)));
  emit(ctx, { type: "run_started", timestamp: startedAt, mode: "orchestrated", problem: options.problem });
  emit(ctx, { type: "phase_changed", timestamp: startedAt, from: "INIT", to: "EXPLORE" });
  const cancellation = Promise.withResolvers<never>();
  const onAbort = () => {
    ctx.cancelled = true;
    cancellation.reject(new Error("cancelled"));
  };
  if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
  const execute = async () => {
    const runtime = options.modelRuntime ?? await ModelRuntime.create();
    if (ctx.cancelled) return;
    if (options.routes.advisors?.length) {
      const engine = new AdvisorEngine(options.routes.advisors, {
        cwd: options.cwd, problem: options.problem, runtime, routes: options.routes, manager: ctx.manager,
        coordinator: () => ctx.coordinator, emit: event => emit(ctx, event),
      });
      if (engine.active) {
        ctx.advisors = engine;
        engine.start();
      }
    }
    if (ctx.cancelled) return;
    await createCoordinator(ctx, runtime);
    await classifyRequest(ctx);
    if (ctx.state.taskClass === "answer") {
      await runAnswer(ctx, runtime);
    } else if (ctx.state.taskClass === "change") {
      await spawnChangeWorkers(ctx, runtime);
      await mergeExecuteAndVerify(ctx, runtime);
    } else if (ctx.state.taskClass === "diagnose_fix") {
      await planAndSpawnExplorers(ctx, runtime);
      await exploreUntilAccepted(ctx);
      const proposals = await collectProposals(ctx);
      await mergeExecuteAndVerify(ctx, runtime, proposals);
    }
  };
  try {
    await Promise.race([execute(), cancellation.promise]);
    if (ctx.cancelled) throw new Error("cancelled");
  } catch (error) {
    if (ctx.state.phase !== "FAILED" && ctx.state.phase !== "DONE") {
      apply(ctx, { type: "fail", reason: ctx.cancelled ? "cancelled" : String(error) });
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    ctx.cancelled = true;
    await ctx.advisors?.dispose();
    if (ctx.coordinator) {
      await ctx.coordinator.abort();
      ctx.coordinator.dispose();
    }
    await ctx.manager.dispose();
    for (const unsubscribe of ctx.unsubscribers) unsubscribe();
  }
  const status = ctx.state.phase === "DONE" && !ctx.violations.length ? "done" : "failed";
  const summary = ctx.violations.length
    ? `Decomposition failure: ${ctx.violations.length} ownership violations`
    : ctx.state.summary ?? ctx.state.failure ?? "Run failed";
  const finishedAt = Date.now();
  emit(ctx, { type: "run_finished", timestamp: finishedAt, status, summary });
  return {
    status, summary, rootCause: ctx.state.rootCause?.cause, tasks: ctx.state.tasks,
    startedAt, finishedAt, ownershipViolations: ctx.violations,
    taskClass: ctx.state.taskClass ?? "unclassified", answer: status === "done" ? ctx.state.answer ?? summary : summary,
  };
}
