import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type AssistantMessage, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runOrchestrated } from "../../src/orchestration/coordinator.js";
import type { RunEvent } from "../../src/orchestration/events.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

afterEach(() => vi.restoreAllMocks());
const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const decision = (value: ToolCall["arguments"]) => tool("coordinator_decision", { decision: value });
const task = { id: "change", description: "edit", owner: "A1", files: ["core.mjs"], status: "pending" };

async function run(steps: FauxResponseStep[], controller: AbortController, events: RunEvent[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "orche-cancel-"));
  const f = await fauxRuntime(steps);
  try {
    return await runOrchestrated({ problem: "edit core", cwd: dir, routes: { routes: {}, default: { model: f.route.model } }, modelRuntime: f.runtime, signal: controller.signal, sink: event => events.push(event) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("RunOptions.signal", () => {
  it("cancels a run while a worker is mid-turn: failed report, every session disposed, no later spawns", async () => {
    const entered = deferred();
    const blockedWorker: FauxResponseStep = async (_context, options) => {
      entered.resolve();
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve()));
      return reply("stopped") as AssistantMessage;
    };
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const controller = new AbortController();
    const events: RunEvent[] = [];
    const running = run([
      decision({ type: "classify", taskClass: "change", workerCount: 1, language: "en", reason: "edit" }),
      decision({ type: "assign", tasks: [task] }),
      blockedWorker,
    ], controller, events);
    await entered.promise;
    controller.abort();
    const report = await running;
    expect(report).toMatchObject({ status: "failed", summary: "cancelled" });
    expect(dispose).toHaveBeenCalledTimes(3); // coordinator, worker A1, verifier V1
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "failed", summary: "cancelled" });
  });

  it("an already-aborted signal returns a cancelled report without creating any session", async () => {
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const controller = new AbortController();
    controller.abort();
    const report = await run([], controller);
    expect(report).toMatchObject({ status: "failed", summary: "cancelled" });
    expect(dispose).not.toHaveBeenCalled();
  });
});
