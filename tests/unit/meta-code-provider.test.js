import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mintUrl = "https://api.meta.ai/muse-code/key";

vi.mock("../../open-sse/services/usage/shared.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchWithTimeout: vi.fn() };
});

import { fetchWithTimeout } from "../../open-sse/services/usage/shared.js";
import { mintMetaCodeKey } from "../../open-sse/services/metaCode.js";
import { parseMetaSubsUsage, getMetaCodeUsage } from "../../open-sse/services/usage/meta-code.js";
import { refreshMetaCodeToken } from "../../open-sse/services/tokenRefresh/providers.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

const okJson = (data) => ({ ok: true, status: 200, json: async () => data });
const errRes = (status, text = "") => ({
  ok: false,
  status,
  text: async () => text,
  json: async () => ({}),
});

beforeEach(() => {
  fetchWithTimeout.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("meta-code registry entry", () => {
  const entry = REGISTRY.find((p) => p.id === "meta-code");

  it("is registered with alias mc and responses transport", () => {
    expect(entry).toBeTruthy();
    expect(entry.alias).toBe("mc");
    expect(entry.transport.baseUrl).toBe("https://api.meta.ai/v1/responses");
    expect(entry.transport.format).toBe("openai-responses");
    expect(entry.transport.forceStream).toBe(true);
    expect(entry.transport.quirks.foldReasoningEffort).toBe(true);
  });

  it("supports both oauth and apikey auth", () => {
    expect(entry.authModes).toEqual(["oauth", "apikey"]);
    expect(entry.hasOAuth).toBe(true);
    expect(entry.oauth.deviceCodeUrl).toBe("https://auth.meta.com/oidc/device/authorization/");
    expect(entry.oauth.tokenUrl).toBe("https://auth.meta.com/oidc/device/token/");
    expect(entry.oauth.mintUrl).toBe(mintUrl);
  });

  it("lists the five muse-spark models targeting responses", () => {
    expect(entry.models.map((m) => m.id)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.2",
      "muse-spark-1.1",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2-contributor",
    ]);
    expect(entry.models.every((m) => m.targetFormat === "openai-responses")).toBe(true);
  });

  it("alias mc is unique across the registry", () => {
    const owners = REGISTRY.filter(
      (p) => p.alias === "mc" || (p.aliases || []).includes("mc")
    );
    expect(owners.map((p) => p.id)).toEqual(["meta-code"]);
  });
});

describe("mintMetaCodeKey", () => {
  it("returns the mint payload and posts the dca token as Bearer", async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ api_key: "LLM|1|x", is_subs_active: true }));
    const data = await mintMetaCodeKey("dca:tok");
    expect(data.api_key).toBe("LLM|1|x");
    const [url, opts] = fetchWithTimeout.mock.calls[0];
    expect(url).toBe(mintUrl);
    expect(opts.headers.Authorization).toBe("Bearer dca:tok");
    expect(opts.headers["x-api-version"]).toBe("1.0.0");
    expect(opts.body).toBe("{}");
  });

  it("throws with .status on HTTP failure and keeps the body out of .message", async () => {
    fetchWithTimeout.mockResolvedValue(errRes(401, "secret upstream body"));
    const err = await mintMetaCodeKey("dca:bad").catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain("secret upstream body");
    expect(err.detail).toContain("secret upstream body");
  });

  it("throws a helpful error when the account has no key yet", async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ action_url: "https://x" }));
    await expect(mintMetaCodeKey("dca:tok")).rejects.toThrow(/https:\/\/x/);
  });

  it("rejects an empty token without calling the network", async () => {
    await expect(mintMetaCodeKey("")).rejects.toThrow(/missing OAuth token/);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe("parseMetaSubsUsage", () => {
  it("maps window + weekly to percent quotas", () => {
    const q = parseMetaSubsUsage({
      window: { used_percent: 23.5, resets_at: 1790266000 },
      weekly: { used_percent: 7, resets_at: 1790600000 },
    });
    expect(q["Session (5h)"].used).toBe(23.5);
    expect(q["Session (5h)"].total).toBe(100);
    expect(q["Session (5h)"].remainingPercentage).toBe(76.5);
    expect(q["Session (5h)"].resetAt).toBeTypeOf("string");
    expect(q.Weekly.used).toBe(7);
  });

  it("clamps out-of-range percentages", () => {
    const q = parseMetaSubsUsage({ window: { used_percent: 150 } });
    expect(q["Session (5h)"].used).toBe(100);
    expect(q["Session (5h)"].remainingPercentage).toBe(0);
  });

  it("returns an empty object for missing subs_usage", () => {
    expect(parseMetaSubsUsage(undefined)).toEqual({});
  });
});

describe("getMetaCodeUsage", () => {
  it("asks for sign-in when no dca token is present", async () => {
    const r = await getMetaCodeUsage("");
    expect(r.message).toMatch(/only available/i);
  });

  it("reports the tier and quotas when the subscription is active", async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({
        api_key: "LLM|1|x",
        is_subs_active: true,
        subs_tier_name: "Everyday Usage",
        subs_usage: { window: { used_percent: 10 }, weekly: { used_percent: 5 } },
      })
    );
    const r = await getMetaCodeUsage("dca:live", null, { force: true });
    expect(r.plan).toBe("Everyday Usage");
    expect(r.quotas["Session (5h)"].used).toBe(10);
  });

  it("reports pay-as-you-go when the subscription is inactive", async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ api_key: "LLM|1|x", is_subs_active: false }));
    const r = await getMetaCodeUsage("dca:inactive", null, { force: true });
    expect(r.plan).toBe("Pay-as-you-go");
    expect(r.message).toMatch(/No active Muse Code subscription/);
  });

  it("surfaces an expired sign-in on 401", async () => {
    fetchWithTimeout.mockResolvedValue(errRes(401, "unauthorized"));
    const r = await getMetaCodeUsage("dca:dead", null, { force: true });
    expect(r.message).toMatch(/expired/i);
  });

  it("caches results until forced", async () => {
    fetchWithTimeout.mockResolvedValue(
      okJson({ api_key: "LLM|1|x", is_subs_active: true, subs_tier_name: "Everyday Usage" })
    );
    await getMetaCodeUsage("dca:cache", null, { force: true });
    const callsAfterFirst = fetchWithTimeout.mock.calls.length;
    await getMetaCodeUsage("dca:cache");
    expect(fetchWithTimeout.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("refreshMetaCodeToken", () => {
  it("re-mints and keeps the dca token as refreshToken", async () => {
    fetchWithTimeout.mockResolvedValue(okJson({ api_key: "LLM|new|x" }));
    const r = await refreshMetaCodeToken("dca:keep", console);
    expect(r).toEqual({ accessToken: "LLM|new|x", refreshToken: "dca:keep" });
  });

  it("maps a dead dca token (401) to invalid_grant", async () => {
    fetchWithTimeout.mockResolvedValue(errRes(401, "nope"));
    const r = await refreshMetaCodeToken("dca:dead", console);
    expect(r.error).toBe("invalid_grant");
  });

  it("returns null for a missing token without network calls", async () => {
    expect(await refreshMetaCodeToken("", console)).toBeNull();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
