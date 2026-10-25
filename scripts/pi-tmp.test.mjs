// pi-tmp in the umbrella: it is the manifest's first extension, and through Pi's own loader every extension loaded after
// it sees its TMPDIR already at module evaluation (module-level constants such as orche's DEFAULT_SCRATCH_BASE).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findPi, manifestExtensions, root, startPiSession } from "./pi-harness.mjs";
// The submodule's own unit tests, so the root `npm test` covers them too.
import "../pi-tmp/test/index.test.mjs";

test("pi-tmp is the root manifest's first extension, ahead of orche and cliproxyapi", () => {
  const { extensions } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pi;
  assert.equal(extensions[0], "./pi-tmp/index.js");
  assert.equal(extensions.filter(path => path === "./pi-tmp/index.js").length, 1);
  assert.ok(extensions.includes("./orche/src/extension/index.ts") && extensions.includes("./cliproxyapi/src/index.ts"));
});

test("through Pi's loader, a later extension sees pi-tmp's directory at module evaluation and in its children", { timeout: 120_000 }, async (t) => {
  const fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "omp-pi-tmp-")));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  const fixture = join(fixtureDir, "later.mjs");
  writeFileSync(fixture, [
    'import { execFileSync } from "node:child_process";',
    'import { tmpdir } from "node:os";',
    "const atImport = tmpdir();",
    "export default function () {",
    '  globalThis.__piTmpProbe = { atImport, child: execFileSync("sh", ["-c", "printf %s \\"$TMPDIR\\""], { encoding: "utf8" }) };',
    "}",
  ].join("\n"));
  const before = process.env.TMPDIR;
  const h = await startPiSession(findPi(), {
    extensionPaths: [...manifestExtensions(path => path === "./pi-tmp/index.js"), fixture], bind: false,
  });
  t.after(() => { delete globalThis.__piTmpProbe; });
  try {
    assert.deepEqual(h.loader.getExtensions().errors, []);
    const expected = join(h.cwd, "pi-tmp");
    assert.equal(process.env.TMPDIR, expected);
    assert.equal(statSync(expected).mode & 0o777, 0o700);
    assert.deepEqual(globalThis.__piTmpProbe, { atImport: expected, child: expected });
  } finally {
    await h.dispose();
  }
  assert.equal(process.env.TMPDIR, before, "the harness restores TMPDIR");
});
