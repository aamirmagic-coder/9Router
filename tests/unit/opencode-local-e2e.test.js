import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  );
});

describe("opencode-local end-to-end request shape", () => {
  it("sends UA + session + fingerprint + stream:true to /inference", async () => {
    const ex = getExecutor("opencode-local");
    const body = {
      model: "space-bunny-free",
      messages: [{ role: "user", content: "ping" }],
    };
    const credentials = { connectionId: "e2e", rawHeaders: {} };
    const prepared = ex.prepareRequestCredentials({ body, credentials });
    const url = ex.buildUrl("space-bunny-free", true, 0, prepared);
    const outBody = ex.transformRequest("space-bunny-free", { ...body }, true, prepared);
    const headers = ex.buildHeaders(prepared, true, url, "space-bunny-free", outBody);

    expect(url).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(outBody.stream).toBe(true);
    const names = (outBody.tools || []).map((t) => t.function?.name || t.name);
    for (const n of ["bash", "glob", "grep", "read"]) expect(names).toContain(n);
    expect(headers["User-Agent"]).toMatch(/^opencode\//);
    expect(headers["x-opencode-session"]).toMatch(/^ses_/);

    await ex.execute({ model: "space-bunny-free", body, stream: true, credentials });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, opts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    const sent = JSON.parse(opts.body);
    expect(sent.stream).toBe(true);
    expect(sent.tools.length).toBeGreaterThanOrEqual(4);
    expect(opts.headers["x-opencode-session"]).toMatch(/^ses_/);
  });
});
