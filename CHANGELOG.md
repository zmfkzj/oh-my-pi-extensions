# Changelog

## [Unreleased]

### Changed

- Pi 1.2.0 (`@earendil-works/pi-coding-agent`): the Pi devDependencies and locks of every TypeScript submodule move to 1.2.0 (orche and codegraph, cliproxyapi from 1.1.0; pi-gui from 1.0.2; browser, pi-commit, images and session-bus from 1.0.0), so their typechecks and tests run on the Pi the packages now load in; peer ranges stay `*` and no runtime dependency changes. Pi 1.2.0 emits `before_agent_start` also for a run that a `triggerTurn` message starts while idle (`messageType: "custom"`) and counts a starting run as busy:
  - pi-workbench: a one-shot skill selection that an idle `/skill:` or template request took but that never started (no model, its input handled by another extension) is no longer attached to such a run as "이 사용자 요청 바로 뒤"; it is cancelled there with the existing notice, and selections no user request has taken yet keep waiting (reproduced and checked with `tests/pi-session.mjs` 5c on Pi 1.2.0; `tests/runtime.test.mjs`).
  - orche: tests assert the custom `before_agent_start` of a woken run and keep the commands fallback for older hosts (`test/extension/worker-skills.test.ts`); new `test/extension/run-start.test.ts` covers one delegation section per request of such a run, `/orche strong` refused while a run starts, Esc during a one-shot run's start and the interrupted-jobs notice. Behaviour is unchanged; outdated comments and docs are corrected.
  - orche's interrupted-jobs notice and session-bus's work-queue turn notice keep going once with whichever run starts first, now also a custom-started one (documented, session-bus test added).

- The physical-desktop package `@amaster.ai/pi-computer-use` now loads its tools on demand through `extensions/computer-use/` (the manifest's entry; the package itself is unchanged): only `computer_use_tools` (with a new `core` group) is declared at start instead of its 15 core declarations, and `/computer-use-tools core`, a successful `computer_use_connect`, `/reload` and the package's other groups keep working; `loadOnDemand: false` or `toolProfile: "full"` restores its start-up behaviour. Measured first-request declarations: 65,672 → 15,646 characters (`scripts/measure-tool-declarations.mjs`; characters, not tokens). Tests: `scripts/computer-use-on-demand.test.mjs`, `scripts/main-tool-surface.test.mjs`.
- Updated orche: a read without offset/limit of a JS/TS file over 16 KB returns its outline first (`offset: 1` reads the text), and the read guidance tells the model when to narrow and what to read whole.

- Updated orche to use Pi's builtin, models.json and extension providers in workers, including request-time authentication; obsolete missing providerExtensions packages warn rather than blocking inherited providers.

- Added the official CLIProxyAPI provider `@router-for-me/pi-cliproxyapi-provider` through the pi-cliproxyapi-bundle extension (`cliproxyapi/`, bundled submodule `zmfkzj/pi-cliproxyapi-bundle`; the provider is its npm dependency `^1.4.22`, locked at 1.4.22; no root dependency), which loads nothing when the same package is also installed on its own in Pi's settings (`PI_CLIPROXYAPI_BUNDLED=auto|on|off`).
- The bundled provider updates itself: pi-cliproxyapi-bundle's `update-provider` workflow moves `package.json` + `package-lock.json` to a new npm release of the provider and commits only after typecheck and tests pass; the hourly "Update submodules" workflow then moves the `cliproxyapi` gitlink.
- orche workers and sub-workers get the project's CodeGraph tools: pi-codegraph answers orche's new `codegraph` worker capability with the worker's own MCP connection (the user's `codegraph` mcp.json entry, made direct, or `codegraph serve --mcp`); pi-gui and pi-codegraph share one worker MCP extension factory, which orche loads once.
- Added the pi-codegraph extension (`codegraph/`, bundled submodule `zmfkzj/pi-codegraph`): CodeGraph's `codegraph_explore` MCP tool through Pi's built-in MCP for indexed projects, and `/codegraph status|init|sync`. Needs the `codegraph` CLI; an existing `codegraph` server in `mcp.json` keeps precedence.
- Added the pi-workbench extension (`wb-*` skill routes, `/workbench`) as a bundled submodule.
- Added the pi-gui extension (private computer-use desktops per agent, `orche_task gui`) as a bundled submodule.
- Added the pi-session-bus extension as a bundled submodule.

