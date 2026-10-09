import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials, resolveConnectionQuota, markAccountUnavailable } = await import("@/sse/services/auth.js");
const { getAntigravityQuotaCache } = await import("@/sse/services/antigravityQuota.js");

const NOW = new Date("2026-08-26T12:00:00.000Z").getTime();
const RESET_IN_30M = new Date(NOW + 30 * 60 * 1000).toISOString();
const RESET_IN_1H = new Date(NOW + 60 * 60 * 1000).toISOString();
const RESET_IN_3H = new Date(NOW + 3 * 60 * 60 * 1000).toISOString();
const RESET_PAST = new Date(NOW - 10 * 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  getAntigravityQuotaCache().clear();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({ fallbackStrategy: "earliest-reset" });
});

describe("Earliest Quota Reset Routing Strategy", () => {
  it("prioritizes account whose quota resets soonest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        name: "Account 1 (resets in 3h)",
        priority: 1,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 80, resetAt: RESET_IN_3H },
        },
      },
      {
        id: "conn-2",
        name: "Account 2 (resets in 30m)",
        priority: 2,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 40, resetAt: RESET_IN_30M },
        },
      },
    ]);

    try {
      const creds = await getProviderCredentials("claude", null, "claude-3-5-sonnet");
      expect(creds.connectionId).toBe("conn-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips exhausted accounts (0% remaining with future reset)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-exhausted",
        name: "Account Exhausted (resets in 30m)",
        priority: 1,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 0, resetAt: RESET_IN_30M },
        },
      },
      {
        id: "conn-available",
        name: "Account Available (resets in 3h)",
        priority: 2,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 50, resetAt: RESET_IN_3H },
        },
      },
    ]);

    try {
      const creds = await getProviderCredentials("claude", null, "claude-3-5-sonnet");
      expect(creds.connectionId).toBe("conn-available");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an account back into rotation once reset time has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-refreshed",
        name: "Account Refreshed",
        priority: 1,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 0, resetAt: RESET_PAST },
        },
      },
    ]);

    try {
      const creds = await getProviderCredentials("claude", null, "claude-3-5-sonnet");
      expect(creds.connectionId).toBe("conn-refreshed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prioritizes known future reset over accounts with unknown quota, and falls back to priority", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    // Account with future reset vs Account without quota info
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-no-quota",
        name: "Account No Quota",
        priority: 1,
        isActive: true,
      },
      {
        id: "conn-with-quota",
        name: "Account With Quota",
        priority: 2,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 90, resetAt: RESET_IN_1H },
        },
      },
    ]);

    try {
      const creds = await getProviderCredentials("codex", null, "gpt-4o");
      expect(creds.connectionId).toBe("conn-with-quota");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to priority when neither account has future reset info", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-p1",
        name: "Account Priority 1",
        priority: 1,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 100, resetAt: RESET_PAST },
        },
      },
      {
        id: "conn-p2",
        name: "Account Priority 2",
        priority: 2,
        isActive: true,
      },
    ]);

    try {
      const creds = await getProviderCredentials("claude", null, "claude-3-5-sonnet");
      expect(creds.connectionId).toBe("conn-p1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports allRateLimited: true with earliest retryAfter when all accounts are exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        name: "Exhausted 3h",
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 0, resetAt: RESET_IN_3H },
        },
      },
      {
        id: "conn-2",
        name: "Exhausted 30m",
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 0, resetAt: RESET_IN_30M },
        },
      },
    ]);

    try {
      const creds = await getProviderCredentials("claude", null, "claude-3-5-sonnet");
      expect(creds.allRateLimited).toBe(true);
      expect(creds.retryAfter).toBe(RESET_IN_30M);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves model-specific quota buckets as well as session windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    try {
      // 1. Model specific match
      const connWithModelQuota = {
        cachedQuotas: {
          "gemini-2.5-pro": { remainingPercentage: 50, resetAt: RESET_IN_30M },
          "gemini-2.5-flash": { remainingPercentage: 10, resetAt: RESET_IN_1H },
        },
      };
      const qPro = resolveConnectionQuota(connWithModelQuota, "gemini-2.5-pro", "gemini-cli");
      expect(qPro.resetAt).toBe(RESET_IN_30M);

      const qFlash = resolveConnectionQuota(connWithModelQuota, "gemini-2.5-flash", "gemini-cli");
      expect(qFlash.resetAt).toBe(RESET_IN_1H);

      // 2. Session window match (Claude 5h)
      const connClaude = {
        cachedQuotas: {
          "session (5h)": { remainingPercentage: 75, resetAt: RESET_IN_1H },
          "weekly (7d)": { remainingPercentage: 90, resetAt: RESET_IN_3H },
        },
      };
      const qClaude = resolveConnectionQuota(connClaude, "claude-3-7-sonnet", "claude");
      expect(qClaude.resetAt).toBe(RESET_IN_1H);

      // 3. Exhausted session window marks model as exhausted
      const connClaudeExhausted = {
        cachedQuotas: {
          "session (5h)": { remainingPercentage: 0, resetAt: RESET_IN_30M },
          "weekly (7d)": { remainingPercentage: 90, resetAt: RESET_IN_3H },
        },
      };
      const qClaudeEx = resolveConnectionQuota(connClaudeExhausted, "claude-3-7-sonnet", "claude");
      expect(qClaudeEx.remainingPercentage).toBe(0);
      expect(qClaudeEx.resetAt).toBe(RESET_IN_30M);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates cachedQuotas when an account receives a 429 error in markAccountUnavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-429",
        name: "Account",
        cachedQuotas: {},
      },
    ]);

    try {
      const cooldownMs = 60 * 1000;
      const resetsAtMs = NOW + cooldownMs;
      await markAccountUnavailable("conn-429", 429, "Rate limit reached", "claude", "claude-3-5-sonnet", resetsAtMs);

      expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
        "conn-429",
        expect.objectContaining({
          testStatus: "unavailable",
          cachedQuotas: expect.objectContaining({
            "claude-3-5-sonnet": expect.objectContaining({
              remainingPercentage: 0,
              resetAt: new Date(resetsAtMs).toISOString(),
            }),
          }),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects per-provider strategy override over global fallbackStrategy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    // Global strategy is fill-first, but provider strategy is earliest-reset
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: {
        claude: { fallbackStrategy: "earliest-reset" },
      },
    });

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        priority: 1,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 80, resetAt: RESET_IN_3H },
        },
      },
      {
        id: "conn-2",
        priority: 2,
        isActive: true,
        cachedQuotas: {
          session: { remainingPercentage: 40, resetAt: RESET_IN_30M },
        },
      },
    ]);

    try {
      const creds = await getProviderCredentials("claude", null, "claude-3-5-sonnet");
      // conn-2 has earlier reset time (30m vs 3h), selected due to per-provider override
      expect(creds.connectionId).toBe("conn-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents cross-model quota leakage when an unrelated model is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-multi",
        priority: 1,
        isActive: true,
        cachedQuotas: {
          "claude-3-7-sonnet": { remainingPercentage: 0, resetAt: RESET_IN_1H },
        },
      },
    ]);

    try {
      // 1. Quota resolution for requested model claude-3-5-haiku does NOT match claude-3-7-sonnet
      const quotaHaiku = resolveConnectionQuota(
        { cachedQuotas: { "claude-3-7-sonnet": { remainingPercentage: 0, resetAt: RESET_IN_1H } } },
        "claude-3-5-haiku",
        "claude"
      );
      expect(quotaHaiku).toBeNull();

      // 2. getProviderCredentials for claude-3-5-haiku does NOT skip conn-multi
      const creds = await getProviderCredentials("claude", null, "claude-3-5-haiku");
      expect(creds).not.toBeNull();
      expect(creds.connectionId).toBe("conn-multi");

      // 3. But requesting claude-3-7-sonnet IS blocked as exhausted
      const credsSonnet = await getProviderCredentials("claude", null, "claude-3-7-sonnet");
      expect(credsSonnet.allRateLimited).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not write cachedQuotas on transient 429 without explicit resetsAtMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-transient",
        name: "Transient Throttled",
        cachedQuotas: {
          session: { remainingPercentage: 80, resetAt: RESET_IN_3H },
        },
      },
    ]);

    try {
      // Transient 429 with no resetsAtMs (e.g. concurrency limit)
      await markAccountUnavailable("conn-transient", 429, "Too Many Requests", "claude", "claude-3-5-sonnet", null);

      expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
        "conn-transient",
        expect.not.objectContaining({
          cachedQuotas: expect.anything(),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
