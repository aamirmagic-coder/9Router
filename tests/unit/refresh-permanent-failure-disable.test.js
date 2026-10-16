// A permanent OAuth refresh failure (invalid_grant / refresh_token_reused) means the
// refresh token can never work again. The account must be disabled, otherwise
// selectConnectionsNeedingRefresh re-selects it every 5-minute tick forever —
// its expiresAt never advances, so it is permanently "due" — spamming the provider
// and the log with the same error.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const updateProviderConnection = vi.fn(async () => true);
// Adopt-latest-token lookup: checkAndRefreshToken re-reads the connection before
// refreshing so a rotated refresh token is never reused (upstream fix for the
// Codex logout-on-auto-ping bug). Returning null keeps each case on the
// credentials it passed in.
const getProviderConnectionById = vi.fn(async () => null);
const refreshProviderCredentials = vi.fn();
const shouldRefreshCredentials = vi.fn(() => true);

vi.mock("../../src/lib/localDb.js", () => ({
  updateProviderConnection: (...args) => updateProviderConnection(...args),
  getProviderConnectionById: (...args) => getProviderConnectionById(...args),
}));

vi.mock("../../open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: (...args) => refreshProviderCredentials(...args),
  shouldRefreshCredentials: (...args) => shouldRefreshCredentials(...args),
}));

function creds(overrides = {}) {
  return {
    connectionId: "conn-1",
    provider: "antigravity",
    refreshToken: "rt-1",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

describe("checkAndRefreshToken — permanent refresh failure disables the connection", () => {
  beforeEach(() => {
    updateProviderConnection.mockClear();
    getProviderConnectionById.mockClear();
    refreshProviderCredentials.mockReset();
    shouldRefreshCredentials.mockReturnValue(true);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("disables the connection when the refresh token is invalid_grant", async () => {
    refreshProviderCredentials.mockResolvedValue({ error: "invalid_grant", message: "Account has been deleted" });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    await checkAndRefreshToken("antigravity", creds());

    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
    const [id, patch] = updateProviderConnection.mock.calls[0];
    expect(id).toBe("conn-1");
    expect(patch.isActive).toBe(false);
    expect(patch.errorCode).toBe(401);
    expect(patch.testStatus).toBe("unavailable");
    expect(patch.lastError).toContain("invalid_grant");
  });

  it("disables the connection for the codex unrecoverable error", async () => {
    refreshProviderCredentials.mockResolvedValue({ error: "unrecoverable_refresh_error", code: "refresh_token_reused" });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    await checkAndRefreshToken("codex", creds());

    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(updateProviderConnection.mock.calls[0][1].isActive).toBe(false);
  });

  it("disables the connection when the refresh token was reused", async () => {
    refreshProviderCredentials.mockResolvedValue({ error: "refresh_token_reused" });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    await checkAndRefreshToken("antigravity", creds());

    expect(updateProviderConnection.mock.calls[0][1].isActive).toBe(false);
  });

  it("does NOT disable on a transient failure (null result)", async () => {
    refreshProviderCredentials.mockResolvedValue(null);
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    await checkAndRefreshToken("antigravity", creds());

    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does NOT disable on a healthy refresh", async () => {
    refreshProviderCredentials.mockResolvedValue({ accessToken: "at-2", expiresIn: 3600 });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    await checkAndRefreshToken("antigravity", creds());

    // The healthy path writes credentials, but never isActive:false.
    const patches = updateProviderConnection.mock.calls.map(([, p]) => p);
    expect(patches.some((p) => p.isActive === false)).toBe(false);
  });

  it("still returns the old credentials so the caller fails the request normally", async () => {
    refreshProviderCredentials.mockResolvedValue({ error: "invalid_grant", message: "deleted" });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    const out = await checkAndRefreshToken("antigravity", creds({ accessToken: "stale-at" }));

    expect(out.refreshToken).toBe("rt-1");
    expect(out.connectionId).toBe("conn-1");
  });

  it("swallows a DB write failure instead of throwing at the caller", async () => {
    refreshProviderCredentials.mockResolvedValue({ error: "invalid_grant" });
    updateProviderConnection.mockRejectedValueOnce(new Error("db locked"));
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    await expect(checkAndRefreshToken("antigravity", creds())).resolves.toBeTruthy();
  });
});
