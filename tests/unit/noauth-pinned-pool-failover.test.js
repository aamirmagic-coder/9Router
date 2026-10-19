import { describe, it, expect, vi, beforeEach } from "vitest";

// Pinned-pool (`rotateStrategy: "none"` + `proxyPoolId`) behaviour for no-auth
// free providers. A relay IP can get blocked upstream (403 FreeTierError) or
// answer 429/5xx at any time, independent of the model; the pinned pool must
// therefore fail over to the other active pools on retry instead of turning a
// single blocked egress IP into a hard client error.
const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(async (id) => ({
    id,
    isActive: true,
    proxyUrl: `https://relay-${id}.example`,
    type: "vercel",
    strictProxy: false,
  })),
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const POOLS = [
  { id: "pool-pinned", isActive: true, proxyUrl: "https://pinned.example", type: "vercel" },
  { id: "pool-b", isActive: true, proxyUrl: "https://b.example", type: "vercel" },
  { id: "pool-c", isActive: true, proxyUrl: "https://c.example", type: "vercel" },
  { id: "pool-no-url", isActive: true, proxyUrl: "", type: "vercel" },
];

describe("noauth pinned proxy pool failover (opencode free)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { proxyPoolId: "pool-pinned", rotateStrategy: "none" } },
    });
    mocks.getProxyPools.mockResolvedValue(POOLS);
    mocks.getProviderConnections.mockResolvedValue([]);
  });

  it("uses the pinned pool while it is healthy", async () => {
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4.1-flash-free");
    expect(creds.connectionId).toBe("proxy:pool-pinned");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("https://relay-pool-pinned.example");
  });

  it("fails over to another active pool when the pinned pool was excluded after a 403", async () => {
    const creds = await getProviderCredentials(
      "opencode",
      new Set(["proxy:pool-pinned"]),
      "deepseek-v4.1-flash-free",
    );
    expect(creds).not.toBeNull();
    expect(creds.connectionId).toBe("proxy:pool-b");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("https://relay-pool-b.example");
  });

  it("walks to the next pool when the first fallback is excluded too", async () => {
    const creds = await getProviderCredentials(
      "opencode",
      new Set(["proxy:pool-pinned", "proxy:pool-b"]),
      "deepseek-v4.1-flash-free",
    );
    expect(creds.connectionId).toBe("proxy:pool-c");
  });

  it("skips pools without a proxy url and returns null when all candidates are exhausted", async () => {
    const creds = await getProviderCredentials(
      "opencode",
      new Set(["proxy:pool-pinned", "proxy:pool-b", "proxy:pool-c"]),
      "deepseek-v4.1-flash-free",
    );
    expect(creds).toBeNull();
  });
});
