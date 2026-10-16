import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import freebuff from "../../src/lib/oauth/providers/freebuff.js";

// Mock proxyAwareFetch so session/run/chat flows never hit the network.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { FreebuffExecutor, __test__ } from "../../open-sse/executors/freebuff.js";

const {
  ensureSession,
  requestSession,
  startRun,
  resetSessionCache,
  rootAgentIdForModel,
  injectFreebuffMarker,
  fetchSessionOffers,
  guardOfferClaim,
  FREEBUFF_SYSTEM_MARKER,
  FREE_ROOT_AGENT_BY_MODEL,
  KNOWN_ROOT_AGENTS,
} = __test__;

const CONFIG = {
  baseUrl: "https://freebuff.com",
  loginCodePath: "/api/auth/cli/code",
  loginStatusPath: "/api/auth/cli/status",
};

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockReset();
  resetSessionCache();
});

describe("freebuff oauth flow", () => {
  it("requestDeviceCode posts a fingerprint to the freebuff.com login host and surfaces the login URL", async () => {
    const loginUrl = "https://freebuff.com/login?auth_code=AbCd-123";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          fingerprintId: "fp-1",
          fingerprintHash: "hash-1",
          loginUrl,
          expiresAt: Date.now() + 60000,
        }),
      }),
    );
    const out = await freebuff.requestDeviceCode(CONFIG);
    expect(out.verification_uri_complete).toBe(loginUrl);
    expect(out.user_code).toBe("AbCd-123");
    expect(out.interval).toBe(5);
    expect(out.expires_in).toBe(60);
    // The server echoes the request host into loginUrl — it must be freebuff.com,
    // not www.codebuff.com, to match the official CLI's login link.
    const [url] = global.fetch.mock.calls[0];
    expect(url.startsWith("https://freebuff.com/api/auth/cli/code")).toBe(true);
    const payload = JSON.parse(out.device_code);
    expect(payload.fingerprintId).toBe("fp-1");
    expect(payload.fingerprintHash).toBe("hash-1");
  });

  it("requestDeviceCode falls back to oauthTimeoutMs when the server omits expiresAt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          fingerprintId: "fp-1",
          fingerprintHash: "hash-1",
          loginUrl: "https://freebuff.com/login?auth_code=Ab",
          // no expiresAt — must NOT collapse to the 60s floor
        }),
      }),
    );
    const out = await freebuff.requestDeviceCode(CONFIG);
    expect(out.expires_in).toBe(300);
  });

  it("requestDeviceCode leaves user_code empty when loginUrl has no auth_code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          fingerprintId: "fp-1",
          fingerprintHash: "hash-1",
          loginUrl: "https://freebuff.com/login",
          expiresAt: Date.now() + 60000,
        }),
      }),
    );
    const out = await freebuff.requestDeviceCode(CONFIG);
    expect(out.user_code).toBe("");
  });

  it("requestDeviceCode clamps expires_in to oauthTimeoutMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          fingerprintId: "fp-1",
          fingerprintHash: "hash-1",
          loginUrl: "https://freebuff.com/login?auth_code=Ab",
          // server-side codes live ~1h; the modal deadline must stay at 5 min
          expiresAt: Date.now() + 3600000,
        }),
      }),
    );
    const out = await freebuff.requestDeviceCode(CONFIG);
    expect(out.expires_in).toBe(300);
  });

  it("pollToken keeps polling on 401 pending (GET with query params)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: "Authentication failed" }),
      }),
    );
    const res = await freebuff.pollToken(
      CONFIG,
      JSON.stringify({ fingerprintId: "fp-1", fingerprintHash: "h", expiresAt: 123 }),
    );
    expect(res.ok).toBe(true);
    expect(res.data.error).toBe("authorization_pending");
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain("https://freebuff.com/api/auth/cli/status?");
    expect(url).toContain("fingerprintId=fp-1");
    expect(opts.method).toBe("GET");
  });

  it("pollToken returns the authToken on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          user: { id: "u1", email: "a@b.c", name: "A", authToken: "tok-123", fingerprintId: "fp-1" },
        }),
      }),
    );
    const res = await freebuff.pollToken(
      CONFIG,
      JSON.stringify({ fingerprintId: "fp-1", fingerprintHash: "h", expiresAt: 123 }),
    );
    expect(res.data.access_token).toBe("tok-123");
  });

  it("mapTokens stores accessToken + identity", () => {
    const t = freebuff.mapTokens({
      access_token: "tok",
      email: "a@b.c",
      name: "A",
      id: "u1",
      fingerprintId: "fp",
    });
    expect(t.accessToken).toBe("tok");
    expect(t.email).toBe("a@b.c");
    expect(t.displayName).toBe("A");
    expect(t.refreshToken).toBeNull();
    expect(t.providerSpecificData.fingerprintId).toBe("fp");
    expect(t.providerSpecificData.authMethod).toBe("device_code");
  });
});

describe("freebuff executor wire shape", () => {
  it("injects codebuff_metadata at TOP LEVEL (mirrors the CLI, not nested under codebuff)", () => {
    const ex = new FreebuffExecutor();
    const body = { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest(body.model, body, true, {
      providerSpecificData: { fingerprintId: "fp-1" },
    });
    // Top-level keys — the backend rejects the nested shape with
    // "No runId found in request body".
    expect(out.codebuff_metadata.cost_mode).toBe("free");
    expect(out.codebuff_metadata.client_id).toBe("fp-1");
    // run_id is the registered runId and is attached by execute(), not here.
    expect(out.codebuff_metadata.run_id).toBeUndefined();
    expect(out.codebuff).toBeUndefined();
    // Setiap request = satu langkah agen (binary: String(CH), CH di-increment
    // per loop). Nilainya string, bukan number.
    expect(out.codebuff_metadata.llm_step_number).toBe("1");
    // allow_fallbacks dihitung per model di binary (`!lm(model)`); model
    // freebuff tidak ada di himpunan `h1` yang jadi acuan, jadi hasilnya true.
    expect(out.provider.allow_fallbacks).toBe(true);
    // Setiap agent free di binary mendeklarasikan data_collection:"deny" di
    // providerOptions-nya, dan CLI menyebarkannya ke request.
    expect(out.provider.data_collection).toBe("deny");
    // Model non-Fable tidak membatasi daftar provider.
    expect(out.provider.only).toBeUndefined();
    // Free-tier marker is prepended so the first message opens with the CLI root prompt.
    expect(out.messages[0].content).toBe(FREEBUFF_SYSTEM_MARKER);
  });

  it("buildUrl targets the Codebuff chat completions endpoint (www.codebuff.com)", () => {
    const ex = new FreebuffExecutor();
    expect(ex.buildUrl()).toBe("https://www.codebuff.com/api/v1/chat/completions");
  });

  it("pins Fable to the anthropic provider (mirrors base2-free-fable's only:['anthropic'])", () => {
    const ex = new FreebuffExecutor();
    const model = "anthropic/claude-fable-5.1";
    const out = ex.transformRequest(model, { model, messages: [{ role: "user", content: "hi" }] }, true, {
      providerSpecificData: { fingerprintId: "fp-1" },
    });
    // Agent fable di binary memakai providerOptions yang lebih sempit daripada
    // agent free lain: hanya boleh lewat provider "anthropic".
    expect(out.provider.only).toEqual(["anthropic"]);
    expect(out.provider.data_collection).toBe("deny");
  });

  it("injects the end_turn tool into any tool-calling request (backend foreign_toolset gate)", () => {
    const ex = new FreebuffExecutor();
    const body = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file", description: "read" } }],
    };
    const out = ex.transformRequest(body.model, body, true, { providerSpecificData: { fingerprintId: "fp-1" } });
    const names = out.tools.map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("end_turn");
    expect(out.tools[out.tools.length - 1].function).toMatchObject({
      name: "end_turn",
      description: "Signal the end of the current task.",
    });
  });

  it("does not inject end_turn when the request has no tools", () => {
    const ex = new FreebuffExecutor();
    const body = { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest(body.model, body, true, { providerSpecificData: { fingerprintId: "fp-1" } });
    expect(out.tools).toBeUndefined();
  });

  it("does not duplicate end_turn when the caller already declared it", () => {
    const ex = new FreebuffExecutor();
    const endTurn = { type: "function", function: { name: "end_turn", description: "Signal the end of the current task.", parameters: { type: "object", properties: {} } } };
    const body = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [endTurn],
    };
    const out = ex.transformRequest(body.model, body, true, { providerSpecificData: { fingerprintId: "fp-1" } });
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0].function.name).toBe("end_turn");
  });
});

describe("freebuff session pre-flight", () => {
  it("claims a session via POST /session/admission with x-freebuff-model and caches it per token+model", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: "active",
        instanceId: "inst-1",
        model: "deepseek/deepseek-v4-flash",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    const first = await ensureSession("tok-1", "deepseek/deepseek-v4-flash", null);
    expect(first).toEqual({ instanceId: "inst-1", status: "active" });

    const [url, opts] = fetchMock.mock.calls[0];
    // Endpoint KLAIM yang dipakai CLI resmi — bukan /freebuff/session.
    expect(url).toBe("https://www.codebuff.com/api/v1/freebuff/session/admission");
    expect(opts.method).toBe("POST");
    expect(opts.headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");
    expect(opts.headers.Authorization).toBe("Bearer tok-1");
    // Header "jujur" yang CLI pasang di setiap panggilan sesi.
    expect(opts.headers["x-freebuff-wallet-spend-limit"]).toBe("0");
    expect(opts.headers["x-freebuff-first-tab-discount"]).toBe("0");
    expect(opts.headers["x-fb-timezone"]).toBeTruthy();

    // Second call for the same token+model hits the cache — no new claim.
    await ensureSession("tok-1", "deepseek/deepseek-v4-flash", null);
    expect(fetchMock.mock.calls.length).toBe(1);

    // Different model → separate claim.
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "active", instanceId: "inst-2", expiresAt: new Date(Date.now() + 3600000).toISOString() }),
    );
    await ensureSession("tok-1", "z-ai/glm-5.3-flash", null);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("treats status none as no-session-needed (instanceId null)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "none", accessTier: "full" }));
    const res = await ensureSession("tok-1", "deepseek/deepseek-v4-flash", null);
    expect(res).toEqual({ instanceId: null, status: "none" });
  });

  it("marks 404/405 from the admission route as session_admission_unsupported", async () => {
    // Binary menandai rute admission yang hilang dengan kode ini dan menyuruh
    // update — bukan diam-diam jatuh ke POST /freebuff/session, yang bukan
    // jalur resmi CLI.
    fetchMock.mockResolvedValue(jsonResponse({ error: "not found" }, { status: 404, ok: false }));
    await expect(ensureSession("tok-1", "deepseek/deepseek-v4-flash", null)).rejects.toMatchObject({
      code: "session_admission_unsupported",
      status: 404,
    });
  });

  it("throws a friendly error on rate_limited", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "rate_limited", message: "4 of 6 sessions used today" }),
    );
    await expect(ensureSession("tok-1", "deepseek/deepseek-v4-flash", null)).rejects.toThrow(
      /session limit reached/i,
    );
  });

  it("rate_limited with a resetAt locks the account until the daily Pacific reset (skip the day, not retry loops)", async () => {
    const resetAt = "2099-01-01T00:00:00.000Z";
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: "rate_limited",
        resetAt,
        retryAfterMs: 1234,
        freebucksShortfall: { price: 15, balance: 0 },
        message: "Freebucks exhausted",
      }),
    );
    await expect(requestSession("tok-1", "deepseek/deepseek-v4-flash", null)).rejects.toMatchObject({
      status: 429,
      resetsAtMs: Date.parse(resetAt),
    });
  });

  it("spend_limited falls back to retryAfterMs when resetAt is absent", async () => {
    const retryAfterMs = 90 * 60 * 1000;
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "spend_limited", retryAfterMs, message: "daily spend cap" }),
    );
    const before = Date.now();
    try {
      await requestSession("tok-1", "deepseek/deepseek-v4-flash", null);
      throw new Error("should have rejected");
    } catch (error) {
      expect(error.status).toBe(429);
      expect(error.resetsAtMs).toBeGreaterThanOrEqual(before + retryAfterMs - 1000);
      expect(error.resetsAtMs).toBeLessThanOrEqual(before + retryAfterMs + 1000);
    }
  });

  it("handles spend_limited arriving as HTTP 429 (the actual wire shape) — still skips until reset", async () => {
    const resetAt = "2099-01-01T00:00:00.000Z";
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          status: "spend_limited",
          accessTier: "full",
          upgrade: { url: "https://freebuff.com/plans", message: "Get 150 Freebucks a day from $8/mo." },
          message: "This account hit today's hard usage cap.",
          resetAt,
        },
        { status: 429, ok: false },
      ),
    );
    await expect(requestSession("tok-1", "deepseek/deepseek-v4-flash", null)).rejects.toMatchObject({
      status: 429,
      resetsAtMs: Date.parse(resetAt),
    });
  });

  it("handles rate_limited arriving as HTTP 429 with only retryAfterMs", async () => {
    const retryAfterMs = 15 * 60 * 1000;
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "rate_limited", retryAfterMs, message: "limit" }, { status: 429, ok: false }),
    );
    const before = Date.now();
    try {
      await requestSession("tok-1", "deepseek/deepseek-v4-flash", null);
      throw new Error("should have rejected");
    } catch (error) {
      expect(error.status).toBe(429);
      expect(error.resetsAtMs).toBeGreaterThanOrEqual(before + retryAfterMs - 1000);
      expect(error.resetsAtMs).toBeLessThanOrEqual(before + retryAfterMs + 1000);
    }
  });

  it("keeps an unknown HTTP 429 as a generic failure (no gate status → no resetsAtMs)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "nope" }, { status: 429, ok: false }));
    try {
      await requestSession("tok-1", "deepseek/deepseek-v4-flash", null);
      throw new Error("should have rejected");
    } catch (error) {
      expect(error.status).toBe(429);
      expect(error.resetsAtMs).toBeUndefined();
    }
  });

  it("rate_limited without any reset hint stays a plain error (transient cooldown path)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "rate_limited", message: "busy" }));
    try {
      await requestSession("tok-1", "deepseek/deepseek-v4-flash", null);
      throw new Error("should have rejected");
    } catch (error) {
      expect(error.status).toBeUndefined();
      expect(error.resetsAtMs).toBeUndefined();
    }
  });

  it("throws a friendly error on country_blocked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "country_blocked" }));
    await expect(ensureSession("tok-1", "deepseek/deepseek-v4-flash", null)).rejects.toThrow(
      /not available in your region/i,
    );
  });

  it("throws a 401 re-login error when the session endpoint rejects the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, { status: 401, ok: false }));
    await expect(requestSession("tok-expired", "deepseek/deepseek-v4-flash", null)).rejects.toThrow(/re-login/i);
  });
});

describe("freebuff limited-offer (Claude Fable 5) claims", () => {
  const FABLE = "anthropic/claude-fable-5.1";
  const offerRow = (over = {}) => ({
    model: FABLE,
    remaining: 3,
    total: 10,
    userRemaining: 1,
    userResetAt: new Date(Date.now() + 3600000).toISOString(),
    ...over,
  });

  it("GETs limitedModelOffers (never claims) and caches them per token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "none", limitedModelOffers: [offerRow()] }));
    const offers = await fetchSessionOffers("tok-1", null);
    expect(offers.map((o) => o.model)).toEqual([FABLE]);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.codebuff.com/api/v1/freebuff/session");
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer tok-1");
    expect(opts.headers.Accept).toBe("application/json");
    // Header sesi "jujur" dipasang di SEMUA panggilan /freebuff/session,
    // termasuk GET status ini.
    expect(opts.headers["x-freebuff-wallet-spend-limit"]).toBe("0");
    expect(opts.headers["x-freebuff-first-tab-discount"]).toBe("0");
    // GET ini belum memegang seat, jadi header heartbeat TIDAK dipasang —
    // binary hanya memasangnya saat instanceId sudah ada.
    expect(opts.headers["x-freebuff-heartbeat"]).toBeUndefined();
    expect(opts.headers["x-freebuff-instance-id"]).toBeUndefined();

    // Second read within the cache TTL does not refetch.
    await fetchSessionOffers("tok-1", null);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("allows the claim while the offer is open", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "none", limitedModelOffers: [offerRow()] }));
    expect(await guardOfferClaim("tok-1", FABLE, null)).toMatchObject({ model: FABLE, remaining: 3 });
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("lets non-offer models claim without any offer GET", async () => {
    expect(await guardOfferClaim("tok-1", "deepseek/deepseek-v4-flash", null)).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("refuses the claim when the wave pool is closed (no offer row)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "none", limitedModelOffers: [] }));
    await expect(guardOfferClaim("tok-1", FABLE, null)).rejects.toThrow(/not being offered right now/i);
  });

  it("refuses the claim when the account's daily Fable sessions are used up", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "none", limitedModelOffers: [offerRow({ userRemaining: 0 })] }),
    );
    await expect(guardOfferClaim("tok-1", FABLE, null)).rejects.toThrow(/has used its Claude Fable 5 sessions/i);
  });

  it("claims a Fable session only after the offer passes: GET offers, then POST claim", async () => {
    fetchMock.mockImplementation(async (url, opts = {}) => {
      if (url.includes("/freebuff/session") && opts.method === "GET") {
        return jsonResponse({ status: "none", limitedModelOffers: [offerRow()] });
      }
      if (url.includes("/freebuff/session")) {
        return jsonResponse({ status: "active", instanceId: "inst-fable", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      }
      return jsonResponse({ ok: false }, { status: 500, ok: false });
    });

    const res = await ensureSession("tok-1", FABLE, null);
    expect(res).toEqual({ instanceId: "inst-fable", status: "active" });

    const methods = fetchMock.mock.calls.map(([, o]) => o.method);
    expect(methods).toEqual(["GET", "POST"]);
    const [, postOpts] = fetchMock.mock.calls[1];
    expect(postOpts.headers["x-freebuff-model"]).toBe(FABLE);

    // Cached claim → no further requests.
    await ensureSession("tok-1", FABLE, null);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("never POSTs a claim when the Fable wave is closed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "none", limitedModelOffers: [] }));
    await expect(ensureSession("tok-1", FABLE, null)).rejects.toThrow(/not being offered right now/i);
    const methods = fetchMock.mock.calls.map(([, o]) => o.method);
    expect(methods).toEqual(["GET"]);
  });
});

describe("freebuff free-tier system marker", () => {
  it("prepends the canonical marker when the first message is a system prompt", () => {
    const out = injectFreebuffMarker({
      messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "hi" }],
    });
    expect(out.messages[0].content).toBe(`${FREEBUFF_SYSTEM_MARKER}\n\nYou are a helpful assistant.`);
    expect(out.messages[1].role).toBe("user");
  });

  it("inserts a marker system message when the first message is not a system prompt", () => {
    const out = injectFreebuffMarker({ messages: [{ role: "user", content: "hi" }] });
    expect(out.messages[0]).toEqual({ role: "system", content: FREEBUFF_SYSTEM_MARKER });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("is idempotent when the first system message already opens with the marker", () => {
    const messages = [{ role: "system", content: FREEBUFF_SYSTEM_MARKER }];
    const out = injectFreebuffMarker({ messages });
    expect(out.messages).toBe(messages);
  });

  it("inserts a marker system message when the first system content is a block array", () => {
    const out = injectFreebuffMarker({
      messages: [{ role: "system", content: [{ type: "text", text: "hi" }] }, { role: "user", content: "x" }],
    });
    expect(out.messages[0]).toEqual({ role: "system", content: FREEBUFF_SYSTEM_MARKER });
    expect(out.messages[1].content).toEqual([{ type: "text", text: "hi" }]);
    expect(out.messages[2].content).toBe("x");
  });
});

describe("freebuff run registration", () => {
  it("maps freebuff models to their root free agent ids", () => {
    expect(rootAgentIdForModel("deepseek/deepseek-v4-flash")).toBe("base3-free-deepseek-flash");
    expect(rootAgentIdForModel("z-ai/glm-5.3-flash")).toBe("base3-free-glm-5-3-flash");
    expect(rootAgentIdForModel("z-ai/glm-5.2")).toBe("base3-free-glm");
    expect(rootAgentIdForModel("mimo/mimo-v2.5")).toBe("base3-free-mimo");
    expect(rootAgentIdForModel("openai/gpt-5.6-luna")).toBe("base3-free-luna");
    expect(rootAgentIdForModel("upstage/solar-pro4")).toBe("base3-free-solar-pro4");
    expect(rootAgentIdForModel("meta/muse-spark-1.2-contributor")).toBe("base3-free-muse-spark");
    // Fable HANYA ada di peta base2 binary resmi (`base2-free-fable`); ia tidak
    // pernah masuk peta base3. Memetakannya ke base3 = 404 "No endpoints found".
    expect(rootAgentIdForModel("anthropic/claude-fable-5.1")).toBe("base2-free-fable");

    // Withdrawn upstream models are unmapped — they fall back.
    //
    // Fallback-nya WAJIB "base2-free", persis seperti binary resmi:
    //   rw$(m) { return Kt === "base3" ? n6A(m) : FKH(m) }
    //   n6A(m) { return PKH[m] ?? FKH(m) }
    //   FKH(m) { return nw$[m] ?? "base2-free" }
    // Model yang tidak ada di peta base3 (PKH) jatuh ke peta base2 (nw$), dan
    // fallback terakhir di rantai itu adalah "base2-free".
    //
    // "base3-free" TIDAK PERNAH ada di binary: nol kemunculan `id:"base3-free"`
    // dan tidak ada di daftar agent bebas `iw$`.
    expect(rootAgentIdForModel("meta/muse-spark-1.3-contributor")).toBe("base2-free");
    expect(rootAgentIdForModel("deepseek/deepseek-v4-pro")).toBe("base2-free");
    expect(rootAgentIdForModel("minimax/minimax-m3")).toBe("base2-free");
    expect(rootAgentIdForModel("some/unknown-model")).toBe("base2-free");

    // Model tak dikenal memang BOLEH menyentuh peta base2 — itu jalur resmi
    // (nw$ memuat banyak model yang tidak ada di PKH). Yang dilarang adalah
    // mengarang agent id yang tidak terdefinisi di binary, terutama
    // "base3-free" telanjang.
    for (const m of [
      "meta/muse-spark-1.3-contributor",
      "deepseek/deepseek-v4-pro",
      "minimax/minimax-m3",
      "model/yang-tidak-dikenal",
      "",
      null,
    ]) {
      const id = rootAgentIdForModel(m);
      expect(id, `model ${m} menghasilkan agent yang tidak terdefinisi di binary`).not.toBe("base3-free");
      expect(KNOWN_ROOT_AGENTS.has(id), `agent "${id}" tidak terdaftar di binary resmi`).toBe(true);
    }

    // Setiap agent yang dipetakan harus benar-benar ada di binary resmi —
    // menebak id hanya memindahkan 404 ke 404.
    for (const m of Object.keys(FREE_ROOT_AGENT_BY_MODEL)) {
      const id = rootAgentIdForModel(m);
      expect(KNOWN_ROOT_AGENTS.has(id), `agent "${id}" (model ${m}) tidak terdaftar di binary resmi`).toBe(true);
    }
  });

  it("registers a run via POST /agent-runs and returns the runId", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ runId: "run-abc" }));
    const runId = await startRun("tok-1", "deepseek/deepseek-v4-flash", null);
    expect(runId).toBe("run-abc");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.codebuff.com/api/v1/agent-runs");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok-1");
    // DUAL-AUTH: CLI mengirim token yang sama lewat Authorization DAN
    // x-codebuff-api-key di setiap panggilan /agent-runs.
    expect(opts.headers["x-codebuff-api-key"]).toBe("tok-1");
    const payload = JSON.parse(opts.body);
    expect(payload.action).toBe("START");
    expect(payload.agentId).toBe("base3-free-deepseek-flash");
    expect(payload.ancestorRunIds).toEqual([]);
  });

  it("throws when the run start fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "bad" }, { status: 500, ok: false }));
    await expect(startRun("tok-1", "deepseek/deepseek-v4-flash", null)).rejects.toThrow(/run start failed/i);
  });

  it("retries transient network errors on run registration", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("/agent-runs")) {
        const calls = fetchMock.mock.calls.filter(([u]) => u.includes("/agent-runs")).length;
        if (calls === 1) throw new Error("fetch failed (cause: ECONNRESET)");
        return jsonResponse({ runId: "run-retried" });
      }
      throw new Error("unexpected url");
    });
    const runId = await startRun("tok-1", "deepseek/deepseek-v4-flash", null);
    expect(runId).toBe("run-retried");
  });
});

describe("freebuff executor execute", () => {
  const CHAT_URL = "https://www.codebuff.com/api/v1/chat/completions";
  // POST klaim memakai endpoint admission; GET status/offers tetap /session.
  const SESSION_URL = "https://www.codebuff.com/api/v1/freebuff/session";
  const ADMISSION_URL = "https://www.codebuff.com/api/v1/freebuff/session/admission";
  const RUN_URL = "https://www.codebuff.com/api/v1/agent-runs";
  const MODEL = "deepseek/deepseek-v4-flash";
  // Bentuk kredensial yang NYATA: mapTokens menyimpan id akun saat login
  // (providerSpecificData.userId), jadi jalur normal tidak perlu memanggil
  // /api/v1/me sama sekali.
  const credentials = {
    accessToken: "tok-1",
    providerSpecificData: { fingerprintId: "fp-1", userId: "user-1" },
  };

  // Default happy-path backend: session active, run registered, chat 200.
  const happyPath = () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) {
        return jsonResponse({ status: "active", instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      }
      if (url === RUN_URL) {
        return jsonResponse({ runId: "run-1" });
      }
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });
  };

  it("sends the registered runId + session instance id on the chat request", async () => {
    happyPath();

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    const { response } = await ex.execute({ model: MODEL, body, stream: false, credentials, log: null });

    expect(response.status).toBe(200);
    const chatCall = fetchMock.mock.calls.find(([u]) => u === CHAT_URL);
    expect(chatCall).toBeTruthy();
    const sent = JSON.parse(chatCall[1].body);
    expect(sent.codebuff_metadata.run_id).toBe("run-1");
    expect(sent.codebuff_metadata.freebuff_instance_id).toBe("inst-1");
    expect(sent.codebuff_metadata.trace_session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(sent.codebuff_metadata.cost_mode).toBe("free");
    expect(sent.codebuff_metadata.client_id).toBe("fp-1");
    expect(sent.codebuff).toBeUndefined();
    // Free-tier marker present at position 0 of the request body.
    expect(sent.messages[0].content.startsWith("You are Buffy,")).toBe(true);

    // Header identitas akun di panggilan CHAT (bukan body). Kredensial di sini
    // sudah menyimpan userId dari login, jadi tidak perlu /api/v1/me.
    expect(chatCall[1].headers["x-freebuff-acting-user-id"]).toBe("user-1");
    expect(chatCall[1].headers["User-Agent"]).toBe("ai-sdk/openai-compatible/1.0.0/codebuff");
    // Jalur normal tidak boleh memanggil /api/v1/me sama sekali.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/v1/me"))).toBe(false);

    // run FINISH juga dual-auth.
    const finishCall = fetchMock.mock.calls.find(
      ([u, o]) => u === RUN_URL && JSON.parse(o.body).action === "FINISH",
    );
    expect(finishCall[1].headers["x-codebuff-api-key"]).toBe("tok-1");
  });

  it("falls back to GET /api/v1/me once when the credential has no userId", async () => {
    let meHits = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) {
        return jsonResponse({ status: "active", instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      }
      if (String(url).includes("/api/v1/me")) {
        meHits += 1;
        return jsonResponse({ id: "user-from-me", email: "a@b.c" });
      }
      if (url === RUN_URL) return jsonResponse({ runId: "run-1" });
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });

    // Kredensial akun lama: fingerprintId ada, userId BELUM tersimpan.
    const legacyCreds = { accessToken: "tok-1", providerSpecificData: { fingerprintId: "fp-1" } };
    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    await ex.execute({ model: MODEL, body, stream: false, credentials: legacyCreds, log: null });

    expect(meHits).toBe(1);
    const chatCall = fetchMock.mock.calls.find(([u]) => u === CHAT_URL);
    expect(chatCall[1].headers["x-freebuff-acting-user-id"]).toBe("user-from-me");

    // Percobaan kedua: hasil sudah di-cache, /api/v1/me tidak dipanggil lagi.
    await ex.execute({ model: MODEL, body, stream: false, credentials: legacyCreds, log: null });
    expect(meHits).toBe(1);
  });

  it("does not call /api/v1/me again after it answers without an id", async () => {
    let meHits = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) {
        return jsonResponse({ status: "active", instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      }
      if (String(url).includes("/api/v1/me")) {
        meHits += 1;
        return jsonResponse({ error: "nope" }, { status: 403, ok: false });
      }
      if (url === RUN_URL) return jsonResponse({ runId: "run-1" });
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });

    const legacyCreds = { accessToken: "tok-1", providerSpecificData: { fingerprintId: "fp-1" } };
    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    await ex.execute({ model: MODEL, body, stream: false, credentials: legacyCreds, log: null });

    // Jawaban tegas (403) di-cache sebagai "tidak ada id" — header dilewati,
    // dan request berikutnya tidak memanggil endpoint itu lagi.
    const chatCall = fetchMock.mock.calls.find(([u]) => u === CHAT_URL);
    expect(chatCall[1].headers["x-freebuff-acting-user-id"]).toBeUndefined();
    expect(meHits).toBe(1);

    await ex.execute({ model: MODEL, body, stream: false, credentials: legacyCreds, log: null });
    expect(meHits).toBe(1);
  });

  it("retries exactly once on 428 with a fresh session AND a fresh run", async () => {
    let chatHits = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) {
        return jsonResponse({ status: "active", instanceId: "inst-2", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      }
      if (url === RUN_URL) {
        return jsonResponse({ runId: "run-2" });
      }
      chatHits += 1;
      if (chatHits === 1) return jsonResponse({ error: "waiting_room_required" }, { status: 428, ok: false });
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    const { response } = await ex.execute({ model: MODEL, body, stream: false, credentials, log: null });

    expect(response.status).toBe(200);
    expect(chatHits).toBe(2);
    // Session was claimed twice (initial + forced re-claim).
    expect(fetchMock.mock.calls.filter(([u]) => u === ADMISSION_URL).length).toBe(2);
    // Runs: START #1, FINISH(cancelled) #1 (abandoned on 428), START #2,
    // FINISH(completed) #2.
    const runCalls = fetchMock.mock.calls.filter(([u]) => u === RUN_URL);
    expect(runCalls.length).toBe(4);
    const runActions = runCalls.map((c) => JSON.parse(c[1].body).action);
    expect(runActions.filter((a) => a === "START").length).toBe(2);
    expect(runActions.filter((a) => a === "FINISH").length).toBe(2);
    const finishPayload = JSON.parse(runCalls[runCalls.length - 1][1].body);
    expect(finishPayload.status).toBe("completed");
    // The retried chat request carried the re-claimed session + fresh run.
    const lastChat = fetchMock.mock.calls.filter(([u]) => u === CHAT_URL).pop();
    const sent = JSON.parse(lastChat[1].body);
    expect(sent.codebuff_metadata.run_id).toBe("run-2");
    expect(sent.codebuff_metadata.freebuff_instance_id).toBe("inst-2");
  });

  it("re-claims the session on 409 session_superseded and retries once", async () => {
    let chatHits = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) return jsonResponse({ status: "active", instanceId: "inst-2", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (url === RUN_URL) return jsonResponse({ runId: "run-2" });
      chatHits += 1;
      if (chatHits === 1) {
        return jsonResponse({ error: "session_superseded", message: "Another instance took over" }, { status: 409, ok: false });
      }
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    const { response } = await ex.execute({ model: MODEL, body, stream: false, credentials, log: null });

    expect(response.status).toBe(200);
    expect(chatHits).toBe(2);
    // Session re-claimed (initial + forced) and runs restarted.
    expect(fetchMock.mock.calls.filter(([u]) => u === ADMISSION_URL).length).toBe(2);
    const runCalls = fetchMock.mock.calls.filter(([u]) => u === RUN_URL);
    expect(runCalls.filter((c) => JSON.parse(c[1].body).action === "START").length).toBe(2);
  });

  it("re-claims the session on 410 session_expired and retries once", async () => {
    let chatHits = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) return jsonResponse({ status: "active", instanceId: "inst-2", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (url === RUN_URL) return jsonResponse({ runId: "run-2" });
      chatHits += 1;
      if (chatHits === 1) return jsonResponse({ error: "session_expired" }, { status: 410, ok: false });
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    const { response } = await ex.execute({ model: MODEL, body, stream: false, credentials, log: null });
    expect(response.status).toBe(200);
    expect(chatHits).toBe(2);
  });

  it("throws a 401 re-login error when the chat endpoint rejects the token", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) return jsonResponse({ status: "active", instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (url === RUN_URL) return jsonResponse({ runId: "run-1" });
      return jsonResponse({ error: "unauthorized" }, { status: 401, ok: false });
    });

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    await expect(
      ex.execute({ model: MODEL, body, stream: false, credentials, log: null }),
    ).rejects.toThrow(/re-login/i);
  });

  it("throws when no access token is present", async () => {
    const ex = new FreebuffExecutor();
    await expect(
      ex.execute({ model: MODEL, body: { messages: [] }, stream: false, credentials: {}, log: null }),
    ).rejects.toThrow(/no access token/i);
  });

  it("finishes the run as failed when the chat upstream errors", async () => {
    // 400 (not in the 429/502/503 retry set) so the test stays fast and mirrors
    // the real upstream rejection.
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) return jsonResponse({ status: "active", instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (url === RUN_URL) return jsonResponse({ runId: "run-1" });
      return jsonResponse({ error: "upstream boom" }, { status: 400, ok: false });
    });

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    const { response } = await ex.execute({ model: MODEL, body, stream: false, credentials, log: null });

    expect(response.status).toBe(400);
    const runCalls = fetchMock.mock.calls.filter(([u]) => u === RUN_URL);
    expect(runCalls.length).toBe(2); // START + FINISH
    const finishPayload = JSON.parse(runCalls[1][1].body);
    expect(finishPayload.action).toBe("FINISH");
    expect(finishPayload.status).toBe("failed");
  });

  it("finishes the run as failed when execute throws mid-flight", async () => {
    // AbortError (caller/stream abort) is never retried, keeping this test fast.
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) return jsonResponse({ status: "active", instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (url === RUN_URL) return jsonResponse({ runId: "run-1" });
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    await expect(
      ex.execute({ model: MODEL, body, stream: false, credentials, log: null }),
    ).rejects.toThrow(/aborted/);

    const runCalls = fetchMock.mock.calls.filter(([u]) => u === RUN_URL);
    expect(runCalls.length).toBe(2); // START + FINISH(failed) from the finally block
    const finishPayload = JSON.parse(runCalls[1][1].body);
    expect(finishPayload.action).toBe("FINISH");
    expect(finishPayload.status).toBe("failed");
  });

  it("retries the chat POST on a transient fetch-level network error", async () => {
    let chatHits = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) return jsonResponse({ status: "active", instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (url === RUN_URL) return jsonResponse({ runId: "run-1" });
      chatHits += 1;
      if (chatHits === 1) throw new Error("fetch failed (cause: ECONNRESET)");
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    const { response } = await ex.execute({ model: MODEL, body, stream: false, credentials, log: null });

    expect(response.status).toBe(200);
    expect(chatHits).toBe(2);
    // Run FINISHed exactly once (completed) — no double-FINISH from the retry.
    const runCalls = fetchMock.mock.calls.filter(([u]) => u === RUN_URL);
    expect(runCalls.length).toBe(2); // START + FINISH(completed)
    expect(JSON.parse(runCalls[1][1].body).status).toBe("completed");
  });

  it("does not double-FINISH the abandoned run when the re-claim fails", async () => {
    let chatHits = 0;
    let runStartCount = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url === ADMISSION_URL) return jsonResponse({ status: "active", instanceId: "inst-2", expiresAt: new Date(Date.now() + 3600000).toISOString() });
      if (url === RUN_URL) {
        // First START succeeds (run-1). Every later call fails with the
        // transient ECONNRESET: the fire-and-forget FINISH swallows it, and
        // the re-claim START propagates after its 3 network-retry attempts.
        if (runStartCount === 0) {
          runStartCount += 1;
          return jsonResponse({ runId: "run-1" });
        }
        throw new Error("fetch failed (cause: ECONNRESET)");
      }
      chatHits += 1;
      if (chatHits === 1) return jsonResponse({ error: "session_superseded" }, { status: 409, ok: false });
      return jsonResponse({ choices: [{ message: { content: "hi" } }] });
    });

    const ex = new FreebuffExecutor();
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
    // The re-claim failure rethrows the raw upstream error (the log line above
    // it carries the "session re-claim failed" context).
    await expect(
      ex.execute({ model: MODEL, body, stream: false, credentials, log: null }),
    ).rejects.toThrow(/fetch failed \(cause: ECONNRESET\)/);

    // run-1 was FINISH'd exactly once, as "cancelled" — the failed re-claim
    // must NOT trigger a second (rejected by the server) FINISH.
    const runCalls = fetchMock.mock.calls.filter(([u]) => u === RUN_URL);
    const finishes = runCalls.filter(([, o]) => JSON.parse(o.body).action === "FINISH");
    expect(finishes.length).toBe(1);
    expect(JSON.parse(finishes[0][1].body).status).toBe("cancelled");
  });
});

describe("freebuff executor parseError", () => {
  it("explains a 404 'No endpoints found' as the toolset gate, not a credential problem", async () => {
    const ex = new FreebuffExecutor();
    const res = jsonResponse(
      { error: { message: "No endpoints found for deepseek/deepseek-v4-flash.", code: 404, type: null, param: null } },
      { status: 404, ok: false },
    );
    const parsed = await ex.parseError(res, JSON.stringify({ error: { message: "No endpoints found for deepseek/deepseek-v4-flash.", code: 404 } }));

    expect(parsed.status).toBe(404);
    expect(parsed.message).toMatch(/end_turn/i);
    expect(parsed.message).not.toMatch(/credential/i);
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now());
  });

  it("passes other statuses through untouched", async () => {
    const ex = new FreebuffExecutor();
    const res = jsonResponse({ error: "bad" }, { status: 500, ok: false });
    const parsed = await ex.parseError(res, JSON.stringify({ error: "bad" }));
    expect(parsed.status).toBe(500);
    expect(parsed.message).toContain("bad");
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});

describe("freebuff User-Agent per jenis panggilan", () => {
  // Upstream membedakan UA chat dan non-chat. CLI resmi memasang
  // `ai-sdk/openai-compatible/1.0.0/codebuff` HANYA di panggilan chat
  // (model-provider.ts); panggilan lain memakai UA runtime biasa, meniru
  // fetch Bun bawaan. Sebelumnya keempat panggilan non-chat memakai
  // `codebuff-cli/0.0.138` — versi paket yang sudah usang dan bukan UA
  // yang dikirim CLI ke API.

  it("panggilan non-chat memakai UA runtime, bukan UA paket", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ runId: "run-abc" }));
    await startRun("tok-1", "deepseek/deepseek-v4-flash", null);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["User-Agent"]).toBe("Bun/1.3.11");
    expect(opts.headers["User-Agent"]).not.toMatch(/codebuff-cli/);
  });

  it("registry memakai UA chat yang benar (versi 1.0.0, bukan 1.0)", async () => {
    const { default: registry } = await import("../../open-sse/providers/registry/freebuff.js");
    const ua = registry.transport.headers["User-Agent"];
    expect(ua).toBe("ai-sdk/openai-compatible/1.0.0/codebuff");
    // Versi tanpa patch (1.0) pernah dipakai dan tidak cocok dengan CLI.
    expect(ua).not.toBe("ai-sdk/openai-compatible/1.0/codebuff");
  });

  it("tidak ada UA codebuff-cli yang tersisa di kode (non-komentar)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const berkas = [
      resolve(here, "../../open-sse/executors/freebuff.js"),
      resolve(here, "../../open-sse/providers/registry/freebuff.js"),
      resolve(here, "../../open-sse/services/usage/freebuff.js"),
      resolve(here, "../../src/lib/oauth/providers/freebuff.js"),
    ];
    for (const f of berkas) {
      const isi = readFileSync(f, "utf8");
      // Buang komentar supaya penyebutan di dokumentasi tidak dihitung kode.
      const kode = isi.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(kode, `masih ada UA codebuff-cli di ${f}`).not.toMatch(/codebuff-cli/);
    }
  });
});
