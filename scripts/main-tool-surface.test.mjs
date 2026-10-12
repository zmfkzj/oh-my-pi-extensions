// What a main session's first model request declares, with the root manifest's orche and physical-desktop entries
// loaded through Pi's real loader (faux model, temporary agent dir, driver never started; see pi-harness.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { declarationSize, findPi, manifestExtensions, startPiSession } from "./pi-harness.mjs";

const found = findPi();
const skip = found ? false : "Pi (@earendil-works/pi-coding-agent with pi-ai) not found; set PI_CODING_AGENT_DIR";

test("main session: read's narrowing guidance and outline-first rule are declared; physical-desktop tools are not until loaded", { skip, timeout: 120_000 }, async (t) => {
  const h = await startPiSession(found, {
    extensionPaths: manifestExtensions(path => path.includes("computer-use") || path.startsWith("./orche/")), platform: "darwin",
    settings: { "pi-computer-use": { mode: "path", binaryPath: "/nonexistent/cua-driver" } },
    steps: ai => [ai.fauxAssistantMessage("OK")],
  });
  t.after(() => h.dispose());
  assert.deepEqual(h.loader.getExtensions().errors, []);
  await h.session.prompt("Reply OK");
  const [{ tools, systemPrompt }] = h.requests;
  const read = tools.find(tool => tool.name === "read");
  assert.match(read.description, /Without offset\/limit, a JS\/TS file over 16KB returns its declaration outline first; offset: 1 reads its text\./);
  assert.match(systemPrompt, /after grep, read offset\/limit around the matches; in a large JS\/TS\/Markdown file, outline then symbol\./);
  assert.match(systemPrompt, /Read small files, images and documents you must read completely in full/);
  const physical = tools.filter(tool => tool.name.startsWith("computer_use_"));
  assert.deepEqual(physical.map(tool => tool.name), ["computer_use_tools"]);
  assert.ok(declarationSize(physical).chars < 2_000, `physical-desktop declarations: ${declarationSize(physical).chars} chars`);
  assert.ok(h.session.getAllTools().filter(tool => tool.name.startsWith("computer_use_")).length > 50, "all of them stay registered");
});
