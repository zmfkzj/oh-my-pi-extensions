# pi-orche

A thin MPLM-style multi-agent coding orchestrator on Pi SDK 0.99.1. A read-only LLM coordinator first classifies the instruction and chooses one to three persistent workers proportionately. Questions and reviews produce evidence-backed answers without editing; clear changes go directly to implementation; unexplained defects use investigation, early convergence and worker reuse. Every change is independently verified, with one bounded fix round if necessary.

## Run

Requires Node.js, installed dependencies (`npm install`), and Pi credentials for the configured routes. Credentials use Pi's shared file-backed model runtime; this project does not change global Pi settings, persist model/thinking selections, or fork Pi. Change/diagnosis runs edit the supplied workspace: use a clean disposable copy when experimenting. Answer-class workers receive only read/grep/find/ls tools, never edit/write/bash.

```sh
npx tsx src/cli.ts --cwd /path/to/project --problem 'Analyze and fix the reported bug' --events events.jsonl
npx tsx src/cli.ts --cwd /path/to/project --problem-file ISSUE.md --config orche.config.json --route coordinator=openai/gpt-6.1-sol:high
```

The CLI prints a JSON final report and exits nonzero on failure. `--route` is repeatable; provider/model/thinking routing belongs exclusively in configuration. All default roles use `openai/gpt-6.1-sol` at `high`. A route config with `routes: {}` and a `default` covers every role, including `coordinator`, `analyst`, `implementer`, `explorer-path`, `explorer-cause`, `explorer-repro`, and `verifier`.

Programmatic entry point: `runOrchestrated({problem, cwd, routes, sink?, modelRuntime?, limits?, baseSystemPrompt?, signal?})`. `signal` cancels the run: sessions are stopped and disposed and a failed report with summary `cancelled` is returned. `baseSystemPrompt` replaces Pi's default base prompt in the coordinator and every worker session (advisors and judges keep their own); absent = Pi default. JSONL events include worker usage, coordinator usage, advisor triggers/results/usage, messages, assignment outcomes, phase changes, backlog ownership, and verification. Reports include ownership violations as decomposition failures, not silently approved writes. The audit observes Pi edit/write tools; shell-mediated writes are not intercepted. Workers must respect ownership themselves—there are no locks.
`RunReport.taskClass` is `answer`, `change`, or `diagnose_fix` (`unclassified` only if classification fails); `RunReport.answer` is the full user-facing answer or a concise change/verification report, in the user's language. `request_classified` events record class, worker count, language and reason.
For read-only requests, the coordinator can approve `answer_from_worker` to pass an existing complete worker answer through unchanged; it only generates full answer text when substantive edits or multi-worker synthesis are needed.
During implementation/fixes, file ownership is per worker across all of that worker's current backlog tasks, not just its active task. Writes during exploration or proposal collection, and implementation writes to unowned or another worker's files, are decomposition failures. Violation events identify every backlog task whose file area contains the path.
Ownership accepts concrete repository-relative files and recursive directory areas: `src/`, `src/**` and `src/**/*` all canonicalize to `src/` before overlap validation and write auditing. Other glob patterns are rejected during backlog validation rather than misinterpreted as literal file names.

Default overall budget: 600 seconds. Unless individually overridden, exploration gets one third of the configured overall budget, each assignment wait can use the remaining overall budget, and each coordinator decision gets half of the overall budget (300 seconds at the default). Every cap is clamped to the time remaining in the run; explicit finite caps are honored within that bound. For a 900-second task this means exploration 300 seconds, decisions up to 450 seconds, and assignments bounded by the remaining task time. Decision repairs remain capped at two re-prompts and verification at one fix round. All sessions are disposed in `finally`. Pi abort requires tool cooperation; arbitrary JavaScript tools ignoring abort cannot be forcibly killed by this wrapper. There is no provider fallback.

### Install into Pi

```sh
pi install /path/to/pi-orche     # after `npm install` here; uninstall with: pi remove /path/to/pi-orche
```

Every normal `pi` session then has anchored `read`/`edit` (replacing Pi's), `find`, `ast_search`, `ast_rewrite`, `diagnostics`, `grep`, `ls`, long-output spill, `/orche single <PROMPT>` (the current session's agent handles the prompt as a normal user turn with these tools, no orchestration), `/orche multi <PROMPT>` (runs the multi-agent orchestrator on the session cwd and posts the result into the conversation; `/orche cancel` stops the active multi run or `orche_run` call; any other form prints `Usage: /orche single|multi <PROMPT> | /orche cancel` and does nothing), and an `orche_run` tool the main model can call (always multi). Model routing comes from `.pi/orche.config.json`, `~/.pi/agent/orche.config.json`, or the session's current model. Details, limitations and the auth model: [docs/pi-package.md](docs/pi-package.md).

## Architecture

- `src/pi/`: Pi session factory and runtime adapter; persistent contexts, lifecycle events, abort and context-only messages.
- `src/agent/`: AgentManager; assignment epochs, exactly-once outcomes, NOTE inbox, direct peer messaging, shared authenticated runtime.
- `src/messaging/`: typed NOTE / REDIRECT / STOP messages and process-local ID deduplication.
- `src/orchestration/phases.ts`, `backlog.ts`, `routing.ts`: pure transitions, proposal deduplication, ownership/dependency validation and model routing.
- `src/orchestration/coordinator.ts`, `prompts.ts`, `events.ts`: small LLM-driven phase loop, structured decision tools, worker protocols and shared event contract.
- `src/advisor/`: configurable multi-advisor (triggers, domains, budgets) with the OMP plan-review and verification-audit roles as presets; see [docs/advisor.md](docs/advisor.md).
- `src/extension/`: the Pi package entry (`/orche`, `orche_run`, tool replacement, spill hook), config discovery and the single-run controller; see [docs/pi-package.md](docs/pi-package.md).
- `src/eval/`: visible-only problem-A workspaces, isolated hidden grading, fork-join baseline, metrics and benchmark runner. Hidden grading data never enters worker prompts or workspaces.
- `test/`: pure tests plus deterministic real-AgentSession faux-provider lifecycle and coordinator regressions.

Every phase change goes through the pure `transition()` function. Classification selects one of these paths:

| Class | Workers and phases | Result |
| --- | --- | --- |
| `answer` | 1–3 read-only analysts; `EXPLORE → DONE` | Evidence-backed explanation, analysis or review; no implementation or verification assignments; no authorized writes. |
| `change` | 1–3 implementers; `EXPLORE → BACKLOG → EXECUTE → VERIFY → DONE` | Direct canonical backlog; no root-cause exploration/proposals. A trivial one-line edit uses one implementer. |
| `diagnose_fix` | 1–3 explorers; `EXPLORE → CONVERGE → BACKLOG → EXECUTE → VERIFY → DONE` | Early root-cause acceptance, preemption, proposals and reused worker implementation. |

Failed verification returns to `BACKLOG` within the fix cap. Workers never co-edit a shared backlog document; the coordinator owns its validated canonical backlog. Shared files belong to one worker, and dependencies are dispatched only after predecessors finish.

Backlogs require regression coverage; documentation tasks are proposed only when the user's problem requests them. Implementation interface NOTES target only dependent owners on other workers, never the sender itself.
An invalid worker backlog proposal gets one corrective assignment on the same session with validation feedback and the expected shape; a second invalid payload fails the run.

## Advisors

`advisors` in `orche.config.json` configures any number of advisory reviewers. Each has `domains` (what to look at: `plan`, `verification`, `correctness`, `security`, `performance`, `tests`, `scope`, `docs`, or your own `{id, instructions}`), `targets` (who receives the advice: `coordinator`, `workers`, `role:<role>`, `agent:<id>`), `triggers` (`coordinator_decision`, `assignment_started`, `assignment_result`, `turn_end` every N, `tool_error`, `interval`, `before_complete`) and finite budgets (`cooldownMs`, `maxCallsPerRun`, `maxCallsPerTarget`). An advisor call is a short read-only session on the `advisor` route that answers `ok`, `concern` or `blocker`; `ok` injects nothing, anything else becomes exactly one NOTE from `advisor:<name>` to the target. Advisors are advisory only: they never redirect, stop or gate; calls run beside the workers, and only `await` decision triggers and `before_complete` make the coordinator wait (and reconsider at most once). The two OMP roles ship as presets `plan-review` and `verification-audit`, both disabled; set `"enabled": true` to turn one on. Full schema, preset definitions and semantics: [docs/advisor.md](docs/advisor.md).

## Message semantics

- **NOTE**: information only. A worker calls `send_message` directly to a relevant peer or `main`; recipient tool work is not cancelled and no new turn is forced. Sender-framed context is delivered at Pi's safe boundary. A strong cause uses signal `root_cause_found` immediately, before RESULT.
Main-inbox NOTES received after exploration are buffered and included once, with sender/content/signal, in the next coordinator decision context rather than discarded by outcome waits.
- **REDIRECT**: coordinator-only abort plus a new assignment on the same session. The superseded assignment has exactly one outcome; retained context survives.
- **STOP**: explicitly ends unnecessary work; session disposal is separate.
- **RESULT**: worker calls `report_result` alone. First accepted result wins; lifecycle settlement delivers its outcome separately from message delivery. Completed implementation/fix outcomes finish their task unless the worker explicitly reports `data.status: "blocked"`; blocked runs retain the worker's reason in the failure summary.

For an isolated check: `npx vitest run test/orchestration`. Regressions exercise real AgentSessions with faux providers, including read-only English/Korean answers, direct trivial changes and actual Node verification, variable worker counts, early NOTE convergence, dependency ordering/context retention, proposal repair, main-inbox NOTE delivery, invalid decisions, timeout failures and disposal. Live MVP evidence is under `results/mvp/`; Pi experiment observations are in `docs/pi-sdk-findings.md`.
