// Operator-facing failure line: the mapped verdict leads, the upstream text follows.
//
// Break caught: the operator read "Authentication failed. Please check your
// credentials." — Command Code's wording for a model gate that never used the
// credential — and went looking for a bad key while the model was gated by
// something else entirely. The client body already carried the mapped verdict;
// the log line did not.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("../../src/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

const GATE_MESSAGE = "Authentication failed. Please check your credentials.";
const GATE_BODY = { error: { message: GATE_MESSAGE, type: "permission_error" } };

function captureLog() {
  const lines = [];
  const log = Object.assign((...args) => lines.push(args.join(" ")), {
    debug: () => {},
    info: () => {},
    warn: () => {},
    line: () => {},
    errorLine: (tag, mark, text) => lines.push(`${mark} ${text}`),
    tagForSession: () => "TAG",
    nextTag: () => "TAG",
  });
  return { log, lines };
}

beforeEach(() => {
  mocks.proxyAwareFetch.mockReset();
});

describe("chatCore failure line", () => {
  it("leads with the mapped verdict and keeps the upstream wording behind it", async () => {
    const executor = { response: new Response(JSON.stringify(GATE_BODY), { status: 403 }) };
    mocks.proxyAwareFetch.mockResolvedValue(executor.response);
    const { log, lines } = captureLog();

    const result = await handleChatCore({
      body: { model: "meta/muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 16 },
      modelInfo: { provider: "commandcode", model: "meta/muse-spark-1.3-contributor" },
      credentials: { apiKey: "user_test", connectionId: "conn-1", connectionName: "playground" },
      connectionId: "conn-1",
      log,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    });

    const line = lines.find((entry) => entry.includes("ERROR 403"));
    expect(line).toBeTruthy();
    expect(line).toContain("Command Code is not serving this model right now");
    expect(line).toContain(`upstream: ${GATE_MESSAGE}`);
    // The client still gets the mapped verdict from the response body.
    expect(result.status).toBe(403);
    await expect(result.response.clone().json()).resolves.toMatchObject({
      error: { type: "permission_error", code: "model_not_available" },
    });
  });

  it("keeps an ordinary upstream error line unchanged", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 })
    );
    const { log, lines } = captureLog();

    await handleChatCore({
      body: { model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 16 },
      modelInfo: { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" },
      credentials: { apiKey: "user_test", connectionId: "conn-1", connectionName: "playground" },
      connectionId: "conn-1",
      log,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    });

    const line = lines.find((entry) => entry.includes("ERROR 400"));
    expect(line).toContain("[400]: bad request");
    expect(line).not.toContain("upstream:");
  });
});
