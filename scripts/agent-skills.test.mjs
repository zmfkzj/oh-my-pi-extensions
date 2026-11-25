// The umbrella's skill manifest: pi-gui and session-bus ship their own usage skills (Pi's native skill discovery parses them),
// and the upstream computer-use-mcp skill is no longer registered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findPi, root, startPiSession } from "./pi-harness.mjs";

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("root pi.skills registers pi-gui and session-bus skills and not the upstream computer-use-mcp skill", () => {
  assert.deepEqual(manifest.pi.skills, ["./browser/skills", "./pi-gui/skills", "./session-bus/skills", "./pi-workbench/skills"]);
  assert.ok(!JSON.stringify(manifest.pi).includes("opencode-computer-use-mcp"));
});

test("Pi discovers the pi-gui and session-bus skills from the manifest paths", { timeout: 60_000 }, async t => {
  const h = await startPiSession(findPi(), {
    resourceOptions: { noSkills: false, additionalSkillPaths: manifest.pi.skills.filter(path => path.includes("pi-gui") || path.includes("session-bus")).map(path => join(root, path)) },
  });
  t.after(() => h.dispose());
  const { skills, diagnostics } = h.loader.getSkills();
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  assert.match(byName.get("pi-gui")?.description ?? "", /앱 실행·스크린샷.*orche_task gui:true/s, JSON.stringify(diagnostics));
  assert.match(byName.get("session-bus")?.description ?? "", /다른 세션에 알려줘.*session-bus 메시지에 답장/s, JSON.stringify(diagnostics));
  assert.ok(!byName.has("computer-use-mcp"), "the upstream skill is not registered");
});
