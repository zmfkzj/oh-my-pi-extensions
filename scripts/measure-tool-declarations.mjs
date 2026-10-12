// Measures the tool declarations and system prompt of a main session's first model request, for the root manifest's
// orche and computer-use entries, through Pi's real loader with a faux model (no model call, no user settings).
// The physical-desktop driver is never started: pi-computer-use gets a missing custom binary, and its session_start runs
// with process.platform "darwin", where it registers its bundled tool manifest without starting the driver.
// Sizes are characters and UTF-8 bytes of the declaration JSON, not tokens or billing.
// Usage: node scripts/measure-tool-declarations.mjs [--json]
import { join } from "node:path";
import { declarationSize, findPi, manifestExtensions, startPiSession } from "./pi-harness.mjs";

const found = findPi();
if (!found) throw new Error("Pi not found; set PI_CODING_AGENT_DIR");
const extensionPaths = manifestExtensions(path => path.includes("computer-use") || path.startsWith("./orche/"));
const h = await startPiSession(found, {
  extensionPaths, platform: "darwin",
  settings: { "pi-computer-use": { mode: "path", binaryPath: join("/nonexistent", "cua-driver") } },
  steps: ai => [ai.fauxAssistantMessage("OK")],
});
try {
  await h.session.prompt("Reply OK");
  const { tools, systemPrompt } = h.requests[0];
  const group = (match) => declarationSize(tools.filter(tool => match(tool.name)));
  const result = {
    pi: found.version, extensions: extensionPaths.map(path => path.slice(path.indexOf("oh-my-pi-extensions") + 20)),
    all: declarationSize(tools),
    physicalDesktop: { ...group(name => name.startsWith("computer_use_")), names: tools.filter(tool => tool.name.startsWith("computer_use_")).map(tool => tool.name) },
    read: group(name => name === "read"),
    registeredPhysicalDesktopTools: h.session.getAllTools().filter(tool => tool.name.startsWith("computer_use_")).length,
    systemPrompt: { chars: systemPrompt.length, bytes: Buffer.byteLength(systemPrompt) },
  };
  if (process.argv.includes("--json")) console.log(JSON.stringify(result));
  else console.log(JSON.stringify(result, null, 2));
} finally {
  await h.dispose();
}
