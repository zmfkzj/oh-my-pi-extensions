# Pi 1.5.2 compatibility and validation

Target: **`@earendil-works/pi-coding-agent@1.5.2`** (released 2026-11-10; 1.5.1 on 2026-11-09) with the matching `pi-ai`, `pi-agent-core`, `pi-tui`, `pi-mcp`, `pi-codemode`, `pi-telemetry` and `pi-schema` 1.5.2 packages. Sources: [v1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2) and [v1.5.1](https://github.com/earendil-works/pi/releases/tag/v1.5.1) releases (same text as the installed package's `CHANGELOG.md`), the `pi-mcp`/`pi-schema` changelogs, and the public declarations (`index.d.ts`, `core/extensions/types.d.ts`, `core/tools/*.d.ts`, `core/agent-session*.d.ts`, pi-ai, pi-agent-core, pi-tui) compared with 1.5.0. The earlier record is [Pi 1.5.0](pi-1.5.0.md).

## What changed in Pi and what it means here

| Pi 1.5.1/1.5.2 change (upstream) | Effect on this repository |
|---|---|
| Cancellation during lazy provider loading or authentication is reported as an abort, not an error (#8635): pi-ai's `lazyStream` now ends a stream whose signal was already aborted with `reason: "aborted"`. | orche's inherited worker runtime (`orche/src/pi/inherit-providers.ts`) delegates `streamSimple` to the host, so it follows the host unchanged. The four `… cancels an in-flight stream …` cases in `orche/test/pi/host-provider-protocol.test.ts` pinned the old host classification (`reason: "error"`) and failed on 1.5.2; they now expect `aborted` and still check that the inherited result equals the host's (`stopReason`, `errorMessage`) and names the abort. No production code changed. |
| SDK/RPC `reload()` now throws while a response or compaction is running ("Wait for the current response to finish before reloading."). | orche reloads a worker session only when it installs the task workflow at an assignment boundary (`orche/src/pi/session-factory.ts` `enableTaskWorkflow`), when the worker is idle; the root lifecycle tests reload idle sessions. All suites pass on 1.5.2. |
| `GrepOperations.readFile` is no longer called (breaking; grep context comes from ripgrep); `ReadOperations` gains optional `createReadStream`; grep `glob` is relative to `path`; find/ls `limit` below 1 means 1; find no longer reports the limit when exactly `limit` files match. | No package supplies `GrepOperations`/`ReadOperations`. orche wraps Pi's `read` and `find` definitions (`orche/src/tools/read.ts`, `orche/src/tools/find.ts`) without custom operations; their tests (`read-outline`, `read-structured`, `find-gitignore`, `prepare-arguments`) pass on 1.5.2. |
| `cacheWarming` defaults to `"idle"` (warm caches between runs); Anthropic message threads (`compat.supportsMessageThreads`, new `disableContinuation` stream option); OpenAI-compatible requests omit an empty `tools` array. | The suites use the faux provider or local loopback servers (no live provider); CLIProxyAPI's real-SSE test already sets `cacheWarming: "off"`. No package code sets these options; requests go through Pi's own provider code (orche's inherited runtime delegates to the host). All suites pass on 1.5.2; no change. Live provider behaviour is not verified. |
| A session whose working directory is gone now offers Continue/Fork/Cancel in interactive mode, also for `ctx.switchSession()`. | Interactive-only prompt; packages here switch sessions only through the SDK runtime in tests (`runtime.switchSession`), whose directories exist. No change. |
| `pi.registerMarkdownTransformer(transformer, { messageTypes })`; `ctx.ui.custom()` overlays honor `blocked`; `/reload` removes every extension overlay; `PackageManager.update()` emits `result` progress events; `pi auth login/logout`; package update summaries. | No package registers Markdown transformers or uses `blocked` overlays; orche uses `DefaultPackageManager` only for `getInstalledPath()` (`src/extension/doctor.ts`, `src/pi/provider-extensions.ts`), not `update()`. Not affected. |
| `truncateMiddle` removed from `core/tools/truncate` (not exported from the package index); pi-schema accepts `BigInt`/`Undefined`, rejects `NaN`/`Infinity`; MCP, codemode, OAuth, model catalog, TUI and Windows fixes. | Not used by these packages; schema checks unchanged. |

## Changes

- The eight TypeScript packages pin their Pi **development** dependencies and locks to 1.5.2 (`pi-commit`: `bun.lock`). The locks replace pi-coding-agent's `grok-mermaid` 0.2.3 with `lovely-mermaid` 0.3.3. In `codegraph` (development dependencies only) npm also re-resolved some transitive AWS SDK/Smithy packages of pi-ai within their ranges. Host-provided `*` peers and runtime dependencies are unchanged; `package.json` files keep their formatting (only the version strings change). CLIProxyAPI's lock keeps npm's `--legacy-peer-deps` flags. Not pinned (no Pi development dependency, none added): `pi-workbench`, `pi-skillcache`, `pi-tmp`, `pi-eval-loop` and the root manifest.
- Gates: `scripts/pi-harness.mjs`, `scripts/pi-versions.mjs`, `scripts/pi-compat.mjs`, `scripts/verify-install.mjs` and `pi-workbench/tests/pi-host.mjs` default to 1.5.2.
- Tests: `orche/test/pi/host-provider-protocol.test.ts` as described above.
- Docs: root README, `browser/README.md`, `cliproxyapi/README.md` (also naming the actually locked and tested provider 0.16.12).
- `orche/CHANGELOG.md` is not edited: it carried uncommitted, unrelated work when this migration was made and was left untouched. The 1.5.0 migration did not add an orche changelog entry either; this record and the root `CHANGELOG.md` describe the orche test change.

## Reproduce the checks

Same as [1.4.0](pi-1.4.0.md#reproduce-the-checks) with a 1.5.2 package directory:

```sh
export OMP_PI_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent   # 1.5.2, with pi-ai/pi-tui 1.5.2 beside it
export OMP_PI_VERSION=1.5.2
export OMP_COMPAT_LOG_DIR=/path/to/scratch/pi152-results
npm run test:compat      # 22 commands
OMP_INSTALL_NPM_CACHE=/path/to/populated/npm-cache OMP_INSTALL_TEST_DIR=/path/to/scratch npm run test:install
```

The notes of [1.5.0](pi-1.5.0.md#reproduce-the-checks) on filling the offline npm cache for `test:install` and on scratch path length (pi-gui's `test/portal-activation.test.ts` binds a D-Bus socket under `TMPDIR`) still apply.

### Recorded results (2026-11-15)

Linux x64, Node 24.21.0, npm 11.19.0, Bun 1.4.2; host = the isolated candidate install `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent` 1.5.2 (`pi-ai`/`pi-tui` 1.5.2 beside it). Isolated HOME/agent data, no credentials, no paid or live model request. Every check printed `Pi under test: …/pi-coding-agent (pi-coding-agent 1.5.2); pi-ai 1.5.2 …; pi-tui 1.5.2 …`, the preflight resolved every package-local SDK at 1.5.2, and Workbench's host checks printed `Workbench host check: pi-coding-agent@1.5.2` (and `pi-ai`/`pi-tui` 1.5.2) from the same install.

| Check | Result |
|---|---|
| Before the migration, 1.5.2 | `npm test` passed; `npm run test:compat` stopped at its first line (`test:compat is the mandatory 1.5.0 gate`, `'1.5.2' !== '1.5.0'`). |
| Before the migration, gate on the 1.5.0 pins (`OMP_PI_VERSION=1.5.0`, `OMP_PI_DIR` = orche's 1.5.0 SDK) | 19/22. Failed: pi-gui `portal-activation` (3, socket path length); cliproxyapi `pi-load` (1: the installed provider 0.16.10 did not match the locked 0.16.12, so its doctor warned; the reinstall with the 1.5.2 pins installed the locked 0.16.12); pi-eval-loop (3, below). |
| `npm run test:compat`, first run | 19/22. orche 3315/3327 with 4 failures, all from Pi 1.5.1 (pre-request abort now `aborted`); fixed as described above (`host-provider-protocol.test.ts` 33/33). pi-gui and pi-eval-loop as before. |
| `npm test` (root) | 74/74. |
| `npm run test:compat`, final run | 20/22 commands passed. Root 74/74; orche 3319 (8 skipped); browser 537 (4 skipped: no real obscura/Chrome E2E); pi-commit 223; session-bus 328; images 141 (1 live test skipped); codegraph 39; cliproxyapi 36; Workbench 75 plus both real-host session/editor checks; pi-skillcache 17; all eight typechecks. Failed, the same cases as before the migration: pi-gui 103/107 (1 skipped), only the three `portal-activation` cases (the scratch `TMPDIR` is about 100 characters, see 1.5.0); pi-eval-loop 376/382 (3 skipped), three environment cases outside this migration: the gateway binary under `~/Downloads/EasyCLIProxyAPI-…/cli-proxy-api` is not the build the eval loop verified (two cases) and the reviewer sandbox probe (`positive controls visible`). |
| Those pi-gui cases separately | `pi-gui/test/portal-activation.test.ts` 5/5 with a short `/proc/<pid>/fd/<n>` `TMPDIR` alias of the same scratch directory. |
| `npm run test:install` | Passed: current-tree artifact, `npm ci --omit=dev --legacy-peer-deps --offline` with bootstrap, no bundled development SDK, 7 real-host test files, then clean reinstall and the same checks. |

Not verified: real model behaviour (including idle cache warming and Anthropic message threads), live OAuth/cloud authentication, a real desktop or browser engine, the interactive missing-cwd Continue/Fork prompt, an older-host smoke run, and a remote `pi update` of the umbrella (submodule changes are uncommitted, so no gitlink can point at them yet).
