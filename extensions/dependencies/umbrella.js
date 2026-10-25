// The umbrella's batch commands: `/oh-my-pi doctor` and `/oh-my-pi install-deps` run every bundled package's dependency
// check or install (the contract in ./contract.js; each package answers on pi.events with its own provider) and report
// each package and an overall summary. A package that is not loaded in this session, throws or times out is reported
// as such, and never hides the other packages' results.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEPENDENCY_CHANNEL, DEPENDENCY_CONTRACT_VERSION, dependencyLevel, dependencyOutcome, formatDependencyItems,
  installNpmDependencies, missingNpmDependencies,
} from "./contract.js";

/**
 * Every package of the root manifest's `pi.extensions`, in manifest order, except the dependencies extension itself and
 * pi-tmp (no dependencies, no command; it only sets TMPDIR).
 * `dir` is relative to the umbrella root; `entry` is the manifest path.
 */
export const PACKAGES = Object.freeze([
  { id: "orche", label: "pi-orche", command: "/orche", entry: "./orche/src/extension/index.ts", dir: "orche" },
  { id: "browser", label: "pi-browser", command: "/browser", entry: "./browser/src/extension/index.ts", dir: "browser" },
  { id: "computer-use", label: "pi-computer-use", command: "/computer-use", entry: "./extensions/computer-use/index.js", dir: "." },
  { id: "pi-gui", label: "pi-gui", command: "/gui", entry: "./pi-gui/src/index.ts", dir: "pi-gui" },
  { id: "pi-commit", label: "pi-commit", command: "/commit", entry: "./pi-commit/src/index.ts", dir: "pi-commit" },
  { id: "session-bus", label: "pi-session-bus", command: "/bus", entry: "./session-bus/src/index.ts", dir: "session-bus" },
  { id: "images", label: "pi-gateway-images", command: "/images", entry: "./images/src/index.ts", dir: "images" },
  { id: "pi-workbench", label: "pi-workbench", command: "/workbench", entry: "./pi-workbench/index.js", dir: "pi-workbench" },
  { id: "codegraph", label: "pi-codegraph", command: "/codegraph", entry: "./codegraph/src/index.ts", dir: "codegraph" },
  { id: "cliproxyapi", label: "pi-cliproxyapi-bundle", command: "/cliproxyapi", entry: "./cliproxyapi/src/index.ts", dir: "cliproxyapi" },
]);
export const UMBRELLA_COMMAND = "oh-my-pi";
export const UMBRELLA_USAGE = `Usage: /${UMBRELLA_COMMAND} doctor [package...] | install-deps [package...]  (packages: ${PACKAGES.map(pkg => pkg.id).join(", ")}; default: all)`;
export const CHECK_TIMEOUT_MS = 60_000;
export const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * Ask every loaded package for its provider. Answers arrive synchronously inside emit (the contract); the first
 * provider of an id wins, later ones are counted as duplicates.
 * @param {{ emit(channel: string, data: unknown): void }} events
 */
export function collectProviders(events) {
  /** @type {Map<string, import("./contract.js").DependencyProvider>} */
  const providers = new Map();
  /** @type {Map<string, number>} */
  const duplicates = new Map();
  events.emit(DEPENDENCY_CHANNEL, {
    version: DEPENDENCY_CONTRACT_VERSION,
    provide: (provider) => {
      if (!provider || typeof provider.id !== "string" || typeof provider.check !== "function" || typeof provider.install !== "function") return;
      if (providers.has(provider.id)) duplicates.set(provider.id, (duplicates.get(provider.id) ?? 0) + 1);
      else providers.set(provider.id, provider);
    },
  });
  return { providers, duplicates };
}

/**
 * The report for a package that did not answer: why it is not loaded, as far as the files tell, and what to do.
 * install mode also installs its missing npm dependencies (what the root bootstrap would do), so it loads after /reload.
 */
export async function missingPackageReport(pkg, root, mode, { installNpm = installNpmDependencies, signal } = {}) {
  const dir = join(root, pkg.dir);
  const reload = "then /reload (or start a new session) to load it";
  if (!existsSync(join(dir, "package.json"))) {
    return { note: "Not loaded in this session: its files are missing.", items: [{
      name: "package files", status: mode === "check" ? "error" : "manual", detail: `${dir}/package.json not found (submodule not populated)`,
      action: `Run in ${root}: git submodule update --init ${pkg.dir} && npm install --legacy-peer-deps (a pi install updates it with: pi update --extensions); ${reload}`,
    }] };
  }
  let missing;
  try { missing = missingNpmDependencies(dir).required; } catch (error) { missing = []; }
  if (missing.length > 0) {
    if (mode === "check") {
      return { note: "Not loaded in this session: its npm dependencies are missing.", items: [{
        name: "npm dependencies", status: "error", detail: `missing ${missing.join(", ")} in ${dir}`,
        action: `Run /${UMBRELLA_COMMAND} install-deps ${pkg.id} (npm install --legacy-peer-deps in ${dir}), ${reload}`,
      }] };
    }
    const items = await installNpm(dir, { signal });
    return { note: "Not loaded in this session: installed its npm dependencies; its own install-deps runs once it is loaded.", items: [
      ...items,
      { name: "package loaded", status: "manual", detail: "not loaded in this session", action: `Run /reload, then /${UMBRELLA_COMMAND} install-deps ${pkg.id} again for its other dependencies` },
    ] };
  }
  return { note: "Not loaded in this session.", items: [{
    name: "package loaded", status: mode === "check" ? "error" : "manual", detail: `${pkg.entry} did not answer (load error, or filtered out in Pi's settings)`,
    action: `Look for an extension error about ${pkg.entry} in Pi's startup output; if settings.json limits this package's extensions (packages[].extensions), include it; ${reload}`,
  }] };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} s (it may still be running in the background)`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function validReport(report) {
  return !!report && Array.isArray(report.items) && report.items.every(item => item && typeof item.name === "string" && typeof item.status === "string");
}

/**
 * Run one mode over the selected packages. check runs them concurrently, install one after another (installers may
 * share npm, downloads and the status line). Every package gets a result, whatever the others do.
 * @returns {Promise<Array<{ pkg: typeof PACKAGES[number], state: "loaded" | "not loaded", report: import("./contract.js").DependencyReport }>>}
 */
export async function runPackages(mode, ctx, { providers, root, packages = PACKAGES, timeoutMs, installNpm, onProgress }) {
  const limit = timeoutMs ?? (mode === "check" ? CHECK_TIMEOUT_MS : INSTALL_TIMEOUT_MS);
  const runOne = async (pkg, index) => {
    onProgress?.(pkg, index, packages.length);
    const provider = providers.get(pkg.id);
    if (!provider) {
      try {
        return { pkg, state: "not loaded", report: await withTimeout(missingPackageReport(pkg, root, mode, { installNpm }), limit, `${pkg.label} ${mode}`) };
      } catch (error) {
        return { pkg, state: "not loaded", report: failureReport(pkg, mode, error) };
      }
    }
    try {
      const report = await withTimeout(Promise.resolve().then(() => mode === "check" ? provider.check(ctx) : provider.install(ctx)), limit, `${pkg.label} ${mode === "check" ? "doctor" : "install-deps"}`);
      if (!validReport(report)) throw new Error(`${pkg.label} returned an invalid report`);
      return { pkg, state: "loaded", report };
    } catch (error) {
      return { pkg, state: "loaded", report: failureReport(pkg, mode, error) };
    }
  };
  if (mode === "check") return Promise.all(packages.map(runOne));
  const results = [];
  for (const [index, pkg] of packages.entries()) results.push(await runOne(pkg, index));
  return results;
}

function failureReport(pkg, mode, error) {
  const message = error instanceof Error ? error.message : String(error);
  return { items: [{
    name: mode === "check" ? "health check" : "dependency install", status: mode === "check" ? "error" : "failed", detail: message,
    action: `Run ${pkg.command} ${mode === "check" ? "doctor" : "install-deps"} on its own for details; if it keeps failing, check Pi's output for the error`,
  }] };
}

/** Outcome of one package result, with "not loaded" for a package that did not answer. */
export function resultOutcome(result, mode) {
  return result.state === "not loaded" ? "not loaded" : dependencyOutcome(result.report, mode);
}

/** The aggregate report: summary line, one section per package, and what to do next. */
export function formatAggregate(results, mode, { duplicates = new Map() } = {}) {
  const name = mode === "check" ? "doctor" : "install-deps";
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const result of results) {
    const outcome = resultOutcome(result, mode);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const order = mode === "check"
    ? ["healthy", "no external dependencies", "abnormal", "warning", "manual action required", "unverified", "not loaded"]
    : ["installed", "already available", "no external dependencies", "failed", "manual action required", "warning", "unverified", "not loaded"];
  const summary = [...order.filter(key => counts.has(key)), ...[...counts.keys()].filter(key => !order.includes(key))].map(key => `${counts.get(key)} ${key}`).join(", ");
  const lines = [`/${UMBRELLA_COMMAND} ${name}: ${results.length} package${results.length === 1 ? "" : "s"}: ${summary}`];
  const attention = [];
  for (const result of results) {
    const outcome = resultOutcome(result, mode);
    const duplicate = duplicates.get(result.pkg.id) ? ` (answered ${duplicates.get(result.pkg.id) + 1} times: loaded more than once; the first is shown)` : "";
    lines.push("", `[${result.pkg.id}] ${result.pkg.label}: ${outcome}  (${result.pkg.command} ${name})${duplicate}`);
    lines.push(...formatDependencyItems(result.report, "  "));
    if (!["healthy", "no external dependencies", "installed", "already available"].includes(outcome)) attention.push(`${result.pkg.id} (${outcome})`);
  }
  lines.push("");
  lines.push(attention.length ? `Needs attention: ${attention.join(", ")}. Follow the "->" actions above.` : "Nothing needs attention.");
  if (mode === "install" && results.some(result => result.report.items.some(item => item.status === "installed"))) lines.push("Something was installed: run /reload so loaded packages use it.");
  return { text: lines.join("\n"), level: aggregateLevel(results) };
}

export function aggregateLevel(results) {
  const levels = results.map(result => result.state === "not loaded" ? "error" : dependencyLevel(result.report));
  return levels.includes("error") ? "error" : levels.includes("warning") ? "warning" : "info";
}

/** Parse `/oh-my-pi` arguments. */
export function parseUmbrellaArgs(args) {
  const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!action || action === "help") return { kind: "help" };
  if (action !== "doctor" && action !== "install-deps") return { kind: "error", message: `Unknown subcommand ${action}. ${UMBRELLA_USAGE}` };
  const ids = [...new Set(rest)];
  const unknown = ids.filter(id => !PACKAGES.some(pkg => pkg.id === id));
  if (unknown.length) return { kind: "error", message: `Unknown package ${unknown.join(", ")}. ${UMBRELLA_USAGE}` };
  return { kind: action === "doctor" ? "check" : "install", packages: ids.length ? PACKAGES.filter(pkg => ids.includes(pkg.id)) : [...PACKAGES] };
}

export function completeUmbrellaArgs(prefix) {
  const words = prefix.trimStart().split(/\s+/);
  if (words.length <= 1) {
    const items = ["doctor", "install-deps", "help"].filter(item => item.startsWith(words[0] ?? ""));
    return items.length ? items.map(value => ({ value, label: value })) : null;
  }
  if (words[0] !== "doctor" && words[0] !== "install-deps") return null;
  const typed = words.at(-1);
  const chosen = new Set(words.slice(1, -1));
  const head = words.slice(0, -1).join(" ");
  const items = PACKAGES.filter(pkg => !chosen.has(pkg.id) && pkg.id.startsWith(typed)).map(pkg => ({ value: `${head} ${pkg.id}`, label: pkg.id, description: pkg.label }));
  return items.length ? items : null;
}

/** Register `/oh-my-pi`. `root` is the umbrella checkout. */
export function registerUmbrellaCommand(pi, { root, timeouts = {}, installNpm }) {
  let installing;
  pi.registerCommand(UMBRELLA_COMMAND, {
    description: "Check (doctor) or install (install-deps) the external dependencies of every bundled package: /oh-my-pi doctor|install-deps [package...]",
    getArgumentCompletions: completeUmbrellaArgs,
    handler: async (args, ctx) => {
      const parsed = parseUmbrellaArgs(args);
      if (parsed.kind === "help") return ctx.ui.notify(UMBRELLA_USAGE, "info");
      if (parsed.kind === "error") return ctx.ui.notify(parsed.message, "warning");
      if (parsed.kind === "install" && installing) return ctx.ui.notify(`/${UMBRELLA_COMMAND} install-deps is already running; wait for its report.`, "warning");
      const { providers, duplicates } = collectProviders(pi.events);
      const run = async () => {
        try {
          const results = await runPackages(parsed.kind, ctx, {
            providers, root, packages: parsed.packages, installNpm,
            timeoutMs: parsed.kind === "check" ? timeouts.check : timeouts.install,
            onProgress: (pkg, index, total) => ctx.ui.setStatus?.(UMBRELLA_COMMAND, parsed.kind === "check" ? `doctor: checking ${total} packages…` : `install-deps: ${pkg.label} (${index + 1}/${total})…`),
          });
          const { text, level } = formatAggregate(results, parsed.kind, { duplicates });
          ctx.ui.notify(text, level);
          return results;
        } finally {
          ctx.ui.setStatus?.(UMBRELLA_COMMAND, undefined);
        }
      };
      if (parsed.kind === "check") return void await run();
      installing = run().finally(() => { installing = undefined; });
      await installing;
    },
  });
}
