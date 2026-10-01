# pi-orche as a Pi package

`pi install /path/to/pi-orche` adds pi-orche to your normal interactive `pi` sessions. The package manifest (`package.json` → `pi.extensions`) loads `src/extension/index.ts`, which provides three things.

## 1. Tools in every session

- **`read` and `edit` replace Pi's built-ins** (an extension tool registered under a built-in name wins in Pi's tool registry). `read` prints `LINE#TAG|text`; `edit` takes those anchors. The model sees exactly one of each. See [tools.md](tools.md).
- **Added and active:** `find` (our in-process walk), `ast_search`, `ast_rewrite`, `diagnostics`. Pi's own `grep` and `ls` are switched on as well (`grep` needs `rg`, as in Pi). `bash` and `write` stay Pi's.
- **Long-output spill on every tool result:** results over 12,000 characters or 300 lines (except `read`, which pages itself) are cut to head + tail, and the full text is saved to `<cwd>/.orche/artifacts/<tool>-<id>.txt` (with a `.gitignore`/`.ignore` so it stays out of git and out of grep). The truncated result tells the model where the file is.
- If you start Pi with `--tools` / `defaultTools` that leave out any of our tools, that selection is respected and grep/find/ls are not added.
- The tools are bound to the working directory of each call, so a global install works in any project.

## 2. `/orche single|multi <PROMPT>` and `/orche cancel`

The first token must be `single` or `multi` (with a non-empty prompt) or `cancel` (with nothing after it). Anything else (a bare `/orche <PROMPT>`, `/orche`, `/orche single`, `/orche cancel now`) shows `Usage: /orche single|multi <PROMPT> | /orche cancel` and starts nothing. `cancel` is the only token that takes no prompt; trailing text after it prints the usage rather than being ignored, so a mistyped prompt can never be silently swallowed as a cancel.

- **`/orche single <PROMPT>`**: no orchestration. The prompt is handed to the **current Pi session as a normal user turn** (public `pi.sendUserMessage`): the session's own model, thinking level and conversation, with our tools (anchored `read`/`edit`, `find`, `ast_*`, `diagnostics`, spill). No coordinator, no workers, no advisor. If the agent is busy when you run it, the prompt is queued as a **follow-up** turn (`deliverAs: "followUp"`, runs after the current run) and a notice says so; it is never dropped or run concurrently.
- **`/orche multi <PROMPT>`**: runs the multi-agent orchestrator (coordinator, parallel workers, independent verifier; see the README) on the session's working directory. Progress shows in the status line and a widget (`phase …`, `A1 started T1`, `verification passed`). When it ends, the final answer is posted into the conversation as a visible `orche-result` message. It is stored in the session and sent to the main model with its next turn, so you can follow up with "apply what orche found". The command itself starts no main-model turn. Failures (including "orche could not run: …") are posted as the same kind of message. Only one multi run at a time per session; a second is refused with a notice. In the **interactive TUI** the run goes to the background and the command returns at once (Pi's editor queues input behind a pending command, which would postpone a typed `/orche cancel` until the run was over), so the editor stays usable while it runs; in print/json/RPC mode the command stays pending until the run ends.
- **`/orche cancel`**: cancels the active `/orche multi` run or `orche_run` call. The run's `AbortSignal` fires, the coordinator, workers, verifier and advisor sessions are stopped and disposed, and the notice `orche run cancelled` is shown once teardown finished. A cancelled `/orche multi` posts an `orche-result` message with `details.cancelled: true` and the header `orche CANCELLED by user`. A cancelled `orche_run` tool call ends with the error result `cancelled by user`. With nothing running it only notifies `no active orche run`. A new `/orche multi` can be started right after a cancel. (`/orche single` is an ordinary turn; stop it with Pi's own Esc.)

## 3. `orche_run` tool

Lets the main model delegate a substantial request. Progress streams through the tool's partial updates; the final report is the tool result. A failed or cancelled orchestration is an **error** result. Pi's abort of the turn (Esc) cancels the run through the tool's `AbortSignal`: the coordinator and every worker and advisor session are stopped and disposed, and the result says `cancelled`. `/orche cancel` ends the call with the error result `cancelled by user`.

## Concurrency

One orche run per Pi session. `/orche multi` and `orche_run` refuse to start while another is active (`/orche cancel` frees the slot) (`/orche single` is an ordinary user turn and is not affected). Orche sessions are in-memory: nothing is added to your Pi session history except the posted `orche-result` message or the tool result, and no Pi settings are written beyond what `pi install` itself writes. Workers edit files in the session cwd (the same ownership rules as the CLI); use a clean working tree.

## Which models and settings an orche run uses

Config discovery, first match wins:

1. `<cwd>/.pi/orche.config.json`, only if Pi trusts the project (a project file can choose models and enable advisors, so an untrusted project cannot). An untrusted project file is reported as ignored in the result details.
2. `~/.pi/agent/orche.config.json` (`PI_CODING_AGENT_DIR` is honored).
3. Otherwise every orche role uses the session's current model and thinking level.

The file has the same format as the repository's `orche.config.json` (`routes`, `default`, optional `advisors`; see [advisor.md](advisor.md)). An existing file that fails validation is an error; there is no silent fallback.

### Auth limitation

Orche runs create **one `ModelRuntime.create()` per Pi session** (lazily, reused for every run). That is Pi's public, file-backed runtime: the same `~/.pi/agent` credentials, with Pi's own locking and refresh, exactly like the standalone CLI. The consequence:

- Providers or models that **other extensions register into your Pi session** are not visible to orche runs, and neither are credentials that live only in memory (not persisted).
- If the session's current model cannot be resolved by that runtime (rule 3), the run fails with a message naming `.pi/orche.config.json`. Fix it by routing orche to a model the file-backed runtime knows, e.g. `.pi/orche.config.json`:

```json
{ "routes": {}, "default": { "model": "openai/gpt-6.1-sol", "thinking": "high" } }
```

## Install, check, remove

```sh
pi install /path/to/pi-orche      # writes the package source to ~/.pi/agent/settings.json "packages"
pi list
pi remove /path/to/pi-orche       # uninstall (same source string as installed)
pi -e /path/to/pi-orche           # try for one invocation without installing
```

A local path is loaded in place (not copied or modified), so run `npm install` in the repository once: the package's runtime dependencies (`@ast-grep/napi`, `@sinclair/typebox`, `typescript`) come from its `node_modules`. The `@earendil-works/*` packages are `peerDependencies` (Pi supplies its own copies to extensions) and also `devDependencies` so the standalone CLI and the tests keep working.

## Verification status

Covered by automated tests with faux providers and real `AgentSession`s (`test/extension/`): tool exposure, `/orche single` (user turn, no orchestration, queued when busy), `/orche multi`, usage errors that start nothing, `/orche cancel` (during multi, during `orche_run`, idle, and a new run afterwards), TUI-mode background multi, `orche_run`, abort/disposal, config precedence, concurrency refusal. `/orche cancel` was also verified live against a real model through `pi --mode rpc` (see the report). Live headless runs against a real model are recorded by the maintainers in their report. The interactive terminal UI (status line, widget, message rendering) has not been driven by automation.
