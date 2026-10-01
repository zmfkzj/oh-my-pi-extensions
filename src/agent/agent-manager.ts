import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type {
  AgentSession,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSession } from "../pi/session-factory.js";
import { SessionAdapter } from "../pi/session-adapter.js";
import { WORKER_TOOL_NAMES } from "../tools/index.js";
import { MessageRouter } from "../messaging/message-router.js";
import type {
  DeliveryReceipt,
  NoteMessage,
  OrcheMessage,
} from "../messaging/message.js";
import type {
  AgentManagerOptions,
  AgentHandle,
  AgentSnapshot,
  Assignment,
  ManagerEvent,
  Outcome,
  ResultPayload,
  SpawnOptions,
  WaitResult,
} from "./agent-handle.js";
interface Worker {
  snapshot: AgentSnapshot;
  adapter: SessionAdapter;
  epoch: number;
  nudges: number;
  runAssignment?: Assignment;
  result?: ResultPayload;
  failure?: string;
  abort?: Promise<void>;
  unsubscribe: () => void;
}
export class AgentManager {
  private readonly workers = new Map<string, Worker>();
  private readonly listeners = new Set<(event: ManagerEvent) => void>();
  private readonly wake = new Set<() => void>();
  private readonly outcomes: Outcome[] = [];
  private readonly inbox: NoteMessage[] = [];
  private readonly router = new MessageRouter(
    (id) => id === "main" || this.workers.has(id),
    (message) => this.deliver(message),
  );
  private modelRuntime: Promise<ModelRuntime> | undefined;
  private readonly resultNudges: number;
  constructor(modelRuntime?: ModelRuntime, options: AgentManagerOptions = {}) {
    this.resultNudges = options.resultNudges ?? 1;
    if (!Number.isSafeInteger(this.resultNudges) || this.resultNudges < 0)
      throw new Error("resultNudges must be a nonnegative safe integer");
    this.modelRuntime = modelRuntime ? Promise.resolve(modelRuntime) : undefined;
  }
  async spawn(options: SpawnOptions): Promise<AgentHandle> {
    if (options.id === "main" || this.workers.has(options.id))
      throw new Error(`Reserved or duplicate agent id: ${options.id}`);
    let worker: Worker;
    const report: ToolDefinition = {
      name: "report_result",
      label: "Report result",
      description:
        "Complete the current assignment. First result wins. Call alone, not alongside other tools.",
      parameters: Type.Object({
        kind: Type.String(),
        summary: Type.String(),
        data: Type.Optional(Type.Unknown()),
      }),
      execute: async (_id, args) => {
        if (
          !worker.snapshot.currentAssignment ||
          worker.snapshot.status !== "running" ||
          worker.result
        )
          return {
            content: [
              {
                type: "text",
                text: "Result rejected: assignment inactive or already reported",
              },
            ],
            details: { accepted: false },
            isError: true,
            terminate: true,
          };
        worker.result = args as ResultPayload;
        return {
          content: [
            { type: "text", text: "Result accepted; assignment complete" },
          ],
          details: { accepted: true },
          terminate: true,
        };
      },
    };
    const send: ToolDefinition = {
      name: "send_message",
      label: "Send NOTE",
      description:
        "Send information to a peer or main without interrupting its tools.",
      parameters: Type.Object({
        to: Type.String(),
        content: Type.String(),
        signal: Type.Optional(
          Type.Object({
            kind: Type.String(),
            cause: Type.Optional(Type.String()),
            evidence: Type.Optional(Type.Unknown()),
            confidence: Type.Optional(Type.Number()),
            data: Type.Optional(Type.Unknown()),
          }),
        ),
      }),
      execute: async (_id, args) => {
        const payload = args as {
          to: string;
          content: string;
          signal?: NoteMessage["signal"];
        };
        const receipt = await this.send({
          id: randomUUID(),
          from: options.id,
          type: "note",
          ...payload,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          details: receipt,
          isError: receipt.status === "rejected",
        };
      },
    };
    const tools = [
      ...(options.tools ?? WORKER_TOOL_NAMES),
      "report_result",
      ...(options.peerMessaging === false ? [] : ["send_message"]),
    ];
    const session = await createSession({
      ...options,
      modelRuntime: options.modelRuntime ?? await (this.modelRuntime ??= ModelRuntime.create()),
      tools,
      customTools: [...(options.customTools ?? []), report, ...(options.peerMessaging === false ? [] : [send])],
      instructions: `${options.instructions}\nComplete assignments with report_result.${options.peerMessaging === false ? "" : " Send peers information using send_message."} NOTES are informational, not new assignments.`,
    });
    const adapter = new SessionAdapter(session);
    worker = {
      snapshot: {
        id: options.id,
        role: options.role,
        route: options.route,
        status: "idle",
        completedAssignments: 0,
      },
      adapter,
      epoch: 0,
      nudges: 0,
      unsubscribe: () => {},
    };
    worker.unsubscribe = adapter.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const assignment = worker.runAssignment;
        if (assignment) {
          const u = event.message.usage;
          this.emit({
            type: "usage",
            timestamp: Date.now(),
            agentId: options.id,
            assignmentId: assignment.id,
            model: `${event.message.provider}/${event.message.model}`,
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
          });
          worker.failure =
            event.message.stopReason === "error"
              ? (event.message.errorMessage ?? "Model error")
              : undefined;
        }
      } else if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "pi-orche.note"
      ) {
        const message = event.message.details as NoteMessage;
        this.emit({
          type: "message_delivered",
          timestamp: Date.now(),
          message,
          receipt: { id: message.id, status: "delivered", mode: "context" },
        });
      } else if (event.type === "agent_settled") {
        worker.runAssignment = undefined;
        const assignment = worker.snapshot.currentAssignment;
        if (assignment && worker.snapshot.status === "running" && !worker.result && !worker.failure && worker.nudges < this.resultNudges) {
          worker.nudges++;
          this.emit({ type: "assignment_nudged", timestamp: Date.now(), agentId: options.id, assignmentId: assignment.id, attempt: worker.nudges });
          this.runAssignment(worker, assignment, `You ended without calling report_result for assignment ${assignment.kind}. Call report_result alone now with your result.`);
        } else {
          this.finalize(worker, worker.failure ? "failed" : worker.result ? "completed" : "no_result");
        }
      }
    });
    this.workers.set(options.id, worker);
    return {
      id: options.id,
      assign: (kind, prompt) => this.assign(options.id, kind, prompt),
      stop: () => this.stop(options.id),
      get: () => this.get(options.id),
    };
  }
  assign(agentId: string, kind: string, prompt: string): Assignment {
    const w = this.require(agentId);
    if (w.snapshot.status !== "idle")
      throw new Error(`Agent ${agentId} is ${w.snapshot.status}`);
    const assignment = { id: randomUUID(), kind, prompt, epoch: ++w.epoch };
    w.snapshot.currentAssignment = assignment;
    w.runAssignment = assignment;
    w.snapshot.status = "running";
    w.result = undefined;
    w.failure = undefined;
    w.nudges = 0;
    this.emit({
      type: "assignment_started",
      timestamp: Date.now(),
      agentId,
      assignment,
    });
    this.runAssignment(w, assignment, prompt);
    return assignment;
  }
  private runAssignment(w: Worker, assignment: Assignment, prompt: string): void {
    void Promise.resolve().then(async () => {
      await w.adapter.session.waitForIdle();
      if (
        w.snapshot.currentAssignment !== assignment ||
        w.snapshot.status !== "running"
      )
        return;
      w.runAssignment = assignment;
      try {
        await w.adapter.run(prompt);
      } catch (error) {
        if (w.snapshot.currentAssignment === assignment) {
          w.failure = String(error);
          this.finalize(w, "failed");
        }
      }
    });
  }
  send(message: OrcheMessage): Promise<DeliveryReceipt> {
    return this.router.send(message);
  }
  private async deliver(message: OrcheMessage): Promise<DeliveryReceipt> {
    this.emit({ type: "message_sent", timestamp: Date.now(), message });
    if (message.type === "note") {
      if (message.to === "main") {
        this.inbox.push(message);
        const receipt: DeliveryReceipt = {
          id: message.id,
          status: "delivered",
          mode: "inbox",
        };
        this.emit({
          type: "message_delivered",
          timestamp: Date.now(),
          message,
          receipt,
        });
        return receipt;
      }
      const w = this.require(message.to);
      if (w.snapshot.status === "disposed")
        return {
          id: message.id,
          status: "rejected",
          mode: "context",
          reason: "Agent disposed",
        };
      await w.adapter.note(message);
      return { id: message.id, status: "delivered", mode: "context" };
    }
    const w = this.require(message.to);
    const mode = message.type === "stop" ? "abort" : "abort-prompt";
    if (w.snapshot.status === "disposed")
      return {
        id: message.id,
        status: "rejected",
        mode,
        reason: "Agent disposed",
      };
    await this.interrupt(w, message.type === "stop" ? "stopped" : "superseded");
    if (message.type === "redirect")
      this.assign(message.to, message.kind, message.prompt);
    const receipt: DeliveryReceipt = {
      id: message.id,
      status: "delivered",
      mode,
    };
    this.emit({
      type: "message_delivered",
      timestamp: Date.now(),
      message,
      receipt,
    });
    return receipt;
  }
  async stop(agentId: string): Promise<void> {
    await this.interrupt(this.require(agentId), "stopped");
  }
  private async interrupt(
    w: Worker,
    status: "stopped" | "superseded",
  ): Promise<void> {
    if (w.abort) {
      await w.abort;
      return;
    }
    if (w.snapshot.status === "idle" || w.snapshot.status === "disposed")
      return;
    w.snapshot.status = "stopping";
    ++w.epoch;
    this.finalize(w, w.result ? "completed" : status, false);
    const pending = w.adapter.abort();
    w.abort = pending;
    try {
      await pending;
    } finally {
      w.abort = undefined;
      w.runAssignment = undefined;
      w.snapshot.status = "idle";
    }
  }
  private finalize(w: Worker, status: Outcome["status"], idle = true): void {
    const a = w.snapshot.currentAssignment;
    if (!a) return;
    const outcome: Outcome = {
      agentId: w.snapshot.id,
      assignmentId: a.id,
      kind: a.kind,
      status,
      timestamp: Date.now(),
      ...(w.result ? { result: w.result } : {}),
      ...(status === "no_result" ? { lastText: w.adapter.lastText } : {}),
      ...(w.failure ? { error: w.failure } : {}),
    };
    w.snapshot.currentAssignment = undefined;
    w.snapshot.completedAssignments++;
    if (idle && w.snapshot.status !== "stopping") w.snapshot.status = "idle";
    w.result = undefined;
    w.failure = undefined;
    this.outcomes.push(outcome);
    this.emit({
      type: "assignment_outcome",
      timestamp: outcome.timestamp,
      outcome,
    });
  }
  async wait(
    target: string | string[] | "any" = "any",
    timeoutMs = 30000,
  ): Promise<WaitResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new Error("wait timeout must be finite and nonnegative");
    const take = (): WaitResult | undefined => {
      const index = this.outcomes.findIndex(
        (o) =>
          target === "any" ||
          (Array.isArray(target)
            ? target.includes(o.agentId)
            : target === o.agentId),
      );
      if (index >= 0)
        return { type: "outcome", outcome: this.outcomes.splice(index, 1)[0]! };
      const message = target === "any" ? this.inbox.shift() : undefined;
      return message ? { type: "message", message } : undefined;
    };
    const available = take();
    if (available) return available;
    const { promise, resolve } = Promise.withResolvers<WaitResult>();
    const onWake = () => {
      const result = take();
      if (result) {
        clearTimeout(timer);
        this.wake.delete(onWake);
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      this.wake.delete(onWake);
      resolve({ type: "timeout" });
    }, timeoutMs);
    this.wake.add(onWake);
    onWake();
    return promise;
  }
  get(id: string): AgentSnapshot {
    const s = this.require(id).snapshot;
    return {
      ...s,
      route: { ...s.route },
      currentAssignment: s.currentAssignment
        ? { ...s.currentAssignment }
        : undefined,
    };
  }
  list(): AgentSnapshot[] {
    return [...this.workers.keys()].map((id) => this.get(id));
  }
  subscribe(listener: (event: ManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: ManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Observers cannot alter worker lifecycle. */
      }
    }
    for (const wake of [...this.wake]) wake();
  }
  private require(id: string): Worker {
    const w = this.workers.get(id);
    if (!w) throw new Error(`Unknown agent: ${id}`);
    return w;
  }
  session(id: string): AgentSession {
    return this.require(id).adapter.session;
  }
  async dispose(agentId?: string): Promise<void> {
    for (const w of agentId ? [this.require(agentId)] : this.workers.values()) {
      await this.stop(w.snapshot.id);
      w.unsubscribe();
      w.adapter.dispose();
      w.snapshot.status = "disposed";
    }
  }
}
