import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const USAGE_URL = "https://ollama.com/api/usage";
const ME_URL = "https://ollama.com/api/me";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_USAGE = {
  activity: {
    cost: "0.00000",
    period: {
      type: "last_4_weeks",
      starting_at: "2026-07-01T00:00:00Z",
      ending_at: "2026-07-29T00:00:00Z",
    },
    models: [],
  },
  limits: {
    session: { usage: 0, models: [] },
    weekly: {
      usage: 1,
      models: [
        { name: "glm-5.2", request_count: 5967 },
        { name: "kimi-k2.5", request_count: 2 },
      ],
    },
  },
};

const SAMPLE_FREE_USAGE = {
  activity: {
    cost: "0.00000",
    period: {
      type: "last_4_weeks",
      starting_at: "2026-08-24T00:00:00Z",
      ending_at: "2026-09-18T15:03:00Z",
    },
    models: [],
  },
  limits: {
    monthly: {
      usage: 0.021,
      models: [
        { name: "gpt-oss:120b", request_count: 6 },
        { name: "gemma4:31b", request_count: 6 },
      ],
    },
  },
};

const SAMPLE_ME = {
  Plan: "max",
};

// New pricing (2026-08-31): no `limits`; rolling totals instead.
const SAMPLE_NEW_7D = {
  range: "7d",
  scope: "self",
  granularity: "day",
  totals: { request_count: 11645, usage_usd: 40.32, input_tokens: 1315264488, output_tokens: 11968444 },
  buckets: [],
};
const SAMPLE_NEW_30D = {
  range: "30d",
  scope: "self",
  granularity: "day",
  totals: { request_count: 11826, usage_usd: 42.8, input_tokens: 1315364628, output_tokens: 11970000 },
  buckets: [],
};

describe("ollama registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("ollama");
    expect(USAGE_APIKEY_PROVIDERS).toContain("ollama");
  });
});

describe("getUsageForProvider(ollama)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GETs /api/usage with Bearer apiKey and POSTs /api/me for plan", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_USAGE))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ME));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Max");
    expect(usage.quotas["Session (5h)"]).toMatchObject({
      used: 0,
      total: 100,
      remainingPercentage: 100,
      unlimited: false,
    });
    expect(usage.quotas["Weekly (7d)"]).toMatchObject({
      used: 100,
      total: 100,
      remainingPercentage: 0,
      unlimited: false,
    });
    // Must not set absolute remaining — UI treats remaining as %
    expect(usage.quotas["Session (5h)"].remaining).toBeUndefined();
    expect(usage.quotas["Weekly (7d)"].remaining).toBeUndefined();

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);

    const [usageUrl, usageOpts] = proxyAwareFetch.mock.calls[0];
    expect(usageUrl).toBe(USAGE_URL);
    expect(usageOpts.headers.Authorization).toBe("Bearer k");
    expect(usageOpts.headers.Accept).toBe("application/json");

    const [meUrl, meOpts] = proxyAwareFetch.mock.calls[1];
    expect(meUrl).toBe(ME_URL);
    expect(meOpts.method).toBe("POST");
    expect(meOpts.headers.Authorization).toBe("Bearer k");
    expect(meOpts.headers["Content-Length"]).toBe("0");
  });

  it("maps the free plan's monthly window", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_FREE_USAGE))
      .mockResolvedValueOnce(jsonResponse({ Plan: "free" }));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Free");
    expect(Object.keys(usage.quotas)).toEqual(["Monthly"]);
    expect(usage.quotas["Monthly"]).toMatchObject({
      used: 2,
      total: 100,
      remainingPercentage: 98,
      unlimited: false,
    });
    expect(usage.quotas["Monthly"].remaining).toBeUndefined();
    expect(usage.quotas["Monthly"].resetAt).toBeNull();
  });

  describe("free plan monthly reset from signup date", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function monthlyResetAt(createdAt, now) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      proxyAwareFetch
        .mockResolvedValueOnce(jsonResponse(SAMPLE_FREE_USAGE))
        .mockResolvedValueOnce(jsonResponse({ Plan: "free", CreatedAt: createdAt }));

      const usage = await getUsageForProvider({
        provider: "ollama",
        apiKey: "k",
        providerSpecificData: {},
      });
      return usage.quotas["Monthly"].resetAt;
    }

    it("uses the signup day of the next month", async () => {
      expect(await monthlyResetAt("2025-09-06T22:15:39.871687Z", "2026-09-18T15:03:00Z"))
        .toBe("2026-10-06T22:15:39.000Z");
    });

    it("stays in the current month when the signup day is still ahead", async () => {
      expect(await monthlyResetAt("2026-09-18T09:50:49.514335Z", "2026-09-18T15:33:33Z"))
        .toBe("2026-10-18T09:50:49.000Z");
      expect(await monthlyResetAt("2025-09-25T10:00:00Z", "2026-09-18T15:33:33Z"))
        .toBe("2026-09-25T10:00:00.000Z");
    });

    it("clamps the signup day to shorter months", async () => {
      expect(await monthlyResetAt("2026-01-31T12:00:00Z", "2026-02-10T00:00:00Z"))
        .toBe("2026-02-28T12:00:00.000Z");
    });

    it("skips the reset when the plan is not free", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-18T15:03:00Z"));
      proxyAwareFetch
        .mockResolvedValueOnce(jsonResponse(SAMPLE_FREE_USAGE))
        .mockResolvedValueOnce(jsonResponse({ Plan: "pro", CreatedAt: "2025-09-06T22:15:39Z" }));

      const usage = await getUsageForProvider({
        provider: "ollama",
        apiKey: "k",
        providerSpecificData: {},
      });
      expect(usage.quotas["Monthly"].resetAt).toBeNull();
    });
  });

  it("surfaces rolling spend when the new pricing reports no limits", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_NEW_7D))
      .mockResolvedValueOnce(jsonResponse({ Plan: "pro", CreatedAt: "2026-02-01T09:13:23Z" }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_NEW_30D));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Pro");
    expect(Object.keys(usage.quotas)).toEqual(["Included usage (Pro · est.)", "Spent (7d)", "Spent (30d)"]);
    // Pool row: rolling 30d spend against the plan's published $60 pool, with a
    // familiar used/total bar. Marked "est." — see the code comment.
    expect(usage.quotas["Included usage (Pro · est.)"]).toMatchObject({
      used: 42.8,
      total: 60,
      remainingPercentage: 29,
      unlimited: false,
    });
    expect(usage.quotas["Spent (7d)"]).toMatchObject({
      total: 40.32,
      requestCount: 11645,
      isSpend: true,
      currency: "USD",
      resetAt: null,
    });
    // Spend must not masquerade as a quota percentage or a balance.
    expect(usage.quotas["Spent (7d)"].remainingPercentage).toBeUndefined();
    expect(usage.quotas["Spent (7d)"].isCreditBalance).toBeUndefined();
    expect(usage.quotas["Spent (30d)"].total).toBe(42.8);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps a window that spent $0 but did serve requests", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ range: "7d", totals: { request_count: 42, usage_usd: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ Plan: "free" }))
      .mockResolvedValueOnce(jsonResponse({ range: "30d", totals: { request_count: 42, usage_usd: 0 } }));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    // A free window still shows activity; it must not vanish as "no usage".
    expect(usage.message).toBeUndefined();
    expect(usage.quotas["Spent (7d)"]).toMatchObject({ total: 0, requestCount: 42, isSpend: true });
  });

  it("reports no usage when the new pricing window has no spend yet", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ range: "7d", totals: { request_count: 0, usage_usd: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ Plan: "free" }))
      .mockResolvedValueOnce(jsonResponse({ range: "30d", totals: { request_count: 0, usage_usd: 0 } }));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.message).toMatch(/no usage reported/i);
    expect(usage.quotas).toEqual({});
  });

  it("surfaces invalid key message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401),
    );

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "bad",
    });

    expect(usage.message).toMatch(/invalid/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("returns message when apiKey missing", async () => {
    const usage = await getUsageForProvider({
      provider: "ollama",
      providerSpecificData: {},
    });

    expect(usage.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("parseQuotaData(ollama)", () => {
  it("forwards rolling spend rows without a percentage", () => {
    const rows = parseQuotaData("ollama", {
      plan: "Pro",
      quotas: { "Spent (7d)": { used: 0, total: 40.32, requestCount: 11645, isSpend: true, currency: "USD", resetAt: null } },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Spent (7d)", total: 40.32, isSpend: true, requestCount: 11645, currency: "USD" });
    expect(rows[0].remainingPercentage).toBeUndefined();
  });

  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("ollama", {
      plan: "Max",
      quotas: {
        "Session (5h)": {
          used: 0,
          total: 100,
          remainingPercentage: 100,
          resetAt: null,
        },
        "Weekly (7d)": {
          used: 100,
          total: 100,
          remainingPercentage: 0,
          resetAt: null,
        },
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Session (5h)",
      used: 0,
      total: 100,
      remainingPercentage: 100,
    });
    expect(rows[1]).toMatchObject({
      name: "Weekly (7d)",
      used: 100,
      total: 100,
      remainingPercentage: 0,
    });
  });
});
