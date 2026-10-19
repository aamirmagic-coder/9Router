import { describe, it, expect, vi, beforeEach } from "vitest";

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

const BASE = "https://api.commandcode.ai";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const WHOAMI = {
  user: { name: "Hieu", email: "hieu@example.com" },
  org: { id: "org_1", name: "personal" },
};
const CREDITS = {
  credits: { monthlyCredits: 12.5, purchasedCredits: 1, freeCredits: 0.5 },
  windowLimits: {
    fiveHour: { used: 2, cap: 10, resetAt: Date.now() + 3_600_000, exceeded: false },
    weekly: { used: 20, cap: 70, resetAt: Date.now() + 86_400_000, exceeded: false },
  },
};
const SUBS = {
  data: {
    planId: "individual-goat",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
  },
};

function mockHappyPath() {
  mockUsage({});
}

// Live-shape payload for a Go v1 subscription: 7.5633222903 of a 10-credit
// monthly allowance left, so the provider's own dashboard reads 24%.
const GO_V1_CREDITS = {
  credits: { monthlyCredits: 7.5633222903, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    fiveHour: { used: 1.1345262453, cap: 3, resetAt: 1791893425711 },
    weekly: { used: 2.4366777097, cap: 6, resetAt: 1792397174201 },
  },
};
const GO_V1_SUBS = {
  data: {
    planId: "individual-go-v1",
    currentPeriodStart: "2026-10-10T02:30:18.000Z",
    currentPeriodEnd: "2026-11-10T02:30:18.000Z",
  },
};

function mockUsage({ planId, credits = CREDITS }) {
  proxyAwareFetch.mockImplementation(async (url) => {
    const u = String(url);
    const subs = planId ? { data: { ...SUBS.data, planId } } : SUBS;
    if (u.includes("/alpha/whoami")) return jsonResponse(WHOAMI);
    if (u.includes("/alpha/billing/credits")) return jsonResponse(credits);
    if (u.includes("/alpha/billing/subscriptions")) return jsonResponse(subs);
    return jsonResponse({ error: "unexpected " + u }, 404);
  });
}

describe("commandcode registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("commandcode");
    expect(USAGE_APIKEY_PROVIDERS).toContain("commandcode");
  });
});

describe("getUsageForProvider(commandcode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a message when apiKey is missing", async () => {
    const usage = await getUsageForProvider({ provider: "commandcode" });
    expect(usage.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("GETs whoami, credits, and subscriptions with Bearer apiKey", async () => {
    mockHappyPath();
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "user_test",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("GOAT");
    const urls = proxyAwareFetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.startsWith(`${BASE}/alpha/whoami`))).toBe(true);
    expect(urls.some((u) => u.includes("/alpha/billing/credits") && u.includes("orgId=org_1"))).toBe(true);
    expect(urls.some((u) => u.includes("/alpha/billing/subscriptions") && u.includes("orgId=org_1"))).toBe(true);
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer user_test");
  });

  it("maps remaining credits vs plan cap and rate windows", async () => {
    mockHappyPath();
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "user_test",
    });

    // remaining = 12.5 + 1 + 0.5 = 14; cap GOAT = 70; used = 56
    expect(usage.quotas.Credits).toMatchObject({
      used: 56,
      total: 70,
      unlimited: false,
    });
    expect(usage.quotas["Session (5h)"]).toMatchObject({
      used: 2,
      total: 10,
      unlimited: false,
    });
    expect(usage.quotas.Weekly).toMatchObject({
      used: 20,
      total: 70,
    });
    expect(new Date(usage.quotas.Credits.resetAt).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("returns an auth message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "bad",
    });
    expect(usage.message).toMatch(/auth|key|login/i);
  });

  it("reads a percentage for the Go v1 plan instead of reporting it unlimited", async () => {
    mockUsage({ planId: "individual-go-v1", credits: GO_V1_CREDITS });
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "user_test",
    });

    expect(usage.plan).toBe("Go");
    const credits = usage.quotas.Credits;
    expect(credits.unlimited).toBe(false);
    expect(credits.isCreditBalance).toBe(false);
    expect(credits.total).toBe(10);
    expect(credits.used).toBeCloseTo(2.4366777097, 6);
    // What the provider's own dashboard shows for the same month.
    expect(Math.round((credits.used / credits.total) * 100)).toBe(24);
  });

  it("reports an unmapped plan as a balance, never as unlimited", async () => {
    mockUsage({ planId: "individual-something-new" });
    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "user_test",
    });

    // Fixture balance is 14 credits and the cap is unknown.
    expect(usage.quotas.Credits.unlimited).toBe(true);
    expect(usage.quotas.Credits.isCreditBalance).toBe(true);
    expect(usage.quotas.Credits.total).toBe(14);
  });
});

describe("parseQuotaData(commandcode)", () => {
  it("forwards used/total/resetAt for the dashboard table", () => {
    const rows = parseQuotaData("commandcode", {
      plan: "GOAT",
      quotas: {
        Credits: { used: 56, total: 70, resetAt: "2026-10-01T00:00:00.000Z" },
        "Session (5h)": { used: 2, total: 10, resetAt: "2026-09-16T10:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Credits", used: 56, total: 70 });
    expect(rows[1]).toMatchObject({ name: "Session (5h)", used: 2, total: 10 });
  });

  it("keeps an unmapped plan's credits row flagged as a balance", () => {
    const rows = parseQuotaData("commandcode", {
      plan: "individual-something-new",
      quotas: {
        Credits: {
          used: 0,
          total: 7.5633222903,
          unlimited: true,
          isCreditBalance: true,
          resetAt: "2026-11-10T02:30:18.000Z",
        },
      },
    });
    expect(rows[0]).toMatchObject({ name: "Credits", unlimited: true, isCreditBalance: true });
  });
});
