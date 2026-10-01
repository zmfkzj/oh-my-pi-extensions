import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { runOrchestrated, type RunReport } from "../orchestration/coordinator.js";
import type { RunEvent } from "../orchestration/events.js";
import { describeSource, discoverOrcheConfig, NoRouteError, type ConfigSource } from "./config.js";
import { describeProgress } from "./progress.js";

export class OrcheBusyError extends Error {
  override readonly name = "OrcheBusyError";
  constructor() {
    super("An orche run is already active in this session; wait for it to finish or cancel it (/orche cancel).");
  }
}

export interface OrcheRunArgs {
  request: string;
  cwd: string;
  /** The Pi session's current model (`ctx.model`) and thinking level. */
  model?: { provider: string; id: string };
  thinking?: ThinkingLevel;
  projectTrusted: boolean;
  /** Tool/command cancellation. */
  signal?: AbortSignal;
  /** Receives the latest progress lines (newest last) whenever one is added. */
  onProgress?: (lines: readonly string[]) => void;
}
export interface OrcheRunDetails {
  status: RunReport["status"];
  taskClass: RunReport["taskClass"];
  durationMs: number;
  config: string;
  ignoredConfigs: readonly string[];
  tasks: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  advisorRequests: number;
  /** The run ended because it was cancelled (by `/orche cancel`, the tool's abort signal or shutdown). */
  cancelled: boolean;
  progress: readonly string[];
}
export interface OrcheOutcome {
  report: RunReport;
  /** Final user-facing text: the answer on success, the failure summary otherwise. */
  text: string;
  details: OrcheRunDetails;
  /** The cancellation came from `/orche cancel`. */
  cancelledByUser: boolean;
  source: ConfigSource;
}
export interface OrcheControllerOptions {
  /** Defaults to Pi's agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). */
  agentDir?: string;
  /** Defaults to `ModelRuntime.create()`: Pi's file-backed credentials. */
  createRuntime?: () => Promise<ModelRuntime>;
  /** Test seam for the run itself. */
  run?: typeof runOrchestrated;
}
const PROGRESS_LINES = 8;

/**
 * One orche run at a time per Pi session. The runtime is created lazily once and shared by every run,
 * through Pi's public, file-backed `ModelRuntime`.
 */
export class OrcheController {
  private active: { abort: AbortController; cancelledByUser: boolean; done: Promise<unknown> } | undefined;
  private runtime: Promise<ModelRuntime> | undefined;

  constructor(private readonly options: OrcheControllerOptions = {}) {}

  get busy(): boolean {
    return this.active !== undefined;
  }
  /** Cancel the active run on the user's behalf, if any. Returns whether there was one. */
  cancel(): boolean {
    if (!this.active) return false;
    this.active.cancelledByUser = true;
    this.active.abort.abort();
    return true;
  }
  /** Resolves once the active run (if any) has fully ended and its sessions are disposed. */
  async whenIdle(): Promise<void> {
    await this.active?.done.catch(() => undefined);
  }

  private modelRuntime(): Promise<ModelRuntime> {
    const created = (this.runtime ??= (this.options.createRuntime ?? (() => ModelRuntime.create()))());
    created.catch(() => {
      this.runtime = undefined;
    });
    return created;
  }

  async run(args: OrcheRunArgs): Promise<OrcheOutcome> {
    if (this.active) throw new OrcheBusyError();
    const abort = new AbortController();
    const signal = args.signal ? AbortSignal.any([args.signal, abort.signal]) : abort.signal;
    const state = { abort, cancelledByUser: false, done: Promise.resolve() as Promise<unknown> };
    this.active = state;
    const execution = this.execute(args, signal);
    state.done = execution;
    try {
      const outcome = await execution;
      return { ...outcome, cancelledByUser: state.cancelledByUser && outcome.details.cancelled };
    } finally {
      this.active = undefined;
    }
  }

  private async execute(args: OrcheRunArgs, signal: AbortSignal): Promise<OrcheOutcome> {
    const sessionModel = args.model ? `${args.model.provider}/${args.model.id}` : undefined;
    const config = await discoverOrcheConfig({
      cwd: args.cwd,
      agentDir: this.options.agentDir ?? getAgentDir(),
      projectTrusted: args.projectTrusted,
      session: { model: sessionModel, thinking: args.thinking },
    });
    const runtime = await this.modelRuntime();
    if (config.source.kind === "session" && args.model && !runtime.getModel(args.model.provider, args.model.id)) {
      throw new NoRouteError(
        `The session model ${sessionModel} cannot be resolved by orche's file-backed model runtime (providers registered by other extensions or in-memory credentials are not shared). Route orche explicitly in ${args.cwd}/.pi/orche.config.json (see docs/pi-package.md).`,
      );
    }
    const progress: string[] = [];
    const totals = { requests: 0, inputTokens: 0, outputTokens: 0, advisorRequests: 0 };
    const sink = (event: RunEvent) => {
      if (event.type === "usage" || event.type === "coordinator_usage" || event.type === "advisor_usage") {
        totals.requests++;
        totals.inputTokens += event.input;
        totals.outputTokens += event.output;
        if (event.type === "advisor_usage") totals.advisorRequests++;
      }
      const line = describeProgress(event);
      if (!line) return;
      progress.push(line);
      args.onProgress?.(progress.slice(-PROGRESS_LINES));
    };
    const report = await (this.options.run ?? runOrchestrated)({
      problem: args.request,
      cwd: args.cwd,
      routes: config.routes,
      modelRuntime: runtime,
      signal,
      sink,
    });
    const text = report.status === "done" ? report.answer : report.summary;
    return {
      report,
      text,
      source: config.source,
      cancelledByUser: false,
      details: {
        status: report.status,
        taskClass: report.taskClass,
        durationMs: report.finishedAt - report.startedAt,
        config: describeSource(config.source),
        ignoredConfigs: config.ignored,
        tasks: report.tasks.length,
        ...totals,
        cancelled: signal.aborted && report.status === "failed" && report.summary === "cancelled",
        progress: progress.slice(-PROGRESS_LINES),
      },
    };
  }
}

/** Text shown to the user and the main model for a finished run. */
export function formatOutcome(outcome: OrcheOutcome): string {
  const { details, report } = outcome;
  const seconds = Math.round(details.durationMs / 1000);
  const head = details.cancelled
    ? `orche CANCELLED${outcome.cancelledByUser ? " by user" : ""} (${seconds}s; ${details.config})`
    : report.status === "done"
      ? `orche finished (${details.taskClass}, ${seconds}s, ${details.requests} model requests; ${details.config})`
      : `orche FAILED (${details.taskClass}, ${seconds}s; ${details.config})`;
  return `${head}\n\n${outcome.text}`;
}
