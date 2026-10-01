import { describe, expect, it } from "vitest";
import { OrcheBusyError, OrcheController, formatOutcome } from "../../src/extension/controller.js";
import type { RunOptions, RunReport } from "../../src/orchestration/coordinator.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";

const report = (overrides: Partial<RunReport> = {}): RunReport => ({
  status: "done", summary: "summary", tasks: [], startedAt: 1000, finishedAt: 4000, taskClass: "change", answer: "final answer", ...overrides,
});
async function controller(run: (options: RunOptions) => Promise<RunReport>) {
  const f = await fauxRuntime();
  const model = f.route.model.split("/");
  return {
    f,
    model: { provider: model[0]!, id: model[1]! },
    controller: new OrcheController({ agentDir: "/nonexistent-agent-dir", createRuntime: async () => f.runtime, run }),
  };
}
const args = (model: { provider: string; id: string }, extra: object = {}) => ({ request: "do it", cwd: "/nonexistent-cwd", model, thinking: "high" as const, projectTrusted: true, ...extra });

describe("OrcheController", () => {
  it("refuses a second run while one is active, and accepts one after it ends", async () => {
    const gate = deferred();
    const c = await controller(async () => { await gate.promise; return report(); });
    const first = c.controller.run(args(c.model));
    await Promise.resolve();
    expect(c.controller.busy).toBe(true);
    await expect(c.controller.run(args(c.model))).rejects.toBeInstanceOf(OrcheBusyError);
    gate.resolve();
    expect((await first).text).toBe("final answer");
    expect(c.controller.busy).toBe(false);
    expect((await c.controller.run(args(c.model))).report.status).toBe("done");
  });

  it("cancel() and the caller's signal both reach the run, and busy clears afterwards", async () => {
    const seen: AbortSignal[] = [];
    const started = { current: deferred() };
    const c = await controller(options => new Promise<RunReport>(resolve => {
      seen.push(options.signal!);
      started.current.resolve();
      const cancelled = () => resolve(report({ status: "failed", summary: "cancelled" }));
      if (options.signal!.aborted) cancelled(); else options.signal!.addEventListener("abort", cancelled);
    }));
    const viaCancel = c.controller.run(args(c.model));
    await started.current.promise;
    expect(c.controller.cancel()).toBe(true);
    expect((await viaCancel).text).toBe("cancelled");
    expect(c.controller.cancel()).toBe(false);

    const external = new AbortController();
    started.current = deferred();
    const viaSignal = c.controller.run(args(c.model, { signal: external.signal }));
    await started.current.promise;
    external.abort();
    expect((await viaSignal).report.status).toBe("failed");
    expect(seen).toHaveLength(2);
    expect(c.controller.busy).toBe(false);
  });

  it("reports the failure summary as text and aggregates usage and progress", async () => {
    const c = await controller(async options => {
      options.sink?.({ type: "usage", timestamp: 1, agentId: "A1", assignmentId: "x", model: "m", input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
      options.sink?.({ type: "advisor_usage", timestamp: 2, name: "a", model: "m", input: 5, output: 1, cacheRead: 0, cacheWrite: 0 });
      options.sink?.({ type: "request_classified", timestamp: 3, taskClass: "change", workerCount: 2, language: "en", reason: "r" });
      return report({ status: "failed", summary: "Verification kept failing" });
    });
    const lines: string[][] = [];
    const outcome = await c.controller.run(args(c.model, { onProgress: (progress: readonly string[]) => lines.push([...progress]) }));
    expect(outcome.text).toBe("Verification kept failing");
    expect(outcome.details).toMatchObject({ status: "failed", requests: 2, inputTokens: 15, outputTokens: 3, advisorRequests: 1, durationMs: 3000 });
    expect(lines.at(-1)).toEqual(["classified as change with 2 workers"]);
    expect(formatOutcome(outcome)).toMatch(/^orche FAILED \(change, 3s;/);
  });

  it("fails before running when the session model is unknown to the file-backed runtime", async () => {
    let ran = false;
    const c = await controller(async () => { ran = true; return report(); });
    await expect(c.controller.run(args({ provider: "ghost", id: "missing" }))).rejects.toThrow(".pi/orche.config.json");
    expect(ran).toBe(false);
    expect(c.controller.busy).toBe(false);
  });
});
