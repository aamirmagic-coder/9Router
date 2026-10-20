import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../server.js";

function testConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    apiKey: "test-key",
    modelAliases: { "gpt-test": "native-test" },
    limits: { maxBodyBytes: 64 * 1024, maxConcurrent: 1, maxQueue: 2, timeoutMs: 1000 },
    native: { shell: false, baseUrl: "http://127.0.0.1:20128/v1" },
    ...overrides,
  };
}

async function withServer(executeTurn, callback, config = testConfig()) {
  const runtime = await startServer({ config, executeTurn });
  try {
    return await callback(`http://${runtime.address.address}:${runtime.address.port}`);
  } finally {
    await runtime.close();
  }
}

function headers() {
  return { authorization: "Bearer test-key", "content-type": "application/json" };
}

test("lists only configured aliases and requires auth", async () => {
  await withServer(async () => ({ text: "unused", dispatchStarted: true }), async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/v1/models`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: "Bearer test-key" } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((item) => item.id), ["gpt-test"]);
  });
});

test("returns a non-stream chat completion", async () => {
  await withServer(async ({ model, prompt }) => {
    assert.equal(model, "native-test");
    assert.equal(prompt, "hello");
    return { text: "hello back", dispatchStarted: true };
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, "gpt-test");
    assert.equal(body.choices[0].message.content, "hello back");
  });
});

test("returns valid buffered SSE", async () => {
  await withServer(async () => ({ text: "streamed", dispatchStarted: true }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /data: \{.*"delta".*streamed.*\}/);
    assert.match(text, /data: \[DONE\]/);
  });
});

test("rejects context and multimodal input before execution", async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; return { text: "bad", dispatchStarted: true }; }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "gpt-test", messages: [
        { role: "user", content: "old" },
        { role: "user", content: "new" },
      ] }),
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  });
});

test("marks native failures as non-replayable after dispatch", async () => {
  await withServer(async () => {
    const error = new Error("native failed");
    error.dispatchStarted = true;
    throw error;
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-9router-no-replay"), "1");
  });
});

test("shares concurrency and queue limits across requests", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    await gate;
    return { text: "ok", dispatchStarted: true };
  }, async (baseUrl) => {
    const request = () => fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }] }),
    });

    const first = request();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = request();
    const third = request();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 1);

    release();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal((await third).status, 429);
  }, testConfig({ limits: { maxBodyBytes: 64 * 1024, maxConcurrent: 1, maxQueue: 1, timeoutMs: 1000 } }));
});

test("aborts active turns during server shutdown", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const runtime = await startServer({
    config: testConfig(),
    executeTurn: ({ signal }) => new Promise((_, reject) => {
      started();
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const baseUrl = `http://${runtime.address.address}:${runtime.address.port}`;
  const responsePromise = fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }] }),
  });

  await startedPromise;
  await runtime.close();
  assert.equal((await responsePromise).status, 502);
});
