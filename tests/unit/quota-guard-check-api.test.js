import { describe, expect, it, vi } from "vitest";
vi.mock("@/shared/services/quotaGuardMonitor.js", () => ({ checkQuotaGuardNow: async (id) => id === "missing" ? null : ({ id, accessToken: "secret", quotaGuardState: { paused: false } }) }));
const api = await import("../../src/app/api/providers/[id]/quota-guard/route.js").catch(() => ({}));
describe("manual quota check API", () => {
  it("returns safe account state after checking usage", async () => {
    expect(api.POST).toBeTypeOf("function");
    const res = await api.POST(null, { params: { id: "a" } });
    expect((await res.json()).connection).toEqual({ id: "a", quotaGuardState: { paused: false } });
  });
  it("returns 404 for a missing account", async () => {
    expect((await api.POST(null, { params: { id: "missing" } })).status).toBe(404);
  });
});
