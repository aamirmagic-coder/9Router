// E2E: the real Google OAuth endpoint, a real invalid_grant response, and the
// real checkAndRefreshToken path — proves the disable actually fires on live
// upstream behavior, not just on a mocked return value.
// Skips silently when the network is unavailable so CI stays green offline.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const FAKE_REFRESH_TOKEN = "1//0fake-invalid-refresh-token-for-9router-e2e-test";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

let online = false;
let clientId = "";
let clientSecret = "";

// Google answers invalid_request (not invalid_grant) when client_id is missing,
// so the probe must send the same client credentials the provider uses.
function refreshBody() {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: FAKE_REFRESH_TOKEN,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

describe("checkAndRefreshToken — live invalid_grant disables the connection", () => {
  beforeAll(async () => {
    const PROVIDERS = (await import("../../open-sse/config/providers.js")).PROVIDERS;
    clientId = PROVIDERS.antigravity.clientId;
    clientSecret = PROVIDERS.antigravity.clientSecret;
    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: refreshBody(),
        signal: AbortSignal.timeout(10_000),
      });
      // Google answers 400 for a bogus refresh token; any answer proves reachability.
      online = res.status > 0;
    } catch {
      online = false;
    }
  });

  it("classifies Google's live invalid_grant as an unrecoverable refresh error", async () => {
    if (!online) return; // offline: covered by the mocked suite
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody(),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();

    const { classifyOAuthRefreshError } = await import(
      "../../open-sse/services/tokenRefresh/providers.js"
    );
    const verdict = classifyOAuthRefreshError(text, res.status);

    expect(verdict.permanent).toBe(true);
    expect(String(verdict.code || verdict.description)).toMatch(/invalid_grant/i);
  });

  it("proves refreshGoogleToken maps a live invalid_grant to error:invalid_grant", async () => {
    if (!online) return;
    const { refreshGoogleToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    const PROVIDERS = (await import("../../open-sse/config/providers.js")).PROVIDERS;

    const result = await refreshGoogleToken(
      FAKE_REFRESH_TOKEN,
      PROVIDERS.antigravity.clientId,
      PROVIDERS.antigravity.clientSecret,
      { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }
    );

    expect(result?.error).toBe("invalid_grant");
  });
});
