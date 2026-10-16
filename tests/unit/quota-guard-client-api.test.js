import { describe, expect, it, vi } from "vitest";
const conn = vi.hoisted(() => ({ id: "a", provider: "codex", authType: "oauth", isActive: true,
  accessToken: "secret", quotaGuard: { enabled: true, thresholdPercent: 30 }, quotaGuardState: { paused: true } }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, options) => Response.json(body, options) } }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: async () => [conn] }));
vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: async () => {} }));
const { GET } = await import("../../src/app/api/providers/client/route.js");
describe("quota tracker guard state", () => {
  it("includes safe guard settings and status in account cards", async () => {
    const res = await GET(new Request("http://localhost/api/providers/client"));
    const { connections } = await res.json();
    expect(connections[0].quotaGuard).toEqual(conn.quotaGuard);
    expect(connections[0].quotaGuardState).toEqual({ paused: true });
    expect(connections[0].accessToken).toBeUndefined();
  });
  it("includes auto-paused accounts in the inactive filter", async () => {
    const res = await GET(new Request("http://localhost/api/providers/client?accountStatus=inactive"));
    expect((await res.json()).connections).toHaveLength(1);
  });
});
