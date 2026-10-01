import type { RunEvent } from "../orchestration/events.js";

/** One short human line per notable run event; undefined for events that are not worth showing. */
export function describeProgress(event: RunEvent): string | undefined {
  switch (event.type) {
    case "request_classified":
      return `classified as ${event.taskClass} with ${event.workerCount} worker${event.workerCount === 1 ? "" : "s"}`;
    case "phase_changed":
      return `phase ${event.to}`;
    case "root_cause_accepted":
      return `root cause accepted from ${event.agentId}`;
    case "backlog_created":
      return `backlog of ${event.tasks.length} task${event.tasks.length === 1 ? "" : "s"}`;
    case "task_dispatched":
      return `${event.agentId} started ${event.taskId}`;
    case "task_finished":
      return `${event.taskId} ${event.status}`;
    case "verification":
      return `verification ${event.passed ? "passed" : "failed"} (round ${event.round})`;
    case "ownership_violation":
      return `ownership violation: ${event.agentId} wrote ${event.file}`;
    case "advisor_result":
      return event.verdict === "ok" ? undefined : `advisor ${event.name}: ${event.verdict}`;
    case "advisor_failed":
      return `advisor ${event.name} failed: ${event.reason}`;
    default:
      return undefined;
  }
}
