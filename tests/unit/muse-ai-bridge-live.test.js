// Live check for the muse-ai provider end to end through the executor.
//
// Requires the local bridge to be running (muse-bridge/server.py) with a
// working muse.ai account. It makes a real network call to the personal
// agent, so it is skipped unless MUSE_BRIDGE_LIVE=1 — the normal suite must
// not depend on someone's logged-in account.
//
//   MUSE_BRIDGE_LIVE=1 npx vitest run unit/muse-ai-bridge-live.test.js
import { describe, it, expect } from "vitest";
import { getExecutor } from "open-sse/executors/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { PROVIDERS, PROVIDER_MODELS } from "open-sse/providers/index.js";

const LIVE = process.env.MUSE_BRIDGE_LIVE === "1";
const creds = { apiKey: process.env.MUSE_BRIDGE_KEY || "sk-muse-local" };

describe("muse-ai provider registration", () => {
  it("is registered alongside the Meta `muse` provider without collision", () => {
    expect(PROVIDERS["muse-ai"]).toBeTruthy();
    expect(PROVIDERS.muse).toBeTruthy();
    expect(PROVIDERS["muse-ai"].baseUrl).not.toBe(PROVIDERS.muse.baseUrl);
  });

  it("points at the local bridge", () => {
    expect(PROVIDERS["muse-ai"].baseUrl).toContain("127.0.0.1");
  });

  it("lists every alias the bridge serves", () => {
    const ids = (PROVIDER_MODELS["muse-ai"] || []).map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(["muse-chat", "gpt-4o", "gpt-5", "claude-sonnet-4", "muse-video"]),
    );
  });

  it("advertises no tool calling — the agent has none", () => {
    // This is the whole reason the provider is chat-only: without it the
    // dashboard and /v1/models would promise an ability the agent lacks.
    for (const model of ["muse-chat", "gpt-4o", "gpt-5", "claude-sonnet-4", "muse-video"]) {
      expect(getCapabilitiesForModel("muse-ai", model).tools).toBe(false);
    }
  });

  it("resolves the generic executor with the bridge URL and auth header", () => {
    const ex = getExecutor("muse-ai");
    const url = ex.buildUrl("muse-chat", true, 0, creds);
    expect(url).toBe("http://127.0.0.1:18611/v1/chat/completions");
    const headers = ex.buildHeaders(creds, true, url, "muse-chat", {});
    expect(headers.Authorization).toContain("sk-muse-local");
  });
});

describe.skipIf(!LIVE)("muse-ai live turn", () => {
  it("streams a reply from the personal agent", async () => {
    const ex = getExecutor("muse-ai");
    const res = await ex.execute({
      model: "muse-chat",
      stream: true,
      credentials: creds,
      signal: null,
      log: null,
      body: {
        model: "muse-chat",
        stream: true,
        messages: [{ role: "user", content: "Balas dengan tepat satu kata: siap" }],
      },
    });
    // execute() returns { response, url, headers, transformedBody } — the raw
    // fetch Response is one level down, and a non-2xx still comes back here
    // rather than throwing, so the status has to be asserted.
    expect(res.response.status).toBe(200);

    const reader = res.response.body.getReader();
    const dec = new TextDecoder();
    let raw = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
    }
    const text = raw
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => {
        try {
          return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || "";
        } catch {
          return "";
        }
      })
      .join("");
    expect(text.trim().length).toBeGreaterThan(0);
  }, 240000);
});
