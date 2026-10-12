# Changelog

## [Unreleased]

### Changed

- Added the official CLIProxyAPI provider `@router-for-me/pi-cliproxyapi-provider` (npm dependency `^1.4.22`, lockfile 1.4.22) through the `cliproxyapi/` bundle entry, which loads nothing when the same package is also installed on its own in Pi's settings (`PI_CLIPROXYAPI_BUNDLED=auto|on|off`).
- orche workers and sub-workers get the project's CodeGraph tools: pi-codegraph answers orche's new `codegraph` worker capability with the worker's own MCP connection (the user's `codegraph` mcp.json entry, made direct, or `codegraph serve --mcp`); pi-gui and pi-codegraph share one worker MCP extension factory, which orche loads once.
- Added the pi-codegraph extension (`codegraph/`, in-repo package): CodeGraph's `codegraph_explore` MCP tool through Pi's built-in MCP for indexed projects, and `/codegraph status|init|sync`. Needs the `codegraph` CLI; an existing `codegraph` server in `mcp.json` keeps precedence.
- Added the pi-workbench extension (`wb-*` skill routes, `/workbench`) as a bundled submodule.
- Added the pi-gui extension (private computer-use desktops per agent, `orche_task gui`) as a bundled submodule.
- Added the pi-session-bus extension as a bundled submodule.

