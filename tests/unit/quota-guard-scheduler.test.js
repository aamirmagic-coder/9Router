import { afterEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ connection: { id: "a", provider: "kiro", isActive: true,
  quotaGuard: { enabled: true, thresholdPercent: 50 } }, remaining: 40 }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: async () => [store.connection],
  getProviderConnectionById: async () => store.connection,
  updateProviderQuotaGuardState: async (_, state) => (store.connection = { ...store.connection, quotaGuardState: state }),
}));
vi.mock("@/shared/services/providerUsage.js", () => ({ getConnectionUsage: async () => ({ usage: {
  quotas: { credits: { remaining: store.remaining, total: 100 } },
} }) }));
const monitor = await import("../../src/shared/services/quotaGuardMonitor.js");
afterEach(() => { monitor.stopQuotaGuardMonitor(); vi.useRealTimers(); });

describe("quota guard server scheduler", () => {
  it("checks at startup and recovers on its 60-second interval with no UI requests", async () => {
    vi.useFakeTimers();
    monitor.startQuotaGuardMonitor();
    await vi.waitFor(() => expect(store.connection.quotaGuardState?.paused).toBe(true));
    store.remaining = 90;
    await vi.advanceTimersByTimeAsync(60000);
    expect(store.connection.quotaGuardState.paused).toBe(false);
    monitor.stopQuotaGuardMonitor();
    store.remaining = 10;
    await vi.advanceTimersByTimeAsync(60000);
    expect(store.connection.quotaGuardState.paused).toBe(false);
  });
});
