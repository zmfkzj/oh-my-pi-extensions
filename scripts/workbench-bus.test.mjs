// Actual Workbench and session-bus entrypoints, native skills/lifecycle, real Unix socket and queue store; faux model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createEndpoint, createNote, createQueueStore, deriveId, listSockets, sendNote, sendQueueNudge, queueKey } from "../session-bus/src/core/index.ts";
import { SKILL_MARKER } from "../pi-workbench/lib/runtime.js";
import { findPi, manifestExtensions, root, startPiSession } from "./pi-harness.mjs";

const found = findPi();
const text = message => typeof message.content === "string" ? message.content : (message.content ?? []).map(block => block.text ?? "").join("\n");
async function waitFor(probe) {
  const until = Date.now() + 5000;
  while (!probe()) { if (Date.now() > until) throw new Error("timed out waiting for bus/queue"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("Workbench selection survives bus wake, is consumed once by queue replay, and clears on native lifecycle changes", { timeout: 60_000 }, async t => {
  const h = await startPiSession(found, {
    extensionPaths: manifestExtensions(path => path.startsWith("./session-bus/") || path.startsWith("./pi-workbench/")),
    persistent: true, resourceOptions: { noSkills: false, additionalSkillPaths: [join(root, "pi-workbench/skills")] },
    setup({ cwd }) { execFileSync("git", ["init", "--quiet", cwd]); },
  });
  t.after(() => h.dispose());
  const busDir = join(h.agentDir, "session-bus");
  assert.ok(h.loader.getSkills().skills.some(skill => skill.name === "wb-coding"), "native skill discovery, not a fake skill list");
  const self = listSockets(busDir)[0];
  assert.ok(self, "real session-bus endpoint starts");
  const peerId = "fixture-peer-session";
  const peer = createEndpoint({ busDir, sessionId: peerId,
    getPeerInfo: () => ({ cwd: h.cwd, name: "fixture peer", busy: false, autoWake: true }),
    onNote: () => ({ v: 1, ok: true, status: "delivered", wake: "suppressed" }),
  });
  await peer.start(); t.after(() => peer.stop());
  const peerEndpoint = listSockets(busDir).find(entry => entry.id === deriveId(peerId, process.pid));
  await h.session.prompt("/workbench skill ponytail-review");
  h.respond(ai => [ai.fauxAssistantMessage("noted")]);
  const note = createNote({ from: { id: peerEndpoint.id, sessionId: peerId, cwd: h.cwd, name: "fixture peer", replyable: true }, to: self.id, content: "WAKE-NOTE", hops: 1 });
  const sent = await sendNote(self.path, note);
  assert.equal(sent.wake, "started");
  await waitFor(() => h.requests.length === 1); await h.session.waitForIdle();
  assert.ok(!h.requests[0].messages.map(text).join("\n").includes(SKILL_MARKER), "custom wake cannot consume a user one-shot");

  const store = createQueueStore({ busDir, repo: h.cwd });
  const holder = await store.enqueue({ endpointId: peerEndpoint.id, pid: process.pid, sessionId: peerId, title: "holding" });
  await h.session.prompt("/queue on");
  await h.session.prompt("QUEUED-USER-REQUEST", { source: "interactive" });
  assert.equal(h.requests.length, 1, "queued user input has not reached the model");
  h.respond(ai => [ai.fauxAssistantMessage("completed queued work")]);
  await store.removeIfSameId(holder.entry.id);
  await sendQueueNudge(self.path, queueKey(h.cwd));
  await waitFor(() => h.requests.length === 2); await h.session.waitForIdle();
  const replay = h.requests[1].messages.filter(message => message.role === "user").find(message => text(message).includes("QUEUED-USER-REQUEST"));
  assert.ok(replay);
  assert.match(text(replay), /ponytail-review/);
  assert.equal(h.requests[1].messages.map(text).join("\n").split(SKILL_MARKER).length - 1, 1);
  h.respond(ai => [ai.fauxAssistantMessage("later")]);
  await h.session.prompt("LATER-REQUEST");
  assert.equal(text(h.requests.at(-1).messages.filter(message => message.role === "user").at(-1)), "LATER-REQUEST");

  await h.session.prompt("/queue done");
  await h.session.prompt("/workbench skill ponytail");
  await h.session.reload();
  assert.equal(listSockets(busDir).filter(entry => entry.id !== peerEndpoint.id).length, 1, "one endpoint after reload");
  h.respond(ai => [ai.fauxAssistantMessage("after reload")]);
  await h.session.prompt("AFTER-RELOAD");
  assert.equal(text(h.requests.at(-1).messages.filter(message => message.role === "user").at(-1)), "AFTER-RELOAD");
  await h.session.prompt("/workbench skill ponytail");
  await h.runtime.newSession();
  h.respond(ai => [ai.fauxAssistantMessage("new session")]);
  await h.session.prompt("NEW-SESSION");
  assert.ok(!h.requests.at(-1).messages.map(text).join("\n").includes(SKILL_MARKER));
  assert.deepEqual(h.errors, []);
  await peer.stop();
  // Native runtime shutdown must remove the live socket, before scratch deletion by the harness.
  await h.runtime.dispose();
  assert.deepEqual(listSockets(busDir), []);
  assert.deepEqual(store.read().entries, []);
});
