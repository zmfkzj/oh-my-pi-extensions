# Changelog

## [Unreleased]

### Changed

- Updated orche to use Pi's builtin, models.json and extension providers in workers, including request-time authentication; obsolete missing providerExtensions packages warn rather than blocking inherited providers.

- Added the official CLIProxyAPI provider `@router-for-me/pi-cliproxyapi-provider` through the pi-cliproxyapi-bundle extension (`cliproxyapi/`, bundled submodule `zmfkzj/pi-cliproxyapi-bundle`; the provider is its npm dependency `^1.4.22`, locked at 1.4.22; no root dependency), which loads nothing when the same package is also installed on its own in Pi's settings (`PI_CLIPROXYAPI_BUNDLED=auto|on|off`).
- The bundled provider updates itself: pi-cliproxyapi-bundle's `update-provider` workflow moves `package.json` + `package-lock.json` to a new npm release of the provider and commits only after typecheck and tests pass; the hourly "Update submodules" workflow then moves the `cliproxyapi` gitlink.
- orche workers and sub-workers get the project's CodeGraph tools: pi-codegraph answers orche's new `codegraph` worker capability with the worker's own MCP connection (the user's `codegraph` mcp.json entry, made direct, or `codegraph serve --mcp`); pi-gui and pi-codegraph share one worker MCP extension factory, which orche loads once.
- Added the pi-codegraph extension (`codegraph/`, bundled submodule `zmfkzj/pi-codegraph`): CodeGraph's `codegraph_explore` MCP tool through Pi's built-in MCP for indexed projects, and `/codegraph status|init|sync`. Needs the `codegraph` CLI; an existing `codegraph` server in `mcp.json` keeps precedence.
- Added the pi-workbench extension (`wb-*` skill routes, `/workbench`) as a bundled submodule.
- Added the pi-gui extension (private computer-use desktops per agent, `orche_task gui`) as a bundled submodule.
- Added the pi-session-bus extension as a bundled submodule.

