import { afterEach, describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  fauxAssistantMessage as reply,
  fauxToolCall as call,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { AgentManager } from "../../src/agent/agent-manager.js";
import { deferred, fauxRuntime } from "../helpers/faux.js";
import type { AgentManagerOptions, ManagerEvent } from "../../src/agent/agent-handle.js";
const managers: AgentManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
});
async function setup(
  steps: FauxResponseStep[],
  customTools: Parameters<AgentManager["spawn"]>[0]["customTools"] = [],
  options: AgentManagerOptions = {},
) {
  const f = await fauxRuntime(steps);
  const m = new AgentManager(f.runtime, options);
  managers.push(m);
  await m.spawn({
    id: "a",
    role: "test",
    route: f.route,
    modelRuntime: f.runtime,
    cwd: process.cwd(),
    instructions: "test",
    tools: customTools?.map((t) => t.name) ?? [],
    customTools,
  });
  return { m, ...f };
}
const result = (summary = "done") =>
  reply([call("report_result", { kind: "analysis", summary })], {
    stopReason: "toolUse",
  });
const note = (id = "n") => ({
  type: "note" as const,
  id,
  from: "main",
  to: "a",
  content: "PEER_UNIQUE_NOTE",
});
function notes(m: AgentManager) {
  return m
    .session("a")
    .messages.filter(
      (x) => x.role === "custom" && x.customType === "pi-orche.note",
    );
}
describe("real AgentSession deterministic races", () => {
  it("NOTE mid-tool neither aborts nor forces another request and reaches next context", async () => {
    const entered = deferred();
    const release = deferred();
    let aborted = false;
    let context = "";
    const { m, faux } = await setup(
      [
        reply([call("work", {})], { stopReason: "toolUse" }),
        (c) => {
          context = JSON.stringify(c);
          return result();
        },
      ],
      [
        {
          name: "work",
          label: "work",
          description: "work",
          parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
            });
            entered.resolve();
            await release.promise;
            return {
              content: [{ type: "text", text: "success" }],
              details: {},
            };
          },
        },
      ],
    );
    m.assign("a", "explore", "start");
    await entered.promise;
    await m.send(note());
    release.resolve();
    const outcome = await m.wait("a", 1000);
    expect(outcome).toMatchObject({
      type: "outcome",
      outcome: { status: "completed", result: { summary: "done" } },
    });
    expect(aborted).toBe(false);
    expect(context).toContain("PEER_UNIQUE_NOTE");
    expect(faux.state.callCount).toBe(2);
    expect(notes(m)).toHaveLength(1);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("idle NOTE starts no turn; next assignment sees it, duplicate id once", async () => {
    let context = "";
    const { m, faux } = await setup([
      (c) => {
        context = JSON.stringify(c);
        return result();
      },
    ]);
    const message = { ...note("framed-note-718"), signal: { kind: "root_cause_found", cause: "stale token invalidation", confidence: 0.91 } };
    expect(await m.send(message)).toMatchObject({ status: "delivered" });
    expect(await m.send(message)).toMatchObject({ status: "duplicate" });
    expect(faux.state.callCount).toBe(0);
    m.assign("a", "next", "start");
    await m.wait("a", 1000);
    expect(context).toContain("PEER_UNIQUE_NOTE");
    expect(context).toContain("main");
    expect(context).toContain("framed-note-718");
    expect(context).toContain("NOTE");
    expect(context).toContain("informational");
    expect(context).toContain("root_cause_found");
    expect(context).toContain("stale token invalidation");
    expect(context).toContain("0.91");
    expect(notes(m)).toHaveLength(1);
  });
  for (const timing of ["tool", "message_end", "settled"] as const)
    it(`NOTE near terminal ${timing}: no continuation, one outcome`, async () => {
      const { m, faux } = await setup([result()]);
      let delivery: Promise<unknown> | undefined;
      const seen = deferred();
      if (timing === "tool") {
        const tool = m
          .session("a")
          .agent.state.tools.find((t) => t.name === "report_result")!;
        const execute = tool.execute;
        tool.execute = async (...args) => {
          delivery = m.send(note());
          await delivery;
          return execute(...args);
        };
      } else
        m.session("a").subscribe((e) => {
          if (
            !delivery &&
            ((timing === "message_end" &&
              e.type === "message_end" &&
              e.message.role === "assistant") ||
              (timing === "settled" && e.type === "agent_settled"))
          ) {
            delivery = m.send(note());
            seen.resolve();
          }
        });
      m.assign("a", "explore", "start");
      expect(await m.wait("a", 1000)).toMatchObject({
        type: "outcome",
        outcome: { status: "completed" },
      });
      await m.session("a").waitForIdle();
      await delivery;
      expect(faux.state.callCount).toBe(1);
      expect(notes(m)).toHaveLength(1);
      expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
    });
  it("REDIRECT mid-tool supersedes old once and completes new on same session", async () => {
    const entered = deferred();
    const cancelled = deferred();
    const { m } = await setup(
      [reply([call("work", {})], { stopReason: "toolUse" }), result("new")],
      [
        {
          name: "work",
          label: "work",
          description: "work",
          parameters: Type.Object({}),
          execute: async (_i, _a, signal) => {
            entered.resolve();
            signal?.addEventListener("abort", () => cancelled.resolve(), {
              once: true,
            });
            await cancelled.promise;
            return {
              content: [{ type: "text", text: "cancelled" }],
              details: {},
            };
          },
        },
      ],
    );
    const s = m.session("a");
    const old = m.assign("a", "explore", "OLD");
    await entered.promise;
    await m.send({
      type: "redirect",
      id: "r",
      from: "main",
      to: "a",
      kind: "fix",
      prompt: "NEW",
    });
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { assignmentId: old.id, status: "superseded" },
    });
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { kind: "fix", status: "completed", result: { summary: "new" } },
    });
    expect(m.session("a")).toBe(s);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("REDIRECT after accepted report before settle preserves result", async () => {
    const accepted = deferred();
    const release = deferred();
    const { m } = await setup([result("old"), result("new")]);
    const tool = m
      .session("a")
      .agent.state.tools.find((t) => t.name === "report_result")!;
    const execute = tool.execute;
    let first = true;
    tool.execute = async (...args) => {
      const value = await execute(...args);
      if (first) {
        first = false;
        accepted.resolve();
        await release.promise;
      }
      return value;
    };
    const old = m.assign("a", "old", "OLD");
    await accepted.promise;
    const redirect = m.send({
      type: "redirect",
      id: "r",
      from: "main",
      to: "a",
      kind: "new",
      prompt: "NEW",
    });
    const outcome = await m.wait("a", 1000);
    expect(outcome).toMatchObject({
      type: "outcome",
      outcome: {
        assignmentId: old.id,
        status: "completed",
        result: { summary: "old" },
      },
    });
    release.resolve();
    await redirect;
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "completed", result: { summary: "new" } },
    });
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("REDIRECT just after settle retains one old result and reuses context", async () => {
    let context = "";
    const { m } = await setup([
      result("old"),
      (c) => {
        context = JSON.stringify(c);
        return result("new");
      },
    ]);
    m.assign("a", "old", "SECRET_OLD");
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { result: { summary: "old" } },
    });
    await m.session("a").waitForIdle();
    await m.send({
      type: "redirect",
      id: "r",
      from: "main",
      to: "a",
      kind: "new",
      prompt: "NEW",
    });
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { result: { summary: "new" } },
    });
    expect(context).toContain("SECRET_OLD");
    expect(m.get("a")).toMatchObject({
      status: "idle",
      completedAssignments: 2,
    });
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("NOTE and REDIRECT during STOP retain NOTE and consume outcomes once", async () => {
    const entered = deferred();
    const aborting = deferred();
    const release = deferred();
    const { m } = await setup(
      [reply([call("work", {})], { stopReason: "toolUse" }), result("new")],
      [
        {
          name: "work",
          label: "work",
          description: "work",
          parameters: Type.Object({}),
          execute: async (_i, _a, signal) => {
            entered.resolve();
            signal?.addEventListener("abort", () => aborting.resolve(), {
              once: true,
            });
            await release.promise;
            return {
              content: [{ type: "text", text: "stopped" }],
              details: {},
            };
          },
        },
      ],
    );
    m.assign("a", "old", "OLD");
    await entered.promise;
    const stopping = m.stop("a");
    await aborting.promise;
    expect(m.get("a").status).toBe("stopping");
    await m.send(note());
    const redirect = m.send({
      type: "redirect",
      id: "r",
      from: "main",
      to: "a",
      kind: "new",
      prompt: "NEW",
    });
    release.resolve();
    await stopping;
    await redirect;
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "stopped" },
    });
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "completed" },
    });
    expect(notes(m)).toHaveLength(1);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("bounded waits and main inbox are separate from outcomes; peer sender policy", async () => {
    const { m } = await setup([result()]);
    expect(await m.wait("any", 2)).toEqual({ type: "timeout" });
    expect(
      await m.send({
        type: "redirect",
        id: "bad",
        from: "a",
        to: "a",
        kind: "x",
        prompt: "bad",
      }),
    ).toMatchObject({ status: "rejected" });
    await m.send({ ...note(), id: "inbox", from: "a", to: "main" });
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
    expect(await m.wait(["a"], 0)).toEqual({ type: "timeout" });
    m.assign("a", "work", "start");
    expect(await m.wait(["a"], 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "completed" },
    });
    expect(await m.wait("any", 10)).toMatchObject({
      type: "message",
      message: { id: "inbox" },
    });
  });
  it("three workers maintain independent contexts across sequential reuse; usage observed", async () => {
    const m = new AgentManager();
    managers.push(m);
    const events: ManagerEvent[] = [];
    m.subscribe((e) => events.push(e));
    const contexts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = await fauxRuntime([
        result(),
        (c) => {
          contexts[i] = JSON.stringify(c);
          return result();
        },
      ]);
      await m.spawn({
        id: `w${i}`,
        role: "test",
        route: f.route,
        modelRuntime: f.runtime,
        cwd: process.cwd(),
        instructions: "test",
        tools: [],
      });
      m.assign(`w${i}`, "first", `SECRET_WORKER_${i}`);
    }
    for (let i = 0; i < 3; i++) await m.wait(`w${i}`, 1000);
    for (let i = 0; i < 3; i++) {
      await m.session(`w${i}`).waitForIdle();
      m.assign(`w${i}`, "second", "recall");
    }
    for (let i = 0; i < 3; i++) {
      await m.wait(`w${i}`, 1000);
      expect(contexts[i]).toContain(`SECRET_WORKER_${i}`);
      for (let j = 0; j < 3; j++)
        if (i !== j) expect(contexts[i]).not.toContain(`SECRET_WORKER_${j}`);
      expect(m.get(`w${i}`).completedAssignments).toBe(2);
    }
    expect(events.filter((e) => e.type === "usage")).toHaveLength(6);
  });
  it("settles without report as no_result and model errors as failed", async () => {
    const { m, faux } = await setup([reply("ordinary answer")], [], { resultNudges: 0 });
    m.assign("a", "first", "start");
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "no_result", lastText: "ordinary answer" },
    });
    await m.session("a").waitForIdle();
    faux.setResponses([
      reply("failure", {
        stopReason: "error",
        errorMessage: "invalid request",
      }),
    ]);
    m.assign("a", "second", "start");
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: { status: "failed", error: "invalid request" },
    });
  });
  it("first report wins in a duplicate tool batch, rejected later report cannot replace it", async () => {
    const { m, faux } = await setup([
      reply(
        [
          call("report_result", { kind: "first", summary: "FIRST" }),
          call("report_result", { kind: "second", summary: "SECOND" }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    m.assign("a", "batch", "start");
    expect(await m.wait("a", 1000)).toMatchObject({
      type: "outcome",
      outcome: {
        status: "completed",
        result: { kind: "first", summary: "FIRST" },
      },
    });
    expect(faux.state.callCount).toBe(1);
    expect(
      m
        .session("a")
        .messages.filter((x) => x.role === "toolResult" && x.isError),
    ).toHaveLength(1);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("successful bounded auto-retry completes rather than retaining a transient failure", async () => {
    const { m, faux } = await setup([
      reply("temporary", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
      result("recovered"),
    ]);
    m.assign("a", "retry", "start");
    expect(await m.wait("a", 3000)).toMatchObject({
      type: "outcome",
      outcome: { status: "completed", result: { summary: "recovered" } },
    });
    expect(faux.state.callCount).toBe(2);
  });
  it("fork-join worker cannot call send_message when peer messaging is disabled", async () => {
    let request = "";
    const f = await fauxRuntime([context => { request = JSON.stringify(context); return result(); }]);
    const m = new AgentManager(f.runtime);
    managers.push(m);
    await m.spawn({ id: "a", role: "baseline", route: f.route, cwd: process.cwd(), instructions: "Report your finding.", tools: [], peerMessaging: false });
    expect(m.session("a").getToolDefinition("send_message")).toBeUndefined();
    expect(m.session("a").agent.state.tools.map(tool => tool.name)).not.toContain("send_message");
    m.assign("a", "baseline", "investigate");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: "completed" } });
    expect(request).not.toContain("send_message");
  });
  it("rejects self-addressed messages without transcript or delivery side effects", async () => {
    const { m } = await setup([]);
    const before = [...m.session("a").messages];
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    const messages = [
      { ...note("self-note"), from: "a" },
      { type: "redirect" as const, id: "self-redirect", from: "a", to: "a", kind: "work", prompt: "new" },
      { type: "stop" as const, id: "self-stop", from: "a", to: "a" },
    ];
    for (const message of messages)
      expect(await m.send(message)).toMatchObject({ status: "rejected", reason: "self-addressed" });
    expect(m.session("a").messages).toEqual(before);
    expect(events.filter(event => event.type === "message_delivered")).toEqual([]);
    expect(m.get("a").status).toBe("idle");
  });
  it("nudges a missing result once and completes under the same assignment identity", async () => {
    const { m, faux } = await setup([reply("ordinary answer"), result("nudged result")]);
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    const assignment = m.assign("a", "backlog_proposal", "start");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: assignment.id, status: "completed", result: { summary: "nudged result" } } });
    expect(events.filter(event => event.type === "assignment_nudged")).toMatchObject([{ agentId: "a", assignmentId: assignment.id, attempt: 1 }]);
    expect(events.filter(event => event.type === "assignment_outcome")).toHaveLength(1);
    expect(events.filter(event => event.type === "assignment_started")).toHaveLength(1);
    expect(events.filter(event => event.type === "usage").map(event => event.assignmentId)).toEqual([assignment.id, assignment.id]);
    expect(m.get("a").completedAssignments).toBe(1);
    expect(faux.state.callCount).toBe(2);
    expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
  });
  it("a nudge that also omits a report produces only one final no_result", async () => {
    const { m, faux } = await setup([reply("initial"), reply("last unreported answer")]);
    const events: ManagerEvent[] = [];
    m.subscribe(event => events.push(event));
    const assignment = m.assign("a", "explore", "start");
    expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: assignment.id, status: "no_result", lastText: "last unreported answer" } });
    expect(events.filter(event => event.type === "assignment_nudged")).toHaveLength(1);
    expect(events.filter(event => event.type === "assignment_outcome")).toHaveLength(1);
    expect(faux.state.callCount).toBe(2);
  });
  for (const action of ["redirect", "stop", "note"] as const)
    it(`${action.toUpperCase()} during nudge preserves interruption and context-only semantics`, async () => {
      const entered = deferred();
      const release = deferred();
      let aborted = false;
      let finalContext = "";
      const { m, faux } = await setup([
        reply("initial without report"),
        reply([call("work", {})], { stopReason: "toolUse" }),
        context => { finalContext = JSON.stringify(context); return result("final"); },
      ], [{
        name: "work", label: "work", description: "work", parameters: Type.Object({}),
        execute: async (_id, _args, signal) => {
          signal?.addEventListener("abort", () => { aborted = true; release.resolve(); }, { once: true });
          entered.resolve();
          await release.promise;
          return { content: [{ type: "text", text: "work finished" }], details: {} };
        },
      }]);
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      const old = m.assign("a", "old", "start");
      await entered.promise;
      if (action === "redirect")
        await m.send({ type: "redirect", id: "nudge-redirect", from: "main", to: "a", kind: "new", prompt: "NEW" });
      else if (action === "stop")
        await m.stop("a");
      else {
        await m.send(note("during-nudge"));
        expect(aborted).toBe(false);
        release.resolve();
      }
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { assignmentId: old.id, status: action === "redirect" ? "superseded" : action === "stop" ? "stopped" : "completed" } });
      if (action === "redirect")
        expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { kind: "new", status: "completed" } });
      if (action === "note") {
        expect(finalContext).toContain("PEER_UNIQUE_NOTE");
        expect(notes(m)).toHaveLength(1);
      }
      expect(events.filter(event => event.type === "assignment_nudged")).toHaveLength(1);
      expect(events.filter(event => event.type === "assignment_outcome")).toHaveLength(action === "redirect" ? 2 : 1);
      expect(faux.state.callCount).toBe(action === "stop" ? 2 : 3);
      expect(await m.wait("a", 0)).toEqual({ type: "timeout" });
    });
  it("disabled nudges retain no_result behavior and model errors are never nudged", async () => {
    for (const failed of [false, true]) {
      const { m, faux } = await setup([failed ? reply("failure", { stopReason: "error", errorMessage: "invalid request" }) : reply("unreported")], [], { resultNudges: failed ? 1 : 0 });
      const events: ManagerEvent[] = [];
      m.subscribe(event => events.push(event));
      m.assign("a", "explore", "start");
      expect(await m.wait("a", 1000)).toMatchObject({ type: "outcome", outcome: { status: failed ? "failed" : "no_result" } });
      expect(events.filter(event => event.type === "assignment_nudged")).toEqual([]);
      expect(faux.state.callCount).toBe(1);
    }
  });
});
