import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";

function sseOk() {
  const body = 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(sseOk());
});

describe("opencode-local provider", () => {
  it("registers with the /inference lane, forceStream and noAuth", () => {
    const p = PROVIDERS["opencode-local"];
    expect(p).toBeDefined();
    expect(p.baseUrl).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(p.forceStream).toBe(true);
    expect(p.noAuth).toBe(true);
  });

  it('resolves alias "ocl" to opencode-local', () => {
    expect(resolveProviderAlias("ocl")).toBe("opencode-local");
  });

  it("executor pins every model to the /inference URL", () => {
    const ex = getExecutor("opencode-local");
    expect(ex.constructor.name).toBe("OpenCodeLocalExecutor");
    expect(ex.buildUrl("space-bunny-free")).toBe(
      "https://opencode.ai/inference/openai/v1/chat/completions"
    );
    expect(ex.buildUrl("big-pickle")).toBe(
      "https://opencode.ai/inference/openai/v1/chat/completions"
    );
  });

  it("headers carry UA + x-opencode-session and force stream upstream", async () => {
    const ex = getExecutor("opencode-local");
    const body = { model: "space-bunny-free", messages: [{ role: "user", content: "ping" }] };
    const credentials = { connectionId: "test-conn", rawHeaders: {} };
    const prepared = ex.prepareRequestCredentials({ body, credentials });
    expect(prepared._opencodeSession).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

    const headers = ex.buildHeaders(
      prepared,
      true,
      "https://opencode.ai/inference/openai/v1/chat/completions",
      "space-bunny-free"
    );
    expect(headers["User-Agent"]).toMatch(/^opencode\//);
    expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(headers["x-opencode-client"]).toBe("cli");
  });

  it("reuses the stable session per identity (blocklist, not freshness)", async () => {
    const ex = getExecutor("opencode-local");
    const body = { model: "space-bunny-free", messages: [{ role: "user", content: "ping" }] };
    const p1 = ex.prepareRequestCredentials({ body, credentials: { connectionId: "stable" } });
    const p2 = ex.prepareRequestCredentials({ body, credentials: { connectionId: "stable" } });
    // Same identity reuses the cached session (mirrors the real CLI quota
    // accounting). Rotation happens in execute() only after a 403 burn.
    expect(p1._opencodeSession).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(p2._opencodeSession).toBe(p1._opencodeSession);
  });

  it("honors a user-supplied x-opencode-session header", () => {
    const ex = getExecutor("opencode-local");
    const mine = "ses_eca12f584ffeDHZWQFX2jTz4OC";
    const prepared = ex.prepareRequestCredentials({
      body: { model: "space-bunny-free", messages: [] },
      credentials: { connectionId: "c", rawHeaders: { "x-opencode-session": mine } },
    });
    expect(prepared._opencodeSession).toBe(mine);
  });

  it("rotates the session and retries once on 403 FreeTierError", async () => {
    const ex = getExecutor("opencode-local");
    const burnt = () => new Response(
      '{"type":"error","error":{"type":"FreeTierError","message":"free tier"}}',
      { status: 403, headers: { "content-type": "application/json" } }
    );
    const ok = () => new Response(
      'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
    fetchMock.mockResolvedValueOnce(burnt()).mockResolvedValueOnce(ok());
    const body = { model: "space-bunny-free", messages: [{ role: "user", content: "ping" }] };
    await ex.execute({ model: "space-bunny-free", body, stream: true, credentials: { connectionId: "burn", rawHeaders: {} } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const s1 = fetchMock.mock.calls[0][1].headers["x-opencode-session"];
    const s2 = fetchMock.mock.calls[1][1].headers["x-opencode-session"];
    expect(s1).toMatch(/^ses_/);
    expect(s2).toMatch(/^ses_/);
    expect(s2).not.toBe(s1);
  });
});
