import crypto from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCursorLoginSession,
  cursorIdentity,
  cursorTokenExpiry,
  machineIdConflict,
  pollCursorLoginSession,
  resetCursorLoginSessions,
  resolveCursorMachineId,
  tokensFromCursorCallback,
} from "../../src/lib/oauth/cursorLogin.js";

function jwt(payload) {
  return `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

describe("Cursor browser login", () => {
  afterEach(() => {
    resetCursorLoginSessions();
    vi.unstubAllGlobals();
  });

  it("puts only the PKCE challenge on the login URL", async () => {
    const { loginUrl, loginId } = createCursorLoginSession();
    const url = new URL(loginUrl);
    expect(url.origin + url.pathname).toBe("https://cursor.com/loginDeepControl");
    expect(url.searchParams.get("mode")).toBe("login");
    expect(url.searchParams.get("redirectTarget")).toBe("cli");
    expect(url.searchParams.get("uuid")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(url.searchParams.get("verifier")).toBeNull();
    expect(url.searchParams.get("challenge")).toBeTruthy();
    expect(loginId).not.toBe(url.searchParams.get("uuid"));

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404, "Not found"));
    await pollCursorLoginSession(loginId, fetchMock);
    const [pollUrl, init] = fetchMock.mock.calls[0];
    expect(pollUrl).toBe("https://api2.cursor.sh/auth/poll");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.uuid).toBe(url.searchParams.get("uuid"));
    expect(body.verifier).not.toBe(url.searchParams.get("challenge"));
    const challenge = crypto.createHash("sha256").update(body.verifier).digest("base64url");
    expect(challenge).toBe(url.searchParams.get("challenge"));
  });

  it("falls back to GET when POST /auth/poll is not served, then accepts tokens", async () => {
    const { loginId } = createCursorLoginSession();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(404, "Cannot POST"))
      .mockResolvedValueOnce(jsonResponse(200, {
        accessToken: "access-1",
        refreshToken: "refresh-1",
      }));
    const result = await pollCursorLoginSession(loginId, fetchMock);
    expect(result.tokens).toEqual({ accessToken: "access-1", refreshToken: "refresh-1" });
    expect(fetchMock.mock.calls[1][0]).toContain("/auth/poll?uuid=");
    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
    const again = await pollCursorLoginSession(loginId, fetchMock);
    expect(again.fatal).toBe(true);
  });

  it("stops on a rejected login", async () => {
    const { loginId } = createCursorLoginSession();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, "no"));
    const result = await pollCursorLoginSession(loginId, fetchMock);
    expect(result.fatal).toBe(true);
    expect(result.error).toContain("403");
  });

  it("gives a second account a new machine ID when the IDE id is already taken", () => {
    const shared = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const connections = [
      { id: "a", email: "a@ex.com", providerSpecificData: { machineId: shared } },
      { id: "b", email: "b@ex.com", providerSpecificData: { machineId: shared } },
    ];
    expect(resolveCursorMachineId(connections, connections[1])).not.toBe(shared);
    expect(resolveCursorMachineId(connections, connections[0])).not.toBe(shared);
  });

  it("keeps a machine ID that belongs to only one connection", () => {
    const own = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const connections = [
      { id: "a", providerSpecificData: { machineId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } },
      { id: "b", providerSpecificData: { machineId: own } },
    ];
    expect(resolveCursorMachineId(connections, connections[1])).toBe(own);
  });

  it("blocks importing a second account onto an in-use machine ID", () => {
    const machineId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const connections = [{
      id: "a",
      email: "a@ex.com",
      accessToken: "token-a",
      providerSpecificData: { machineId, userId: "user-a" },
    }];
    expect(machineIdConflict(connections, machineId, { email: "b@ex.com", userId: "user-b", accessToken: "token-b" })).toBeTruthy();
    expect(machineIdConflict(connections, machineId, { email: "a@ex.com", accessToken: "token-a" })).toBeNull();
  });

  it("reads tokens from a pasted callback URL and rejects a non-URL", () => {
    expect(tokensFromCursorCallback("http://localhost:20128/callback?accessToken=aaa&refreshToken=bbb")).toEqual({
      accessToken: "aaa",
      refreshToken: "bbb",
    });
    expect(tokensFromCursorCallback("http://localhost:20128/callback?code=abc")).toEqual({ callbackOnly: true });
    expect(tokensFromCursorCallback("http://localhost:20128/callback?error=access_denied").error).toBe("access_denied");
    expect(tokensFromCursorCallback("not a url").error).toMatch(/callback URL/);
  });

  it("reads identity from a userId::jwt access token", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `user_1::${jwt({ sub: "user_1", email: "a@ex.com", exp })}`;
    expect(cursorIdentity(token)).toEqual({ email: "a@ex.com", userId: "user_1" });
    expect(cursorTokenExpiry(token).expiresIn).toBeGreaterThan(3500);
    expect(cursorTokenExpiry(token).expiresIn).toBeLessThanOrEqual(3600);
  });
});

describe("refreshCursorToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function withFetch(payload, status, run) {
    const { refreshCursorToken: refresh } = await import("../../open-sse/services/tokenRefresh.js");
    const previous = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    });
    globalThis.fetch = fetchMock;
    try {
      return { result: await run(refresh), fetchMock };
    } finally {
      globalThis.fetch = previous;
    }
  }

  it("stores the refreshed access token and keeps the refresh token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const { result, fetchMock } = await withFetch(
      { access_token: jwt({ exp }), shouldLogout: false },
      200,
      (refresh) => refresh("refresh-old")
    );
    expect(result.accessToken).toContain(".");
    expect(result.refreshToken).toBe("refresh-old");
    expect(result.expiresIn).toBeGreaterThan(7000);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("refresh-old");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api2.cursor.sh/oauth/token");
  });

  it("treats shouldLogout as a dead refresh token", async () => {
    const { result } = await withFetch(
      { access_token: "", shouldLogout: true },
      200,
      (refresh) => refresh("refresh-dead")
    );
    expect(result).toEqual({ error: "invalid_grant" });
  });
});
