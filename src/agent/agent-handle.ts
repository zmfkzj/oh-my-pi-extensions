import type { SessionOptions } from "../pi/session-factory.js";
import type {
  NoteMessage,
  DeliveryReceipt,
  OrcheMessage,
} from "../messaging/message.js";
export interface ResultPayload {
  kind: string;
  summary: string;
  data?: unknown;
}
export interface Assignment {
  id: string;
  kind: string;
  prompt: string;
  epoch: number;
}
export interface Outcome {
  agentId: string;
  assignmentId: string;
  kind: string;
  status: "completed" | "superseded" | "stopped" | "no_result" | "failed";
  result?: ResultPayload;
  lastText?: string;
  error?: string;
  timestamp: number;
}
export interface AgentSnapshot {
  id: string;
  role: string;
  route: SessionOptions["route"];
  status: "idle" | "running" | "stopping" | "disposed";
  currentAssignment?: Assignment;
  completedAssignments: number;
}
export interface SpawnOptions extends SessionOptions {
  id: string;
  role: string;
  peerMessaging?: boolean;
}
export interface AgentManagerOptions {
  resultNudges?: number;
}
export type ManagerEvent = { timestamp: number } & (
  | { type: "assignment_started"; agentId: string; assignment: Assignment }
  | { type: "assignment_nudged"; agentId: string; assignmentId: string; attempt: number }
  | { type: "assignment_outcome"; outcome: Outcome }
  | { type: "message_sent"; message: OrcheMessage }
  | {
      type: "message_delivered";
      message: OrcheMessage;
      receipt: DeliveryReceipt;
    }
  | {
      type: "usage";
      agentId: string;
      assignmentId: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
);
export type WaitResult =
  | { type: "outcome"; outcome: Outcome }
  | { type: "message"; message: NoteMessage }
  | { type: "timeout" };
export interface AgentHandle {
  readonly id: string;
  assign(kind: string, prompt: string): Assignment;
  stop(): Promise<void>;
  get(): AgentSnapshot;
}
