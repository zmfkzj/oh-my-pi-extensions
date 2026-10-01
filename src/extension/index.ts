import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOrcheTools } from "../tools/index.js";
import { spillToolResult } from "../tools/spill.js";
import { formatOutcome, OrcheBusyError, OrcheController, type OrcheControllerOptions } from "./controller.js";

export const RESULT_MESSAGE_TYPE = "orche-result";
/** Pi built-ins that stay Pi's own but are switched on next to our tools. */
const ACTIVATE_BUILTINS = ["grep", "find", "ls"];
/** How long `/orche single` waits for the session to start the turn it just queued before giving up. */
const SINGLE_START_TIMEOUT_MS = 10_000;

const orcheRunParameters = Type.Object({
  request: Type.String({ minLength: 1, description: "The complete request for the orchestrator: what to change or investigate, with any constraints, in the user's words." }),
});
export const ORCHE_USAGE = "Usage: /orche single|multi <PROMPT> | /orche cancel";
export type OrcheCommand = { mode: "single" | "multi"; prompt: string } | { mode: "cancel" };
/**
 * The first token must be `single`, `multi` (with a non-empty prompt) or `cancel` (with nothing after it).
 * Everything else, including a bare prompt, is undefined.
 */
export function parseOrcheCommand(args: string): OrcheCommand | undefined {
  if (/^\s*cancel\s*$/.test(args)) return { mode: "cancel" };
  const match = /^\s*(single|multi)(?:\s+([\s\S]*\S))?\s*$/.exec(args);
  return match?.[2] ? { mode: match[1] as "single" | "multi", prompt: match[2] } : undefined;
}

/** Build the extension; `options` are test seams (agent dir, runtime factory, run function). */
export function createOrcheExtension(options: OrcheControllerOptions = {}) {
  return function orcheExtension(pi: ExtensionAPI): void {
    const controller = new OrcheController(options);

    // (1) Our tools replace Pi's read/edit by name; they are bound to the cwd of the call, not of the process.
    const byCwd = new Map<string, Map<string, ToolDefinition>>();
    const forCwd = (cwd: string, name: string): ToolDefinition => {
      let tools = byCwd.get(cwd);
      if (!tools) {
        tools = new Map(createOrcheTools({ cwd }).map(tool => [tool.name, tool]));
        byCwd.set(cwd, tools);
      }
      return tools.get(name)!;
    };
    const ours: string[] = [];
    for (const template of createOrcheTools({ cwd: process.cwd() })) {
      ours.push(template.name);
      pi.registerTool({
        ...template,
        execute: (id, params, signal, onUpdate, ctx) => forCwd(ctx.cwd, template.name).execute(id, params, signal, onUpdate, ctx),
      });
    }
    pi.on("tool_result", (event, ctx) => spillToolResult(event, ctx.cwd));
    pi.on("session_start", () => {
      const active = pi.getActiveTools();
      // An explicit `--tools` / defaultTools selection that leaves out our tools is the user's choice: keep it.
      if (!ours.every(name => active.includes(name))) return;
      const registered = new Set(pi.getAllTools().map(tool => tool.name));
      const extra = ACTIVATE_BUILTINS.filter(name => registered.has(name) && !active.includes(name));
      if (extra.length) pi.setActiveTools([...active, ...extra]);
    });
    pi.on("session_shutdown", () => {
      controller.cancel();
    });

    // (2) /orche single|multi <prompt>
    pi.registerCommand("orche", {
      description: "/orche single <prompt>: this session's agent handles it with the orche tools. /orche multi <prompt>: run the multi-agent orchestrator. /orche cancel: stop the active multi run.",
      handler: async (args, ctx: ExtensionCommandContext) => {
        const parsed = parseOrcheCommand(args);
        if (!parsed) {
          ctx.ui.notify(ORCHE_USAGE, "warning");
          return;
        }
        if (parsed.mode === "cancel") {
          if (!controller.cancel()) {
            ctx.ui.notify("no active orche run", "info");
            return;
          }
          await controller.whenIdle();
          ctx.ui.notify("orche run cancelled", "info");
          return;
        }
        if (parsed.mode === "single") {
          // A normal user turn on the current session: its own model, thinking level and (our) tools.
          if (!ctx.isIdle()) {
            pi.sendUserMessage(parsed.prompt, { deliverAs: "followUp" });
            ctx.ui.notify("orche single: the agent is busy; the prompt is queued as a follow-up turn.", "info");
            return;
          }
          // Keep the command pending until the turn it started has settled: one-shot modes (--print / --mode json)
          // exit as soon as the command returns, which would cut the turn off. sendUserMessage is fire-and-forget,
          // so observe the run's own start/settle events.
          let begun = false;
          const started = Promise.withResolvers<void>();
          const settled = Promise.withResolvers<void>();
          const unsubscribe = [
            pi.on("agent_start", () => { begun = true; started.resolve(); }),
            pi.on("agent_settled", () => settled.resolve()),
          ];
          const startTimer = setTimeout(() => started.resolve(), SINGLE_START_TIMEOUT_MS);
          try {
            pi.sendUserMessage(parsed.prompt);
            await started.promise;
            if (begun) await settled.promise;
            else ctx.ui.notify("orche single: the session did not start a turn for the prompt.", "warning");
          } finally {
            clearTimeout(startTimer);
            for (const off of unsubscribe) off();
          }
          return;
        }
        const request = parsed.prompt;
        const show = (lines: readonly string[]) => {
          ctx.ui.setStatus("orche", `orche: ${lines.at(-1) ?? "starting"}`);
          ctx.ui.setWidget("orche", lines.map(line => `orche · ${line}`));
        };
        const multi = async () => {
          try {
            show([]);
            const outcome = await controller.run({
              request,
              cwd: ctx.cwd,
              model: ctx.model,
              thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
              projectTrusted: ctx.isProjectTrusted(),
              signal: ctx.signal,
              onProgress: show,
            });
            pi.sendMessage(
              { customType: RESULT_MESSAGE_TYPE, content: formatOutcome(outcome), display: true, details: outcome.details },
              { triggerTurn: false },
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(message, "error");
            if (!(error instanceof OrcheBusyError)) {
              pi.sendMessage({ customType: RESULT_MESSAGE_TYPE, content: `orche could not run: ${message}`, display: true, details: { status: "failed" } }, { triggerTurn: false });
            }
          } finally {
            ctx.ui.setStatus("orche", undefined);
            ctx.ui.setWidget("orche", undefined);
          }
        };
        // The interactive TUI only feeds editor input to commands while a command or turn is not pending: it queues
        // a typed `/orche cancel` behind a pending handler. So in the TUI the run goes to the background and the
        // handler returns (the editor stays usable); one-shot modes and RPC keep the handler pending until the
        // run ends, because print/json exit when it returns and RPC clients can send `/orche cancel` concurrently.
        if (ctx.mode === "tui") void multi(); else await multi();
      },
    });

    // (3) orche_run tool for the main model
    pi.registerTool({
      name: "orche_run",
      label: "orche",
      description:
        "Delegate a substantial coding request to the pi-orche orchestrator: a coordinator plans, parallel workers explore/implement in this workspace, and an independent verifier checks the result. Returns the final report. Use it for multi-file changes, unexplained defects needing investigation, or analyses that benefit from independent verification; do small edits yourself. Only one run can be active; it can take several minutes and edits files in the current directory.",
      promptSnippet: "orche_run: delegate a substantial change/investigation to the multi-agent orchestrator and get its verified report",
      promptGuidelines: ["Use orche_run for large or risky multi-file work; do trivial edits directly."],
      parameters: orcheRunParameters,
      executionMode: "sequential",
      execute: async (_id, params, signal, onUpdate, ctx) => {
        const outcome = await controller.run({
          request: params.request,
          cwd: ctx.cwd,
          model: ctx.model,
          thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
          projectTrusted: ctx.isProjectTrusted(),
          signal,
          onProgress: lines => onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: { progress: lines } }),
        });
        if (outcome.cancelledByUser) throw new Error("cancelled by user");
        if (outcome.report.status !== "done") throw new Error(formatOutcome(outcome));
        return { content: [{ type: "text", text: formatOutcome(outcome) }], details: outcome.details };
      },
    });
  };
}

export default createOrcheExtension();
