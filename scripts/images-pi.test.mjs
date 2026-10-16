// Real Pi image adapter and generate_image tool over loopback HTTP. No paid image generation.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findPi, manifestExtensions, startPiSession } from "./pi-harness.mjs";

const found = findPi();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
test("images: actual SDK/tool HTTP round-trip, hooks/auth, malformed zero-execution, abort and no billable retry", { timeout: 30_000 }, async t => {
  const requests = [];
  let held;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: req.url, headers: req.headers, body });
    if (body.prompt === "hold") { held?.(); return; }
    if (body.prompt === "fail") { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "unavailable" } })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: PNG }], usage: { input_tokens: 1, output_tokens: 2 } }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const h = await startPiSession(found, {
    extensionPaths: manifestExtensions(path => path.startsWith("./images/")),
    env: { CLIPROXYAPI_BASE_URL: `http://127.0.0.1:${server.address().port}/backend-api`, CLIPROXYAPI_API_KEY: "local-image-key" },
  });
  t.after(() => h.dispose());
  const path = join(h.cwd, "generated.png");
  h.respond(ai => [ai.fauxAssistantMessage(ai.fauxToolCall("generate_image", { prompt: "pixel", path }), { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")]);
  await h.session.prompt("Generate one image.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/v1/images/generations");
  assert.equal(requests[0].headers.authorization, "Bearer local-image-key");
  assert.equal(requests[0].body.prompt, "pixel");
  assert.equal(readFileSync(path).toString("base64"), PNG);
  const result = h.session.messages.find(m => m.role === "toolResult" && m.toolName === "generate_image");
  assert.equal(result.isError, false);
  assert.ok(result.content.some(block => block.type === "image" && block.data === PNG));

  // The real host validator rejects final parse errors before entering the image adapter.
  h.respond(ai => [ai.fauxAssistantMessage({ ...ai.fauxToolCall("generate_image", { prompt: "must not run" }), argumentsError: "Invalid tool call arguments JSON" }, { stopReason: "toolUse" }), ai.fauxAssistantMessage("recovered")]);
  await h.session.prompt("Attempt malformed tool call.");
  assert.equal(requests.length, 1);
  assert.equal(h.session.messages.findLast(m => m.role === "toolResult").isError, true);

  const runtime = h.runtime.services.modelRuntime;
  const image = runtime.getModelOfType("image", "cliproxyapi-images", "gpt-image-2.5");
  assert.ok(image);
  let payloads = 0, responses = 0;
  const generated = await runtime.generateImages(image, { input: [{ type: "text", text: "original" }] }, {
    onPayload(payload) { payloads++; return { ...payload, prompt: "hook replacement" }; },
    onResponse(response) { responses++; assert.equal(response.status, 200); }, headers: { "X-Image-Test": "hook" },
  });
  assert.equal(generated.stopReason, "stop");
  assert.equal(payloads, 1); assert.equal(responses, 1);
  assert.equal(requests.at(-1).body.prompt, "hook replacement");
  assert.equal(requests.at(-1).headers["x-image-test"], "hook");

  const before = requests.length;
  const failed = await runtime.generateImages(image, { input: [{ type: "text", text: "fail" }] });
  assert.equal(failed.stopReason, "error");
  assert.equal(requests.length, before + 1, "image requests must not retry potential charges");
  const controller = new AbortController();
  const reached = new Promise(resolve => { held = resolve; });
  const pending = runtime.generateImages(image, { input: [{ type: "text", text: "hold" }] }, { signal: controller.signal });
  await reached; controller.abort();
  assert.equal((await pending).stopReason, "aborted");
  assert.equal(requests.length, before + 2);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.blockedRequests, []);
});
