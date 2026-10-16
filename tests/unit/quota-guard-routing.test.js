import { describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ getProviderConnections: vi.fn(), getSettings: async () => ({}), updateProviderConnection: vi.fn() }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (p) => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const paused = { id: "paused", isActive: true, quotaGuard: { enabled: true }, quotaGuardState: { paused: true } };

describe("quota guard routing", () => {
  it("skips a paused account even when pinned, selecting the next account", async () => {
    db.getProviderConnections.mockResolvedValue([paused, { id: "ready", isActive: true }]);
    expect(await getProviderCredentials("codex", null, "model", { preferredConnectionId: "paused" })).toMatchObject({ connectionId: "ready" });
  });
  it("reports an all-paused pool as unavailable", async () => {
    db.getProviderConnections.mockResolvedValue([paused]);
    expect(await getProviderCredentials("codex", null, "model")).toMatchObject({ allQuotaPaused: true });
  });
});
