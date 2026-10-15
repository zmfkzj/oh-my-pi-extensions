// Dependency provider and `/computer-use doctor|install-deps` for @amaster.ai/pi-computer-use (the user's physical
// desktop; loaded through ../computer-use/index.js). It lives here, not in that wrapper, because the wrapper imports the
// npm package statically: when the package is missing the wrapper does not load, and this doctor must still run.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findExecutable, formatDependencyReport, insideNodeModules, outputTail, runProcess } from "./contract.js";

export const PACKAGE_NAME = "@amaster.ai/pi-computer-use";
export const COMPUTER_USE_COMMAND = "computer-use";
const SUPPORTED = new Set(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]);

/** The package's own target name (upstream resolveBundledTarget). */
export function driverTarget(platform, arch) {
  return platform === "darwin" ? "darwin-universal" : `${platform}-${arch}`;
}

/** Directory of `name`'s package.json resolved from `fromDir` like Node, or undefined. */
function packageDir(fromDir, name) {
  try { return dirname(createRequire(join(fromDir, "package.json")).resolve(`${name}/package.json`)); } catch { return undefined; }
}

function packageVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; } catch { return undefined; }
}

/** Upstream's driver binary inside the platform package (upstream resolveDriverLayout). */
export function bundledDriverBinary(driverDir, platform) {
  if (platform === "darwin") return join(driverDir, "bin", "CuaDriver.app", "Contents", "MacOS", "cua-driver");
  return join(driverDir, "bin", platform === "win32" ? "cua-driver.exe" : "cua-driver");
}

/**
 * @param {{ root: string, platform?: string, arch?: string, env?: Record<string, string|undefined>, run?: typeof runProcess,
 *   loadSettings?: (packageDir: string, ctx: any) => Promise<any> }} options
 */
export function createComputerUseProvider({ root, platform = process.platform, arch = process.arch, env = process.env, run = runProcess, loadSettings = defaultLoadSettings }) {
  const target = driverTarget(platform, arch);
  const npmAction = `Run /${COMPUTER_USE_COMMAND} install-deps (npm install --legacy-peer-deps in ${root}), then /reload`;
  const reconnect = "then /reload (or /computer-use-connect)";

  /** Read-only state, shared by check and install. */
  const inspect = async (ctx) => {
    const items = [];
    const state = { packageMissing: false, driverMissing: false, supported: SUPPORTED.has(`${platform}-${arch}`) };
    const pkgDir = packageDir(root, PACKAGE_NAME);
    if (!pkgDir) {
      state.packageMissing = true;
      items.push({ name: `npm package ${PACKAGE_NAME}`, status: "error", detail: `not installed under ${root}; the physical-desktop tools do not load`, action: npmAction });
    } else {
      items.push({ name: `npm package ${PACKAGE_NAME}`, status: "ok", detail: `v${packageVersion(pkgDir) ?? "?"}` });
    }
    if (!state.supported) {
      items.push({ name: "platform", status: "manual", detail: `${platform}-${arch} has no Cua Driver runtime package (supported: macOS x64/arm64, Linux x64/arm64, Windows x64/arm64)`, action: `Use a supported platform, or build a compatible cua-driver and set "pi-computer-use": { "mode": "path", "binaryPath": "/path/to/cua-driver" } in ~/.pi/agent/settings.json` });
    } else {
      items.push({ name: "platform", status: "ok", detail: `${platform}-${arch}` });
    }
    if (!pkgDir) return { items, state };

    let settings;
    try {
      settings = await loadSettings(pkgDir, ctx);
    } catch (error) {
      items.push({ name: "pi-computer-use settings", status: "error", detail: error instanceof Error ? error.message : String(error), action: `Fix the "pi-computer-use" section of ~/.pi/agent/settings.json (or the trusted project's .pi/settings.json), ${reconnect}` });
      return { items, state };
    }
    let binary;
    if (settings?.mode === "path" && settings.binaryPath) {
      binary = settings.binaryPath;
      if (!existsSync(binary)) {
        items.push({ name: "cua-driver (settings binaryPath)", status: "error", detail: `${binary} does not exist`, action: `Fix "pi-computer-use".binaryPath in settings.json, or remove "mode": "path" to use the bundled driver; ${reconnect}` });
        return { items, state };
      }
    } else if (state.supported) {
      const driverName = `${PACKAGE_NAME}-cua-driver-${target}`;
      const driverDir = packageDir(pkgDir, driverName);
      if (!driverDir) {
        state.driverMissing = true;
        items.push({ name: `driver package ${driverName}`, status: "error", detail: "not installed (npm skips it when its os/cpu/libc does not match, e.g. musl Linux)", action: npmAction });
        return { items, state };
      }
      binary = bundledDriverBinary(driverDir, platform);
      if (!existsSync(binary)) {
        state.driverMissing = true;
        items.push({ name: `driver package ${driverName}`, status: "error", detail: `${binary} is missing`, action: `Reinstall it: cd ${root} && npm install --legacy-peer-deps ${driverName}@${packageVersion(driverDir) ?? "latest"}, then /reload` });
        return { items, state };
      }
    } else {
      return { items, state };
    }
    const probe = await run(binary, ["--version"], { timeoutMs: 5_000, env });
    if (probe.code === 0) items.push({ name: "cua-driver", status: "ok", detail: `${probe.stdout.trim() || "runs"} (${binary})` });
    else items.push({ name: "cua-driver", status: "error", detail: `${binary} --version failed: ${outputTail(probe)}`, action: settings?.mode === "path" ? `Fix or replace the binary at "pi-computer-use".binaryPath; ${reconnect}` : `Reinstall the driver: cd ${root} && npm install --legacy-peer-deps, ${reconnect}` });

    if (platform === "linux") {
      const session = env.WAYLAND_DISPLAY ? `Wayland (${env.WAYLAND_DISPLAY})` : env.DISPLAY ? `X11 (${env.DISPLAY})` : undefined;
      items.push(session
        ? { name: "desktop session", status: "ok", detail: session }
        : { name: "desktop session", status: "warn", detail: "neither WAYLAND_DISPLAY nor DISPLAY is set in Pi's environment (e.g. SSH or a TTY)", action: "Start Pi from a terminal inside your graphical desktop session (the driver controls that session), then /computer-use-connect" });
    }
    const permissions = platform === "darwin"
      ? "On first use macOS asks to grant Accessibility and Screen Recording to com.trycua.driver (System Settings > Privacy & Security)"
      : "The driver checks accessibility/screen-capture access when it starts";
    items.push({ name: "desktop permissions", status: "unverified", detail: `not probed here (needs the running driver). ${permissions}`, action: "Verify with /computer-use-tools diagnostics, then ask the agent to run computer_use_check_permissions (or computer_use_health_report)" });
    return { items, state };
  };

  let installing;
  const install = async (ctx) => {
    const before = await inspect(ctx);
    if (!before.state.packageMissing && !before.state.driverMissing) {
      return { items: before.items.map(item => toInstallItem(item)) };
    }
    const items = [];
    const npm = platform === "win32" ? "npm.cmd" : "npm";
    if (insideNodeModules(root)) {
      items.push({ name: "npm dependencies", status: "manual", detail: "oh-my-pi-extensions is installed inside node_modules", action: "Reinstall it with pi install (or pi update --extensions), then /reload" });
    } else if (!findExecutable("npm", env)) {
      items.push({ name: "npm dependencies", status: "manual", detail: "npm is not on PATH", action: `Install Node.js with npm, then run: cd ${root} && npm install --legacy-peer-deps` });
    } else {
      const result = await run(npm, ["install", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: root, env, timeoutMs: 10 * 60_000, shell: platform === "win32" });
      const after = await inspect(ctx);
      const fixed = !after.state.packageMissing && !after.state.driverMissing;
      if (result.code !== 0 || !fixed) {
        items.push({ name: "npm dependencies", status: "failed", detail: `npm install exited ${result.code ?? "abnormally"}${fixed ? "" : "; package or driver still missing"}: ${outputTail(result)}`, action: `Run by hand and read the error: cd ${root} && npm install --legacy-peer-deps` });
        return { items: [...items, ...after.items.filter(item => item.status !== "error").map(toInstallItem)] };
      }
      items.push({ name: "npm dependencies", status: "installed", detail: `${PACKAGE_NAME} and its ${target} driver`, action: "Run /reload to load the physical-desktop tools" });
      return { items: [...items, ...after.items.filter(item => !item.name.startsWith("npm package")).map(toInstallItem)] };
    }
    return { items: [...items, ...before.items.filter(item => item.status !== "error").map(toInstallItem)] };
  };

  return {
    id: "computer-use",
    label: "pi-computer-use",
    command: `/${COMPUTER_USE_COMMAND}`,
    check: async (ctx) => ({ items: (await inspect(ctx)).items }),
    install: (ctx) => installing ??= install(ctx).finally(() => { installing = undefined; }),
  };
}

/** install()'s view of a check item: present => "ok (already available)", the rest needs the user. */
function toInstallItem(item) {
  if (item.status === "ok") return { ...item, detail: `already available${item.detail ? `: ${item.detail}` : ""}` };
  if (item.status === "error" || item.status === "warn") return { ...item, status: "manual" };
  return item;
}

/** Upstream's own settings loader (user settings, trusted project settings), imported from the installed package. */
async function defaultLoadSettings(pkgDir, ctx) {
  const { loadConfigFromFile, resolveConfig } = await import(pathToFileURL(join(pkgDir, "dist", "config.js")).href);
  return resolveConfig(loadConfigFromFile({ cwd: ctx?.cwd ?? process.cwd(), projectTrusted: ctx?.isProjectTrusted?.() === true }));
}

/** Register `/computer-use doctor|install-deps`. */
export function registerComputerUseCommand(pi, provider) {
  pi.registerCommand(COMPUTER_USE_COMMAND, {
    description: "Physical-desktop tools (pi-computer-use): /computer-use doctor | install-deps",
    getArgumentCompletions: (prefix) => {
      const items = ["doctor", "install-deps"].filter(item => item.startsWith(prefix.trim()));
      return items.length ? items.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action !== "doctor" && action !== "install-deps") return ctx.ui.notify("Usage: /computer-use doctor | install-deps", "warning");
      const mode = action === "doctor" ? "check" : "install";
      if (mode === "install") ctx.ui.setStatus?.(COMPUTER_USE_COMMAND, "computer-use: installing dependencies…");
      try {
        const report = mode === "check" ? await provider.check(ctx) : await provider.install(ctx);
        const { text, level } = formatDependencyReport(provider.label, report, mode);
        ctx.ui.notify(text, level);
      } finally {
        if (mode === "install") ctx.ui.setStatus?.(COMPUTER_USE_COMMAND, undefined);
      }
    },
  });
}
