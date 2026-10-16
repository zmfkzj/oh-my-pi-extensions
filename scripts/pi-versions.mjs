// Fail-closed preflight for the compatibility gate, including package-local SDKs (not just the root harness's host).
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packages = ["orche", "browser", "pi-gui", "pi-commit", "session-bus", "images", "codegraph", "cliproxyapi"];
const json = path => JSON.parse(readFileSync(path, "utf8"));
export function checkPiVersions(expected = "1.3.0") {
  const evidence = [];
  for (const sub of packages) {
    const dir = join(root, sub), manifest = json(join(dir, "package.json"));
    const dev = Object.entries(manifest.devDependencies).filter(([name]) => name.startsWith("@earendil-works/pi-"));
    const lock = sub === "pi-commit" ? undefined : json(join(dir, "package-lock.json"));
    const bunLock = sub === "pi-commit" ? readFileSync(join(dir, "bun.lock"), "utf8") : undefined;
    for (const [name, version] of dev) {
      assert.equal(version, expected, `${sub}: declared ${name}`);
      assert.equal(manifest.dependencies?.[name], undefined, `${sub}: ${name} must remain host-provided, not a runtime dependency`);
      if (manifest.peerDependencies?.[name]) assert.equal(manifest.peerDependencies[name], "*", `${sub}: preserve peer range`);
      if (lock) {
        assert.equal(lock.packages[""].devDependencies[name], expected, `${sub}: lock root ${name}`);
        assert.equal(lock.packages[`node_modules/${name}`].version, expected, `${sub}: lock resolution ${name}`);
      } else {
        assert.ok(bunLock.includes(`"${name}": "${expected}"`), `bun.lock root ${name}`);
        assert.ok(bunLock.includes(`"${name}": ["${name}@${expected}"`), `bun.lock resolution ${name}`);
      }
    }
    // Resolve as the suite does; no silent global SDK and no host 1.3 + AI 1.2 split.
    for (const name of new Set([...dev.map(([name]) => name), "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"])) {
      const entry = realpathSync(findPackageJSON(name, pathToFileURL(join(dir, "package.json"))));
      const actual = json(entry);
      assert.equal(actual.name, name);
      assert.equal(actual.version, expected, `${sub}: ${name} resolved at ${entry}`);
      const line = `${sub}: ${name}@${actual.version} -> ${entry}`;
      evidence.push(line); console.log(line);
    }
  }
  return evidence;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkPiVersions();
