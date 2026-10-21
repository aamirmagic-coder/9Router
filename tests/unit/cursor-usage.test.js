import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { mapAggregatedUsageEvents } from "../../open-sse/services/usage/cursor.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const PERIOD_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const AGGREGATED_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents";
const PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const AUTH_USAGE_URL = "https://api2.cursor.sh/auth/usage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PERIOD_USAGE = {
  billingCycleStart: "1768399334000",
  billingCycleEnd: "1771077734000",
  planUsage: {
    totalSpend: 23222,
    includedSpend: 23222,
    bonusSpend: 0,
    remaining: 16778,
    limit: 40000,
    autoPercentUsed: 10,
    apiPercentUsed: 46.444,
    totalPercentUsed: 58.055,
  },
  spendLimitUsage: {
    individualLimit: 10000,
    individualUsed: 2500,
    individualRemaining: 7500,
    limitType: "user",
  },
};

const AGGREGATED_USAGE = {
  aggregations: [
    {
      modelIntent: "composer-2.5",
      inputTokens: "4861279",
      outputTokens: "726233",
      cacheReadTokens: "87013884",
      cacheWriteTokens: "0",
      totalCents: 2167.68593,
      tier: 2,
    },
    {
      modelIntent: "claude-4.6-sonnet-medium-thinking",
      inputTokens: "1000",
      outputTokens: "500",
      cacheReadTokens: "2000",
      cacheWriteTokens: "100",
      totalCents: 50.5,
      tier: 1,
    },
  ],
};

describe("cursor registry usage flags", () => {
  it("is listed for the quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("cursor");
  });
});

describe("mapAggregatedUsageEvents", () => {
  it("maps token strings and totalCents to modelUsage rows sorted by cost", () => {
    const rows = mapAggregatedUsageEvents(AGGREGATED_USAGE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      model: "composer-2.5",
      inputTokens: 4861279,
      outputTokens: 726233,
      cacheReadTokens: 87013884,
      cacheWriteTokens: 0,
      costUsd: 21.6769,
    });
    expect(rows[1].model).toBe("claude-4.6-sonnet-medium-thinking");
    expect(rows[1].costUsd).toBe(0.505);
  });

  it("returns empty array for missing aggregations", () => {
    expect(mapAggregatedUsageEvents({})).toEqual([]);
    expect(mapAggregatedUsageEvents(null)).toEqual([]);
  });
});

describe("getUsageForProvider(cursor)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs GetCurrentPeriodUsage with Connect JSON headers", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(PERIOD_USAGE))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ planInfo: { planName: "Pro+" } }));

    const usage = await getUsageForProvider({
      provider: "cursor",
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-1" },
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Cursor Pro+");
    expect(proxyAwareFetch.mock.calls[0][0]).toBe(PERIOD_URL);
    expect(proxyAwareFetch.mock.calls[0][1].method).toBe("POST");
    expect(proxyAwareFetch.mock.calls[0][1].body).toBe("{}");
    expect(proxyAwareFetch.mock.calls[0][1].headers["content-type"]).toBe("application/json");
    expect(proxyAwareFetch.mock.calls[0][1].headers.authorization).toMatch(/^Bearer /);
    expect(proxyAwareFetch.mock.calls[1][0]).toBe(AGGREGATED_URL);
    expect(proxyAwareFetch.mock.calls[2][0]).toBe(PLAN_URL);
  });

  it("maps plan percents and on-demand USD without Plan (USD) bar", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(PERIOD_USAGE))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ planInfo: { planName: "Ultra" } }));

    const usage = await getUsageForProvider({
      provider: "cursor",
      accessToken: "cursor-token",
    });

    expect(usage.quotas["Plan (USD)"]).toBeUndefined();
    expect(usage.quotas["On-demand (USD)"]).toMatchObject({
      used: 25,
      total: 100,
      remainingPercentage: 75,
    });
    expect(usage.quotas["Cursor Models (%)"].used).toBe(10);
    expect(usage.quotas["Other Models (%)"].used).toBe(46.444);
  });

  it("maps GetAggregatedUsageEvents into modelUsage", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(PERIOD_USAGE))
      .mockResolvedValueOnce(jsonResponse(AGGREGATED_USAGE))
      .mockResolvedValueOnce(jsonResponse({ planInfo: { planName: "Pro+" } }));

    const usage = await getUsageForProvider({
      provider: "cursor",
      accessToken: "cursor-token",
    });

    expect(usage.modelUsage).toEqual([
      {
        model: "composer-2.5",
        inputTokens: 4861279,
        outputTokens: 726233,
        cacheReadTokens: 87013884,
        cacheWriteTokens: 0,
        costUsd: 21.6769,
      },
      {
        model: "claude-4.6-sonnet-medium-thinking",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 100,
        costUsd: 0.505,
      },
    ]);
  });

  it("keeps quotas when GetAggregatedUsageEvents fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(PERIOD_USAGE))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 500))
      .mockResolvedValueOnce(jsonResponse({ planInfo: { planName: "Pro" } }));

    const usage = await getUsageForProvider({
      provider: "cursor",
      accessToken: "cursor-token",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Cursor Pro");
    expect(usage.quotas["Cursor Models (%)"].used).toBe(10);
    expect(usage.quotas["Other Models (%)"].used).toBe(46.444);
    expect(usage.modelUsage).toBeUndefined();
  });

  it("falls back to /auth/usage request buckets when plan spend is empty", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({
        "gpt-4": { numRequests: 20, maxRequestUsage: 500 },
        startOfMonth: "2026-06-25T05:42:21.000Z",
      }))
      .mockResolvedValueOnce(jsonResponse({ planInfo: { planName: "Enterprise" } }));

    const usage = await getUsageForProvider({
      provider: "cursor",
      accessToken: "cursor-token",
    });

    expect(proxyAwareFetch.mock.calls[1][0]).toBe(AGGREGATED_URL);
    expect(proxyAwareFetch.mock.calls[2][0]).toBe(AUTH_USAGE_URL);
    expect(usage.quotas["gpt-4 requests"]).toMatchObject({
      used: 20,
      total: 500,
      remainingPercentage: 96,
    });
  });

  it("returns message on missing token / 401", async () => {
    const missing = await getUsageForProvider({ provider: "cursor" });
    expect(missing.message).toMatch(/token/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "no" }, 401));
    const auth = await getUsageForProvider({
      provider: "cursor",
      accessToken: "bad",
    });
    expect(auth.message).toMatch(/auth|reconnect/i);
  });
});

describe("parseQuotaData(cursor)", () => {
  it("forwards remainingPercentage for model percent rows", () => {
    const rows = parseQuotaData("cursor", {
      plan: "Cursor Pro",
      quotas: {
        "Cursor Models (%)": {
          used: 77,
          total: 100,
          remainingPercentage: 23,
        },
      },
    });
    expect(rows[0]).toMatchObject({
      name: "Cursor Models (%)",
      used: 77,
      total: 100,
      remainingPercentage: 23,
    });
  });
});
