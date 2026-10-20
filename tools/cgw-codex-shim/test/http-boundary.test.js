import test from "node:test";
import assert from "node:assert/strict";
import { validateChatRequest, parseBearerToken, readJsonBody } from "../http.js";

test("accepts exactly one plain user message", () => {
  const result = validateChatRequest({
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  }, { "gpt-test": "native-test" });
  assert.deepEqual(result, { model: "native-test", prompt: "hello" });
});

test("rejects unsupported roles, tools, and multimodal content", () => {
  assert.throws(() => validateChatRequest({ model: "gpt-test", messages: [{ role: "system", content: "x" }] }, { "gpt-test": "native-test" }), /user message/);
  assert.throws(() => validateChatRequest({ model: "gpt-test", tools: [], messages: [{ role: "user", content: "x" }] }, { "gpt-test": "native-test" }), /tools/);
  assert.throws(() => validateChatRequest({ model: "gpt-test", messages: [{ role: "user", content: [{ type: "image_url" }] }] }, { "gpt-test": "native-test" }), /text/);
});

test("parses bearer authentication without accepting malformed values", () => {
  assert.equal(parseBearerToken("Bearer secret"), "secret");
  assert.equal(parseBearerToken("Basic secret"), null);
  assert.equal(parseBearerToken("Bearer"), null);
});

test("reads bounded JSON bodies", async () => {
  const request = new Request("http://127.0.0.1", {
    method: "POST",
    body: JSON.stringify({ hello: "world" }),
  });
  assert.deepEqual(await readJsonBody(request, 1024), { hello: "world" });
  await assert.rejects(() => readJsonBody(new Request("http://127.0.0.1", {
    method: "POST",
    body: "x".repeat(20),
  }), 5), /body too large/);
});
