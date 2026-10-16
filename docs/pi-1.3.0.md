# Pi 1.3.0 compatibility and validation

Target: **`@earendil-works/pi-coding-agent@1.3.0`**, with matching Pi AI/agent-core/TUI/MCP packages. Sources: [release](https://github.com/earendil-works/pi/releases/tag/v1.3.0), [npm metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.3.0), [SDK](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sdk.md), [extensions](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md), [tools/CLI](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/cli.md#tools).

## Changes and boundaries

- Eight TS packages pin their Pi **development** dependencies/locks to 1.3.0 (`pi-commit` uses `bun.lock`). Runtime Pi packages remain host-provided; existing `*` peers are not narrowed. The computer-use dependency stays 0.1.22 and CLIProxyAPI provider stays 1.4.22. No third-party adapter rewrite or speculative upgrade was needed.
- Browser initialization preserves Pi's restored active set, including deferred tools enabled by `tool_search`, rather than replacing it with defaults. Fresh hybrid sessions still declare nine browser tools plus search. An exposure change demotes former direct defaults without dropping other extensions' pending late tools. The exposure mode is recorded as a non-model session entry; older transcripts without it use the historical hybrid default rather than guessing whether a specialist tool was intentionally loaded.
- Explicit CLI allowlists/exclusions, `--no-tools`, negative CLI/defaultTools modifiers and browser exposure settings are covered. CLI `--no-tools` corresponds to SDK `noTools: "all"`; SDK `noTools: true`/`"builtin"` intentionally leaves extension tools available. `settings.defaultTools: ["read"]` changes built-in defaults, not an extension allowlist. For hard exclusion use `--exclude-tools`.
- Orche re-applies mode restrictions before runs and after turns, clears a one-turn override when restoring another branch/session, and retains suppressed tools until they actually register. This also guards nested/deferred calls, not just declarations.
- Shared harnesses use isolated credentials/settings, exact host selection and exception-safe teardown. SDK sessions explicitly install the native MCP/search extensions; they do not appear automatically. Real `AgentSessionRuntime` replacement exercises new/resume, and native reload/shutdown is used.

## Reproduce the checks

Use Node **≥22.19**, npm, git, Bun (pi-commit's tests), and the existing package development dependencies. The validation recorded here used Linux x64, Node 24.21.0 and Bun 1.4.2. It did not upgrade global Pi or read/change real credentials or sessions.

```sh
# SDK package directory, NOT the agent data directory:
export OMP_PI_DIR=/path/to/isolated/host/node_modules/@earendil-works/pi-coding-agent
export OMP_COMPAT_LOG_DIR=/path/to/scratch/pi130-results
export TMPDIR=/path/to/scratch/tmp  # create it first
npm run test:compat
```

`test:compat` requires 1.3.0, checks each package-local SDK as well as the selected host, and records paths/versions and per-command logs in `results.json`. An invalid explicit SDK, missing mandatory dependency or wrong version fails; it cannot silently validate the global 1.2.0 host or skip the Pi checks. It runs root tests, eight typechecks and package suites, Workbench's unit suite and its real-host session/editor checks. `npm test` at the root also runs the version/lock preflight.

The gate explicitly enables the no-model-call session-bus RPC smoke suite and sets `SESSION_BUS_PI` to the selected 1.3.0 CLI. It never uses an unversioned `pi` on PATH for that suite.

`OMP_PI_DIR` is separate from `PI_CODING_AGENT_DIR` (temporary **data**). Workbench's standalone scripts accept `PI_WORKBENCH_HOST_MODULE=/.../dist/index.js`; their shared guard verifies host/AI/TUI versions too. Individual host tests may explicitly select another baseline with `OMP_PI_VERSION`; the mandatory 1.3.0 gate rejects that override.

The runner uses an isolated HOME and agent directory, removes credential environment variables and disables paid image tests. Socket fixtures support long scratch paths without weakening production canonical-path checks. Timeouts kill a test's process group and fail the command. Optional skip reasons remain in the logs/summary.

### Recorded results

| Scope | Passed | Skipped / not exercised |
|---|---:|---|
| Root, all 11 manifest entrypoints | 57 | 0 |
| orche | 2,494 | 2: paid image test; root-only foreign-owner fixture |
| browser | 537 | 4: absent real obscura/Chrome E2E binaries |
| pi-gui | 90 | 1: user-systemd `--expand-environment` unavailable in isolated HOME/runtime |
| pi-commit | 177 | 0 |
| session-bus | 322 | 0; includes five real CLI/RPC smoke cases |
| images | 93 | 1: paid image test |
| codegraph | 39 | 0; includes installed real CodeGraph CLI over a disposable project/index |
| cliproxyapi | 35 | 0 |
| Workbench | 58 | 3 Python suites (9 cases) excluded: NumPy/Pillow unavailable |
| TS typechecks | 8 packages | 0 |
| Workbench real-host session/editor | both successful | 0 |

**20/20 required commands passed**, with the above exclusions; not a claim that every possible integration ran. For this machine the explicit environment opt-in `PI_WORKBENCH_SKIP_PYTHON_TESTS=1` was necessary. Without it, the unrelated vendor Python tests correctly fail for missing NumPy/Pillow. Node reports zero skipped *tests* for these three skipped suites because their nine cases are not registered; do not misread that as Python coverage. Install those Python prerequisites in your own isolated test environment and rerun to cover them.

A separate **1.2.0 smoke** of `command-completions`, `main-tool-surface`, and `computer-use-on-demand` passed 12 tests using isolated data. This preserves an older-host smoke baseline, **not** a full 1.2.0 matrix or a promise that 1.3.0's new native restoration features exist there.

### What the checks prove

- `browser/test/restore.test.ts` and `scripts/browser-lifecycle.test.mjs`: real JSONL reopen, native new/resume/reload, next-request declarations, exposure changes, other late tools; four actual CLI subprocess cases (including settings.json negative defaults). No browser engine is used for these lifecycle tests.
- `scripts/mcp-lifecycle.test.mjs`: real MCP stdio subprocesses and the actual GUI/CodeGraph capability factories; one connection per server, six expected children across startup/reload/new, all exited before emergency cleanup. A combined browser/physical-desktop/CodeGraph session retains deferred restored tools. Backend implementations are fixtures, not a live desktop. `pi-gui`'s own suite also tests private routing and read-only roles; `codegraph` separately tests the installed CLI.
- `orche/test/extension/mode-lifecycle.test.ts`: native lifecycle and late registrations in single/strong/ultra/direct, with zero forbidden direct or nested executions.
- `orche/test/pi/host-provider-protocol.test.ts`: real OpenAI Completions/Responses, Anthropic and Google adapters against loopback HTTP/SSE. Host endpoint/auth/header inheritance, once-per-request hooks, successful tools, malformed JSON before execution/guard, cancellation/backoff and final settlement. Model-switch reasoning handling is covered by inheritance/projection/session tests.
- `cliproxyapi/test/pi-stream.test.ts`: actual installed provider 1.4.22, including its private Codex source patch, through loopback SSE; fragmented JSON/UTF-8, tool round-trip, malformed arguments/SSE, cancellation, provider/SDK retry exhaustion and final settlement. Not just model registration.
- `scripts/images-pi.test.mjs`: actual image adapter/tool through local HTTP, output file/image, auth, hooks, malformed-tool zero execution, abort, and no potentially billable retries.
- `scripts/workbench-bus.test.mjs`: native skill discovery, real Unix-socket wake and queue replay, one-shot skill consumption on the user request (not the custom wake), reload/new and endpoint cleanup. Workbench's standalone host checks additionally cover steering/templates/branches and the real editor autocomplete.

Known upstream limitation: Pi 1.3.0's Google adapter does not emit the response hook; the other tested text adapters emit it after successful HTTP setup, not every failed HTTP attempt. The tests record this explicitly; inheritance does not synthesize missing upstream callbacks. Live OAuth/cloud auth, real model behavior/rate limits, CLIProxyAPI WebSocket transport, real GUI/desktop control and browser E2E remain outside this verification. No paid model request was sent.

## Isolated production install/update validation

```sh
# A populated npm artifact cache; copy/cache artifacts into scratch if offline validation needs them.
export OMP_INSTALL_NPM_CACHE=/path/to/scratch/npm-cache
export OMP_INSTALL_TEST_DIR=/path/to/scratch
npm run test:install
```

`scripts/verify-install.mjs` exports **current root and submodule working files**, including new untracked source/tests, not `HEAD` alone. `artifact.json` records every input SHA-256 and an aggregate identity. It initializes disposable branch checkouts without creating commits, runs actual `npm ci --omit=dev --legacy-peer-deps --offline` with bootstrap enabled, checks that no development SDK is bundled, and runs six host test files. It then removes only the artifact's node_modules and repeats installation/checks. Both stages must retain the source identity (npm may rewrite lockfiles in these developer-style checkouts).

This validates the modified artifact and clean production dependency rehydration, **not** an uncommitted remote Git release. Managed detached-gitlink update/dirty-checkout preservation is tested separately by `scripts/bootstrap.test.mjs` with disposable Git fixtures and an npm stub. No source checkout commit/push is part of either command. A real remote `pi update` must wait until the submodule changes and umbrella gitlinks are separately reviewed/published; this work intentionally does not do that.

## Conditional Kimi Coding migration

Only if you use built-in **`kimi-coding`** and override its `api` or `baseUrl` in `models.json`:

1. Back up that settings file yourself. Review only the `kimi-coding` override; no override means no change is needed.
2. Pi 1.3.0 switched this provider from Anthropic Messages to **OpenAI Chat Completions** (`openai-completions`). Remove an obsolete API override to inherit the new default, or adjust the intentional custom override to the compatible API.
3. The official default is **`https://api.kimi.com/coding/v1`**; an old official `/coding` override needs `/v1` for the new API. For a custom proxy, verify its contract rather than blindly appending a path.
4. Validate model discovery and, only with authorization for a real request, a text/tool round-trip. Preserve authentication settings.

Source: [1.3.0 Kimi provider](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/providers/kimi-coding.ts). **Do not append `/v1` to unrelated CLIProxyAPI/gateway URLs.** No private user settings were inspected or migrated by this implementation.
