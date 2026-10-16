import { describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ connection: { id: "a", provider: "codex", authType: "oauth", accessToken: "expired", refreshToken: "refresh", expiresAt: "2099-01-01" } }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: async () => store.connection,
  updateProviderConnection: async (_, patch) => { store.connection = { ...store.connection, ...patch }; },
}));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: () => ({
  needsRefresh: () => false,
  refreshCredentials: async () => ({ accessToken: "fresh", refreshToken: "rotated", expiresIn: 3600 }),
}) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({ strictProxy: true }) }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: async (c) => c.accessToken === "fresh"
  ? { quotas: { session: { remaining: 90, total: 100 } } } : { message: "Usage API temporarily unavailable (401)" } }));
const service = await import("../../src/shared/services/providerUsage.js").catch(() => ({}));
describe("background quota OAuth recovery", () => {
  it("refreshes and retries a prematurely expired access token without a dashboard request", async () => {
    expect(service.getConnectionUsage).toBeTypeOf("function");
    const { usage } = await service.getConnectionUsage(store.connection);
    expect(usage.quotas.session.remaining).toBe(90);
    expect(store.connection.accessToken).toBe("fresh");
    expect(store.connection.refreshToken).toBe("rotated");
  });
});
