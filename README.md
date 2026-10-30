# oh-my-pi-extensions

Eleven bundled packages for Pi:

- **[pi-tmp/](https://github.com/zmfkzj/pi-tmp)** — git submodule that points Pi's temporary directory (`TMPDIR`, `os.tmpdir()`, child processes) at a private on-disk directory, `/var/tmp/pi-${USER}` (or `$PI_TMP_DIR`), instead of a RAM-backed `/tmp` whose per-user tmpfs quota can make writes fail with `EDQUOT`. It is the manifest's first extension, so the packages after it (orche scratch, the CLIProxyAPI provider's patched-module cache, bash tool output files) already see the new directory when their modules load. It has no dependencies and no command (not part of `/oh-my-pi`).
- **[orche/](https://github.com/zmfkzj/pi-orche)** — git submodule for multi-agent orchestration.
- **[browser/](https://github.com/zmfkzj/pi-browser)** — git submodule for browser tools, backed by the obscura headless browser's stdio MCP server. The binary is not bundled.
- **[@amaster.ai/pi-computer-use](https://www.npmjs.com/package/@amaster.ai/pi-computer-use)** — npm dependency for desktop automation of the user's own (physical) desktop, loaded on demand (see [Physical-desktop tools on demand](#physical-desktop-tools-on-demand)).
- **[pi-gui/](https://github.com/zmfkzj/pi-gui)** — git submodule that gives each agent its own private KDE Wayland desktop: it registers [computer-use-mcp](https://github.com/mirsella/computer-use-mcp) with Pi's built-in MCP, keeps calls off the physical desktop, and provides the `gui` capability for `orche_task` workers (one server process and private desktop per worker). Needs `kwin-wayland`, `kwin-common` and `xdg-desktop-portal-kde`; see `/gui doctor`.
- **[pi-commit/](https://github.com/zmfkzj/pi-commit)** — git submodule to preview and explicitly confirm safe single or hunk-split Git commits via `/commit`.
- **[session-bus/](https://github.com/zmfkzj/pi-session-bus)** — git submodule that lets separate local Pi sessions exchange messages over Unix sockets and wake each other.
- **[images/](https://github.com/zmfkzj/pi-images)** — git submodule with the CLIProxyAPI image provider and a `generate_image` tool that shows results inline and takes file paths or attached images as references.
- **[pi-workbench/](https://github.com/zmfkzj/pi-workbench)** — git submodule with on-demand `wb-*` skill routes (requirements, game, analysis, vision AI, manufacturing, coding, promo, research) and the `/workbench` profile command; the research profile bundles [Research Agent Skills](https://github.com/KalarisLabs/research-agent-skills) (MIT).
- **[codegraph/](https://github.com/zmfkzj/pi-codegraph)** — git submodule that connects [CodeGraph](https://github.com/colbymchenry/codegraph)'s MCP server (`codegraph_explore`: source, call paths and blast radius in one call) through Pi's built-in MCP, adds `/codegraph status|init|sync`, and gives every orche worker and sub-worker its own CodeGraph connection (`codegraph` worker capability, read-only roles included). Needs the `codegraph` CLI (not bundled) and a per-project index (`/codegraph init`); an existing `codegraph` entry in `mcp.json` keeps precedence and is what workers use too.
- **[cliproxyapi/](https://github.com/zmfkzj/pi-cliproxyapi-bundle)** — git submodule that loads the official CLIProxyAPI model provider [@router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) (its own npm dependency, pinned by its `package-lock.json`: `/login CLIProxyAPI`, `/fast`, `/pause`, `/continue`, `/cliproxyapi-refresh`, TUI TPS footer), and skips it when the same package is also installed on its own in your settings, so it never loads twice. Needs a running CLIProxyAPI and its key.

The root is a batch-install manifest, not an npm workspace. Each submodule keeps its own dependencies. Requires Node ≥22.19, git, and npm. Every package uses the Pi that loads it (Pi's `@earendil-works/*` packages and `typebox` are host-provided; the submodules' peer ranges are `*`). The eight TypeScript submodules' development dependencies and locks target **Pi 1.4.0**, including pi-commit's `bun.lock`. See [Pi 1.4.0 compatibility and validation](docs/pi-1.4.0.md) for the 1.4.0 changes that matter here, exact checks, exclusions and the 1.3.0 smoke baseline; [Pi 1.3.0](docs/pi-1.3.0.md) keeps the earlier record (including the conditional Kimi Coding override migration).

## Install

Local checkout:

```sh
git clone --recurse-submodules https://github.com/zmfkzj/oh-my-pi-extensions.git
cd oh-my-pi-extensions && npm install --legacy-peer-deps
pi install /path/to/oh-my-pi-extensions
# Or try all eleven without saving:
pi -e /path/to/oh-my-pi-extensions
```

The root postinstall bootstrap populates all submodules and installs their missing runtime dependencies. `--legacy-peer-deps` avoids duplicate copies of Pi's host-provided packages and `typebox`.

Remote install (bootstrap runs automatically):

```sh
pi install git:github.com/zmfkzj/oh-my-pi-extensions
pi update --extensions   # later: update installed packages
```

Or install individual packages:

```sh
pi install git:github.com/zmfkzj/pi-tmp       # install it first: it only affects packages loaded after it
pi install git:github.com/zmfkzj/pi-orche
pi install git:github.com/zmfkzj/pi-browser
pi install git:github.com/zmfkzj/pi-commit
pi install git:github.com/zmfkzj/pi-session-bus
pi install npm:@amaster.ai/pi-computer-use
pi install git:github.com/zmfkzj/pi-gui
pi install git:github.com/zmfkzj/pi-workbench
pi install git:github.com/zmfkzj/pi-codegraph
pi install git:github.com/zmfkzj/pi-cliproxyapi-bundle
pi install npm:@router-for-me/pi-cliproxyapi-provider   # the provider alone; pi-cliproxyapi-bundle then loads nothing
```

## Dependency check and install

Every bundled package except pi-tmp (nothing to install or check) has two subcommands on its own command, and the umbrella runs them for all packages at once:

```text
/oh-my-pi doctor [package...]         # check every package (or the named ones); never installs or repairs
/oh-my-pi install-deps [package...]   # install what can be installed, report the rest as manual steps
```

Package ids: `orche`, `browser`, `computer-use`, `pi-gui`, `pi-commit`, `session-bus`, `images`, `pi-workbench`, `codegraph`, `cliproxyapi` (Tab completes them). The report has one section per package (`[id] label: outcome  (its own command)`), each item marked `[ok]`, `[installed]`, `[warn]` (optional feature), `[error]`, `[failed]`, `[manual]` or `[unverified]`, a `->` action under every abnormal item, and a summary line (`10 packages: 6 healthy, 1 abnormal, ...`) plus the list of packages that need attention. Packages are checked concurrently with a 60 s limit each, and installed one after another with a 15 min limit each; a package that throws, times out or is not loaded is reported as such, and the others' results still appear. `install-deps` ends with "run /reload" when something was installed.

| Package | Own commands | doctor checks | install-deps installs automatically | Reported as manual |
|---|---|---|---|---|
| orche | `/orche doctor`, `/orche install-deps` | npm deps and that the native ones load (`@ast-grep/napi`, `sharp`), Node.js, git, `orche.config.json`, configured routes/models | missing npm deps (`npm install --legacy-peer-deps`) | Node.js, git, broken native bindings, models/credentials |
| browser | `/browser doctor`, `/browser install-deps` | config, platform, glibc 2.35+, obscura (its own resolution order), optional Chrome engine | obscura (the verified `/browser install` download of the configured version), `chrome-devtools-mcp` | Chrome, broken binary overrides, unsupported platforms |
| computer-use | `/computer-use doctor`, `/computer-use install-deps` | `@amaster.ai/pi-computer-use`, the platform's Cua Driver package and `cua-driver --version`, settings, Linux desktop session; permissions are unverified (need the running driver) | the npm package and driver (`npm install --legacy-peer-deps` in this checkout) | unsupported platform, `binaryPath`, desktop session, OS permissions |
| pi-gui | `/gui doctor` (unchanged details and live smoke test, plus the report), `/gui install-deps` | Linux, `gui.config.json`, computer-use-mcp server, KDE Wayland services and KWin plugins, optional `/gui view` tools; the batch check never starts a desktop or runs `npx` | the bundled server npm package (Linux x64, glibc 2.39+) | `sudo apt install ...` lines, cargo build, other OSes |
| pi-commit | `/commit doctor`, `/commit install-deps` | git ≥ 2.31, git identity, current work tree, planning model credentials | nothing (no npm runtime deps) | git, `git config` identity, `/login` |
| session-bus | `/bus doctor`, `/bus install-deps` | POSIX sockets, bus directory and permissions, socket path length, receiving mode, optional git for `/queue` | nothing (no external packages) | Windows (unsupported), directory fixes |
| images | `/images doctor`, `/images install-deps` | image model settings, CLIProxyAPI base URL, credentials (set/not set), gateway reachability (3 s); inside herdr, herdr's pi integration (terminal images in herdr-web-ui) | nothing | CLIProxyAPI server and key, `herdr integration install pi` |
| pi-workbench | `/workbench doctor`, `/workbench install-deps` | bundled catalog/skills; optional skill tools and API-key variables (presence only) | `ast-grep` (`npm install -g @ast-grep/cli` only with a user-writable npm prefix), `uv` (`pipx install uv` only with pipx) | system tools, API keys, Python modules |
| codegraph | `/codegraph doctor`, `/codegraph install-deps` | `mcp.json` entry, CodeGraph CLI and version, the project index (optional) | a missing CLI on Linux/macOS through upstream's `install.sh` (user-level, no sudo); never upgrades | Windows, permission errors, `/codegraph init` |
| cliproxyapi | `/cliproxyapi doctor`, `/cliproxyapi install-deps` (also when the bundle loads nothing) | which provider install is active, the bundled npm package against its lock, base URL, key (set/not set), server reachability | the bundled provider package | CLIProxyAPI server, `/login CLIProxyAPI` |

Rules every package follows: `doctor` only inspects (bounded subprocess and network probes, no installs, downloads, config writes or index creation); `install-deps` is safe to repeat (present items report `ok`/already available), re-checks what it installed, never runs `sudo`, never changes credentials or settings, and turns everything that needs privileges, credentials, logins, unsupported platforms or external services into a `manual` item with the exact command. Secrets are reported only as set/not set. npm installs run `npm install --legacy-peer-deps` in the package's own directory, as the bootstrap does, and are refused inside an npm-installed package (reinstall with `pi install`/`pi update --extensions` instead).

A package that does not answer is shown as `not loaded` with the reason the files show: missing submodule files (`git submodule update --init <dir>`), missing npm dependencies (`/oh-my-pi install-deps <id>` installs them; then `/reload`), or a load error or settings filter (see Pi's startup output). Packages installed individually (`pi install git:github.com/zmfkzj/pi-browser`, ...) keep their own `doctor`/`install-deps` subcommands; `/oh-my-pi` and `/computer-use` come with this umbrella (`extensions/dependencies/`, Node built-ins only, so they load even when a package's dependencies are missing). Platforms are those of each package: Linux and macOS are covered throughout, Windows only where the package supports it (session-bus and pi-gui report it unsupported; system tools are manual). Each package's README describes its items in detail.

Checks: `npm test` at the root runs `scripts/*.test.mjs`, including `scripts/dependencies.test.mjs` (aggregation, partial failures, time-outs, absent packages, computer-use with fake npm/driver) and `scripts/dependencies-pi.test.mjs` (all packages loaded in a real Pi session answer, and `/oh-my-pi doctor` and every package's `doctor` report through Pi; it inspects this machine read-only and runs no install).

`npm run test:compat` is the required **1.4.0** validation gate: it reports and checks the root host and all eight package-local SDK versions, runs the package typechecks/suites and Workbench's real-host checks, and fails rather than silently falling back to another Pi. Set `OMP_PI_DIR` to an isolated coding-agent **package directory**; `PI_CODING_AGENT_DIR` is reserved for agent data, not SDK discovery. `npm run test:install` separately validates the current uncommitted working-tree artifact with production-only dependencies, then cleans/reinstalls it. Both commands and the live/environment coverage limits are documented in the [compatibility guide](docs/pi-1.4.0.md).

## Physical-desktop tools on demand

The manifest loads `@amaster.ai/pi-computer-use` through `extensions/computer-use/index.js`, which runs the package unchanged and only changes how its tools start in the main session. On its own, the package declares its core set (14 `computer_use_*` tools plus `computer_use_tools`, about 51 KB of declaration JSON with its bundled manifest) in every request of every session, though most sessions never touch the user's screen. Here every driver tool is still registered at session start, but with Pi's `defaultActive: false`; only `computer_use_tools` (about 1 KB) is declared, now with a `core` group:

- The model calls `computer_use_tools` with `group: "core"` (apps, window state, click, type, keys, scroll) when the user asks it to act on their own screen, and other groups (`browser`, `recording`, `session`, `cursor`, `window`, `clipboard`, `diagnostics`) as before. You can do the same with `/computer-use-tools core` (or a group name). Loaded tools are declared from the next request and stay loaded for the session, `/reload` included.
- Tools that are not loaded are not callable, as the package's own inactive groups were. Loaded tools run the package's own code: its app-launch and high-risk confirmations, driver start-up and permissions are unchanged. On Linux, a driver that was unavailable at start still offers `computer_use_connect`; a successful connect loads the core set, as the package's start-up would have.
- To restore the package's start-up behaviour, set `"loadOnDemand": false` in the `"pi-computer-use"` section of `~/.pi/agent/settings.json` (or `"toolProfile": "full"`, which the package already supports, for all tools).
- This is only about the user's physical screen. pi-gui's private desktops (`mcp__computer_use__*`, `/gui`, `orche_task gui: true`) are separate and unchanged, and orche workers load neither.

Measured with `node scripts/measure-tool-declarations.mjs` (Pi 1.1.0, orche plus the physical-desktop entry, faux model, first request; the package's bundled manifest, so Linux live schemas differ in size): declared tools 26 → 12, declaration JSON 65,672 → 15,646 characters, of which `computer_use_*` 15 tools / 51,163 → 1 tool / 1,027 characters. These are characters, not tokens or cost; the system prompt grew by 177 characters (the loader's guideline and orche's read guidance). Changes take effect after `pi update --extensions` (or a new `pi install`) and `/reload` or a new session.

## Update

For a local clone, advance to the latest submodule branches:

```sh
git pull && git submodule update --init --remote
```

Alternatively, after `git pull`, rerun `npm install --legacy-peer-deps` to bootstrap the umbrella's recorded commits and missing dependencies. Bootstrap only syncs clean, detached submodules; branch checkouts or dirty worktrees are left untouched.

The GitHub Actions workflow updates submodules to their configured branches (`master` for orche/browser, `main` for pi-tmp, pi-commit, session-bus, pi-gui, pi-workbench, images, codegraph and cliproxyapi; the pi-images provider is bundled by orche) hourly (at minute 17), or on manual dispatch. Child repos can trigger it immediately via `repository_dispatch` with event type `submodule-updated` using a PAT; that PAT/child-repo setup is not configured yet.

The CLIProxyAPI provider has its own update path: the `cliproxyapi/` submodule's repository (`zmfkzj/pi-cliproxyapi-bundle`) checks npm every 6 hours, updates its `package.json` and `package-lock.json` to a newer provider release, and commits that to `main` only after its typecheck and tests (including a Pi loader test) pass; the hourly workflow above then picks up the new gitlink. A separately installed provider (`npm:@router-for-me/pi-cliproxyapi-provider` in your settings) is updated by `pi update --extensions` instead. The CodeGraph CLI behind `codegraph/` is never updated by these packages: use `codegraph upgrade` (see [pi-codegraph](https://github.com/zmfkzj/pi-codegraph#versions-and-updates)).

See the linked package READMEs for configuration.
