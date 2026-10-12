# oh-my-pi-extensions

Ten bundled packages for Pi:

- **[orche/](https://github.com/zmfkzj/pi-orche)** — git submodule for multi-agent orchestration.
- **[browser/](https://github.com/zmfkzj/pi-browser)** — git submodule for browser tools, backed by the obscura headless browser's stdio MCP server. The binary is not bundled.
- **[@amaster.ai/pi-computer-use](https://www.npmjs.com/package/@amaster.ai/pi-computer-use)** — npm dependency for desktop automation of the user's own (physical) desktop.
- **[pi-gui/](https://github.com/zmfkzj/pi-gui)** — git submodule that gives each agent its own private KDE Wayland desktop: it registers [computer-use-mcp](https://github.com/mirsella/computer-use-mcp) with Pi's built-in MCP, keeps calls off the physical desktop, and provides the `gui` capability for `orche_task` workers (one server process and private desktop per worker). Needs `kwin-wayland`, `kwin-common` and `xdg-desktop-portal-kde`; see `/gui doctor`.
- **[pi-commit/](https://github.com/zmfkzj/pi-commit)** — git submodule to preview and explicitly confirm safe single or hunk-split Git commits via `/commit`.
- **[session-bus/](https://github.com/zmfkzj/pi-session-bus)** — git submodule that lets separate local Pi sessions exchange messages over Unix sockets and wake each other.
- **[images/](https://github.com/zmfkzj/pi-images)** — git submodule with the CLIProxyAPI image provider and a `generate_image` tool that shows results inline and takes file paths or attached images as references.
- **[pi-workbench/](https://github.com/zmfkzj/pi-workbench)** — git submodule with on-demand `wb-*` skill routes (requirements, game, analysis, vision AI, manufacturing, coding, promo) and the `/workbench` profile command.
- **[codegraph/](https://github.com/zmfkzj/pi-codegraph)** — git submodule that connects [CodeGraph](https://github.com/colbymchenry/codegraph)'s MCP server (`codegraph_explore`: source, call paths and blast radius in one call) through Pi's built-in MCP, adds `/codegraph status|init|sync`, and gives every orche worker and sub-worker its own CodeGraph connection (`codegraph` worker capability, read-only roles included). Needs the `codegraph` CLI (not bundled) and a per-project index (`/codegraph init`); an existing `codegraph` entry in `mcp.json` keeps precedence and is what workers use too.
- **[cliproxyapi/](https://github.com/zmfkzj/pi-cliproxyapi-bundle)** — git submodule that loads the official CLIProxyAPI model provider [@router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) (its own npm dependency, pinned by its `package-lock.json`: `/login CLIProxyAPI`, `/fast`, `/pause`, `/continue`, `/cliproxyapi-refresh`, TUI TPS footer), and skips it when the same package is also installed on its own in your settings, so it never loads twice. Needs a running CLIProxyAPI and its key.

The root is a batch-install manifest, not an npm workspace. Each submodule keeps its own dependencies. Requires Node ≥22.19, git, and npm.

## Install

Local checkout:

```sh
git clone --recurse-submodules https://github.com/zmfkzj/oh-my-pi-extensions.git
cd oh-my-pi-extensions && npm install --legacy-peer-deps
pi install /path/to/oh-my-pi-extensions
# Or try all ten without saving:
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

## Update

For a local clone, advance to the latest submodule branches:

```sh
git pull && git submodule update --init --remote
```

Alternatively, after `git pull`, rerun `npm install --legacy-peer-deps` to bootstrap the umbrella's recorded commits and missing dependencies. Bootstrap only syncs clean, detached submodules; branch checkouts or dirty worktrees are left untouched.

The GitHub Actions workflow updates submodules to their configured branches (`master` for orche/browser, `main` for pi-commit, session-bus, pi-gui, pi-workbench, images, codegraph and cliproxyapi; the pi-images provider is bundled by orche) hourly (at minute 17), or on manual dispatch. Child repos can trigger it immediately via `repository_dispatch` with event type `submodule-updated` using a PAT; that PAT/child-repo setup is not configured yet.

The CLIProxyAPI provider has its own update path: the `cliproxyapi/` submodule's repository (`zmfkzj/pi-cliproxyapi-bundle`) checks npm every 6 hours, updates its `package.json` and `package-lock.json` to a newer provider release, and commits that to `main` only after its typecheck and tests (including a Pi loader test) pass; the hourly workflow above then picks up the new gitlink. A separately installed provider (`npm:@router-for-me/pi-cliproxyapi-provider` in your settings) is updated by `pi update --extensions` instead. The CodeGraph CLI behind `codegraph/` is never updated by these packages: use `codegraph upgrade` (see [pi-codegraph](https://github.com/zmfkzj/pi-codegraph#versions-and-updates)).

See the linked package READMEs for configuration.
