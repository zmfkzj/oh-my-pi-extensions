# oh-my-pi-extensions

Five bundled packages for Pi:

- **[orche/](https://github.com/zmfkzj/pi-orche)** — git submodule for multi-agent orchestration.
- **[browser/](https://github.com/zmfkzj/pi-browser)** — git submodule for browser tools, backed by the obscura headless browser's stdio MCP server. The binary is not bundled.
- **[@amaster.ai/pi-computer-use](https://www.npmjs.com/package/@amaster.ai/pi-computer-use)** — npm dependency for desktop automation.
- **[pi-commit/](https://github.com/zmfkzj/pi-commit)** — git submodule to preview and explicitly confirm safe single or hunk-split Git commits via `/commit`.
- **[session-bus/](https://github.com/zmfkzj/pi-session-bus)** — git submodule that lets separate local Pi sessions exchange messages over Unix sockets and wake each other.

The root is a batch-install manifest, not an npm workspace. Each submodule keeps its own dependencies. Requires Node ≥22.19, git, and npm.

## Install

Local checkout:

```sh
git clone --recurse-submodules https://github.com/zmfkzj/oh-my-pi-extensions.git
cd oh-my-pi-extensions && npm install --legacy-peer-deps
pi install /path/to/oh-my-pi-extensions
# Or try all five without saving:
pi -e /path/to/oh-my-pi-extensions
```

The root postinstall bootstrap populates all submodules and installs their missing runtime dependencies. `--legacy-peer-deps` avoids duplicate copies of Pi's host-provided packages and `typebox`.

Remote install (bootstrap runs automatically):

```sh
pi install git:github.com/zmfkzj/oh-my-pi-extensions
pi update
```

Or install individual packages:

```sh
pi install git:github.com/zmfkzj/pi-orche
pi install git:github.com/zmfkzj/pi-browser
pi install git:github.com/zmfkzj/pi-commit
pi install git:github.com/zmfkzj/pi-session-bus
pi install npm:@amaster.ai/pi-computer-use
```

## Update

For a local clone, advance to the latest submodule branches:

```sh
git pull && git submodule update --init --remote
```

Alternatively, after `git pull`, rerun `npm install --legacy-peer-deps` to bootstrap the umbrella's recorded commits and missing dependencies. Bootstrap only syncs clean, detached submodules; branch checkouts or dirty worktrees are left untouched.

The GitHub Actions workflow updates submodules to their configured branches (`master` for orche/browser, `main` for pi-commit, session-bus and images, the pi-images provider bundled by orche) hourly (at minute 17), or on manual dispatch. Child repos can trigger it immediately via `repository_dispatch` with event type `submodule-updated` using a PAT; that PAT/child-repo setup is not configured yet.

See the linked package READMEs for configuration.
