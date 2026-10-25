# Pi 1.4.0 compatibility and validation

Target: **`@earendil-works/pi-coding-agent@1.4.0`** (released 2026-10-21) with the matching `pi-ai`, `pi-agent-core`, `pi-tui`, `pi-mcp` and `pi-codemode` 1.4.0 packages. Sources: [release](https://github.com/earendil-works/pi/releases/tag/v1.4.0), [npm metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.4.0), [CHANGELOG](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md), [extensions](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md), [compaction](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/compaction.md). The installed package (`dist/`) was also compared with 1.3.0. The earlier record is [Pi 1.3.0](pi-1.3.0.md).

## What changed in Pi and what it means here

The public extension types (`core/extensions/types.d.ts`, `index.d.ts`) are unchanged apart from additions, so no source change was needed. The upstream changes that touch these packages:

| Pi 1.4.0 change (upstream) | Effect on this repository |
|---|---|
| Resume and `/tree` restore the loadout from **all** recorded tool changes, and activate extension tools the branch never added or removed (for example from an extension installed after the session was recorded), unless they are registered with `defaultActive: false` or a non-`direct` exposure ([#11062](https://github.com/earendil-works/pi/issues/11062)). | The on-demand surfaces already opt out: physical-desktop driver tools (`extensions/computer-use/on-demand.js`) and session-bus `queue_done` use `defaultActive: false`; browser specialist tools are `deferred`. An older session reopened with these packages now gets their ordinary direct tools (browser defaults, `tool_search`, `computer_use_tools`), like a new session. New regression test `scripts/restore-installed-later.test.mjs`. |
| `before_provider_headers` no longer sees the OpenRouter, NVIDIA NIM and OpenCode attribution headers (they come from pi-ai's client identity; returning `null` still removes one). | No package reads or rewrites those headers. Orche's and CLIProxyAPI's loopback provider tests (custom header set/remove through the hook) pass unchanged. |
| `generateSummary()`/`generateSummaryWithUsage()` ignore `reserveTokens`; summaries use the model's output limit. `compaction.reserveTokens` only decides when compaction starts. | Orche's worker compaction setting (`orche/src/pi/session-factory.ts`, half the context window) still sets the trigger; it is kept. No package calls `generateSummary`. |
| Recovery from an output-limit cut-off now omits the truncated tool call **and** its results ([#11227](https://github.com/earendil-works/pi/issues/11227)). | Orche's length recovery (`partial_tool`) leaves that to Pi; its tests pass. |
| Concurrent extension dialogs stack instead of replacing each other ([#11166](https://github.com/earendil-works/pi/issues/11166)); `@earendil-works/pi-ai/models` resolves in extensions; `grep` runs `rg --no-config`; codemode waits for a free worker. | Fixes only; nothing here worked around the old behaviour. |
| pi-ai 1.4.0 changed its private `openai-codex-responses` implementation. | The CLIProxyAPI provider (1.4.23) patches that file at runtime; its real SSE/tool streaming tests pass on 1.4.0 without changes. |

Observed in both 1.3.0 and 1.4.0, without these packages too: `/reload` re-activates a directly registered tool that an extension had removed with `setActiveTools`. Resume and `/tree` keep such a removal. This is upstream behaviour and is documented in the new test, not changed.

## Changes

- The eight TypeScript packages pin their Pi **development** dependencies and locks to 1.4.0 (`pi-commit`: `bun.lock`). Only Pi packages and the new transitive `marked-cjk-friendly` changed in the locks; host-provided `*` peers and runtime dependencies are unchanged. CLIProxyAPI's lock keeps npm's `--legacy-peer-deps` dev flags as its update workflow writes them.
- Gates: `scripts/pi-harness.mjs`, `scripts/pi-versions.mjs`, `scripts/pi-compat.mjs`, `scripts/verify-install.mjs` and `pi-workbench/tests/pi-host.mjs` default to 1.4.0; `scripts/pi-harness.test.mjs` follows `PI_VERSION`. `test:install` also runs the new restore test.
- Docs: root README, `browser/README.md`, `cliproxyapi/README.md` (now also naming the actually locked provider 1.4.23).

## Reproduce the checks

Same as [1.3.0](pi-1.3.0.md#reproduce-the-checks) with a 1.4.0 package directory:

```sh
export OMP_PI_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent   # 1.4.0, with pi-ai/pi-tui 1.4.0 beside it
export OMP_COMPAT_LOG_DIR=/path/to/scratch/pi140-results
export TMPDIR=/path/to/scratch/tmp
PI_WORKBENCH_SKIP_PYTHON_TESTS=1 npm run test:compat      # 20 commands
OMP_INSTALL_NPM_CACHE=/path/to/populated/npm-cache OMP_INSTALL_TEST_DIR=/path/to/scratch npm run test:install
```

Older host smoke (not a full matrix): `OMP_PI_VERSION=1.3.0 OMP_PI_DIR=<1.3.0 package> node --test scripts/command-completions.test.mjs scripts/main-tool-surface.test.mjs scripts/computer-use-on-demand.test.mjs scripts/browser-lifecycle.test.mjs`. `scripts/restore-installed-later.test.mjs` asserts the 1.4.0 activation rule and fails on 1.3.0 by design.

Scratch paths matter for two tests that are not about Pi: `images/test/paste.test.ts` compares a rendered "image unavailable: <path>" line that wraps when `TMPDIR` is long, and orche's untracked `test/experiments/cb-ab-sol.test.ts` rejects any command line containing `orche`, including a HOME under a directory named `pi-orche`. Use a short scratch directory whose path does not contain `orche`. Do not alias `TMPDIR` through `/proc/<pid>/fd`: pi-gui's and orche's canonical-path guards then fail as intended.

`test:install` runs offline: the npm cache must already hold every production tarball of the current locks (for example `chrome-devtools-mcp` for browser). One way to fill a scratch cache is `npm ci --omit=dev --legacy-peer-deps --ignore-scripts --cache <cache>` on scratch copies of each `package.json` + `package-lock.json`.

### Recorded results (2026-10-25)

Linux x64, Node 24.21.0, npm 11.19.0, Bun 1.4.2; host = the installed global Pi 1.4.0 (`pi-ai`/`pi-tui` 1.4.0 beside it). Isolated HOME/agent data, no credentials, no paid or live model request.

| Check | Result |
|---|---|
| `npm run test:compat` (scratch `TMPDIR` of about 70 characters inside a `pi-orche` directory) | 18/20 commands passed. Root 58/58 (includes the new restore test); browser 537 (4 skipped: no real obscura/Chrome E2E); pi-gui 100 (2 skipped); pi-commit 177; session-bus 328; codegraph 39; cliproxyapi 35; Workbench 58 (Python suites excluded with `PI_WORKBENCH_SKIP_PYTHON_TESTS=1`: NumPy/Pillow not installed) plus both real-host session/editor checks; all eight typechecks. Failed: orche 2917/2918 (6 skipped) and images 133/134 (1 skipped), each only through the scratch-path cases above. |
| Those two cases separately | `cb-ab-sol.test.ts` 10/10 with the normal HOME; `images/test/paste.test.ts` 18/18 with a short `TMPDIR`, both on 1.4.0. |
| `npm run test:install` | Passed: current-tree artifact, `npm ci --omit=dev --legacy-peer-deps --offline` with bootstrap, no bundled development SDK, 7 real-host test files, then clean reinstall and the same checks. |
| 1.3.0 smoke (four files above) | 23/23 passed on Pi 1.3.0 (`pi-ai`/`pi-tui` 1.3.0). |

Not verified: real model behaviour, live OAuth/cloud authentication, CLIProxyAPI WebSocket transport, a real desktop or browser engine, the Workbench Python suites, and a remote `pi update` of the umbrella (submodule changes are uncommitted, so no gitlink can point at them yet).
