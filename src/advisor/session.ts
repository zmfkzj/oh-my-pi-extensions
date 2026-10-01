import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSession } from "../pi/session-factory.js";
import { READ_ONLY_TOOL_NAMES } from "../tools/index.js";
import type { ModelRoute } from "../orchestration/routing.js";
import type { AdvisorNote } from "../orchestration/events.js";
import { clip, LIMITS } from "./context.js";
import type { ResolvedAdvisor } from "./config.js";

export type Verdict = "ok" | "concern" | "blocker";
export interface AdvisorVerdict { verdict: Verdict; notes: AdvisorNote[] }
export interface AdvisorUsage { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface AdvisorRun {
  advisor: ResolvedAdvisor;
  route: ModelRoute;
  runtime: ModelRuntime;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  onUsage: (usage: AdvisorUsage) => void;
}
/** Advisor sessions are short by construction: one prompt, read-only tools, a hard turn cap. */
export const ADVISOR_MAX_TURNS = 8;
export const MAX_NOTES = 5;

export function advisorInstructions(advisor: ResolvedAdvisor): string {
  const domains = advisor.domains.map(domain => `- ${domain.id}: ${domain.instructions}`).join("\n");
  return `You are advisor "${advisor.name}" inside a multi-agent coding run. You are strictly read-only: inspect files with the provided tools; never modify files or the workspace. You are advisory only; the coordinator decides what to do with your advice.
Be sparse. Answer verdict "ok" unless you hold a concrete, evidence-backed concern; never praise, restate, or repeat what the agents already know. "concern" = worth acting on; "blocker" = proceeding will very likely yield a wrong or unverified result.
Cite evidence (file:line, command output, transcript fact) for each note. Write notes in the language of the user's request.
Finish by calling advisor_verdict exactly once, alone; do not answer in plain text.
Your advice domains:
${domains}`;
}

function verdictTool(advisor: ResolvedAdvisor, capture: (verdict: AdvisorVerdict) => void): ToolDefinition {
  const domainSchema = advisor.domains.length === 1
    ? Type.Literal(advisor.domains[0]!.id)
    : Type.Union(advisor.domains.map(domain => Type.Literal(domain.id)));
  const parameters = Type.Object({
    verdict: Type.Union([Type.Literal("ok"), Type.Literal("concern"), Type.Literal("blocker")]),
    notes: Type.Array(Type.Object({ domain: domainSchema, text: Type.String({ minLength: 1 }), evidence: Type.Optional(Type.String()) })),
  });
  let accepted = false;
  return {
    name: "advisor_verdict",
    label: "Advisor verdict",
    description: "Submit your verdict once. ok: notes must be empty. concern/blocker: 1-5 concrete notes with evidence.",
    parameters,
    execute: async (_id, args) => {
      if (accepted || !Value.Check(parameters, args)) {
        return { content: [{ type: "text", text: accepted ? "Verdict already recorded" : "Invalid verdict arguments" }], details: {}, isError: true, terminate: true };
      }
      accepted = true;
      const notes = args.verdict === "ok" ? [] : args.notes.slice(0, MAX_NOTES).map(note => ({
        domain: note.domain,
        text: clip(note.text.trim(), LIMITS.itemChars),
        ...(note.evidence?.trim() ? { evidence: clip(note.evidence.trim(), LIMITS.itemChars) } : {}),
      }));
      capture({ verdict: args.verdict, notes });
      return { content: [{ type: "text", text: "Verdict recorded" }], details: {}, terminate: true };
    },
  };
}

/** One bounded advisor call: fresh read-only session, one verdict, always disposed. */
export async function runAdvisorSession(run: AdvisorRun): Promise<AdvisorVerdict> {
  const captured: { verdict?: AdvisorVerdict } = {};
  const session = await createSession({
    cwd: run.cwd,
    route: run.route,
    modelRuntime: run.runtime,
    tools: [...READ_ONLY_TOOL_NAMES, "advisor_verdict"],
    customTools: [verdictTool(run.advisor, value => { captured.verdict ??= value; })],
    instructions: advisorInstructions(run.advisor),
  });
  let stopped: string | undefined;
  let turns = 0;
  const stop = (reason: string) => {
    stopped ??= reason;
    void session.abort();
  };
  const timer = setTimeout(() => stop(`timeout after ${run.timeoutMs}ms`), run.timeoutMs);
  const onAbort = () => stop("aborted");
  if (run.signal.aborted) onAbort(); else run.signal.addEventListener("abort", onAbort, { once: true });
  let modelError: string | undefined;
  const unsubscribe = session.subscribe(event => {
    if (event.type === "turn_end" && ++turns >= ADVISOR_MAX_TURNS && !captured.verdict) stop(`no verdict within ${ADVISOR_MAX_TURNS} turns`);
    if (event.type === "message_end" && event.message.role === "assistant") {
      const { usage } = event.message;
      run.onUsage({ model: `${event.message.provider}/${event.message.model}`, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
      modelError = event.message.stopReason === "error" ? (event.message.errorMessage ?? "model error") : undefined;
    }
  });
  try {
    await session.prompt(run.prompt);
  } catch (error) {
    stopped ??= String(error);
  } finally {
    clearTimeout(timer);
    run.signal.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
  if (!captured.verdict) throw new Error(stopped ?? modelError ?? "advisor ended without calling advisor_verdict");
  return captured.verdict;
}
