import crypto from "crypto";
import { PROVIDER_OAUTH } from "open-sse/providers/index.js";
import { generateCodeChallenge, generateCodeVerifier } from "./utils/pkce.js";

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 20;
const TERMINAL_POLL_STATUSES = new Set([400, 401, 403, 410]);

const sessions = new Map();

function cursorOAuth() {
  const config = PROVIDER_OAUTH.cursor;
  if (!config?.loginUrl || !config?.pollUrl) {
    throw new Error("Cursor login is not configured");
  }
  return config;
}

function pruneSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function resetCursorLoginSessions() {
  sessions.clear();
}

export function discardCursorLoginSession(loginId) {
  if (typeof loginId === "string") sessions.delete(loginId);
}

function callbackParam(url, key) {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  return url.searchParams.get(key) || hash.get(key);
}

/**
 * Pull tokens out of a pasted callback URL. Cursor's browser login usually
 * finishes by poll, but a redirect that carries the session is accepted too.
 * A URL with no tokens is still a callback paste — the caller polls.
 */
export function tokensFromCursorCallback(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "Paste the full callback URL" };
  }
  const error = callbackParam(url, "error");
  if (error) return { error: callbackParam(url, "error_description") || error };
  const accessToken = callbackParam(url, "accessToken") || callbackParam(url, "access_token");
  const refreshToken = callbackParam(url, "refreshToken") || callbackParam(url, "refresh_token");
  if (accessToken && refreshToken) return { accessToken, refreshToken };
  return { callbackOnly: true };
}

/**
 * Start a Cursor CLI-style browser login.
 * The verifier stays in this process. The browser URL carries only the PKCE challenge.
 */
export function createCursorLoginSession() {
  pruneSessions();
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error("Too many Cursor logins are waiting. Finish or close one, then try again.");
  }

  const { loginUrl } = cursorOAuth();
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const uuid = crypto.randomUUID();
  const loginId = crypto.randomBytes(16).toString("base64url");
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });

  sessions.set(loginId, {
    uuid,
    verifier,
    pollMethod: "post",
    createdAt: Date.now(),
  });

  return {
    loginId,
    loginUrl: `${loginUrl}?${params.toString()}`,
  };
}

function isRouteNotFound(body) {
  if (!body.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.message === "string"
      && /^Route \w+:/.test(parsed.message)
      && parsed.message.includes("not found");
  } catch {
    return false;
  }
}

async function pollOnce(session, fetchImpl) {
  const { pollUrl } = cursorOAuth();
  const useGet = session.pollMethod === "get";
  const response = useGet
    ? await fetchImpl(
      `${pollUrl}?uuid=${encodeURIComponent(session.uuid)}&verifier=${encodeURIComponent(session.verifier)}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      }
    )
    : await fetchImpl(pollUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ uuid: session.uuid, verifier: session.verifier }),
      signal: AbortSignal.timeout(15000),
    });

  if (response.status === 404) {
    const body = (await response.text()).trim();
    // Pending logins are a bare 404 "Not found". Any other POST 404 means this
    // API build has no POST /auth/poll, so the next attempt uses GET.
    if (!useGet && body !== "Not found") {
      session.pollMethod = "get";
      return { pending: true, retryImmediately: true };
    }
    if (useGet && isRouteNotFound(body)) {
      return { error: "Cursor login endpoint is unavailable", fatal: true };
    }
    return { pending: true };
  }

  if (!response.ok) {
    if (TERMINAL_POLL_STATUSES.has(response.status)) {
      return {
        error: `Cursor login was rejected (HTTP ${response.status}). Start again.`,
        fatal: true,
      };
    }
    return { error: `Cursor login poll failed (HTTP ${response.status})`, fatal: false };
  }

  const data = await response.json().catch(() => null);
  if (typeof data?.accessToken !== "string" || typeof data?.refreshToken !== "string" || !data.accessToken || !data.refreshToken) {
    return { error: "Cursor login response did not include tokens", fatal: true };
  }
  return {
    tokens: {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    },
  };
}

/**
 * One poll tick for a login started by createCursorLoginSession.
 * @returns {{ pending?: boolean, tokens?: { accessToken: string, refreshToken: string }, error?: string, fatal?: boolean }}
 */
export async function pollCursorLoginSession(loginId, fetchImpl = fetch) {
  pruneSessions();
  if (typeof loginId !== "string" || loginId.length < 8 || loginId.length > 128) {
    return { error: "Cursor login expired. Start again.", fatal: true };
  }
  const session = sessions.get(loginId);
  if (!session) return { error: "Cursor login expired. Start again.", fatal: true };

  let result;
  try {
    result = await pollOnce(session, fetchImpl);
    if (result.retryImmediately) result = await pollOnce(session, fetchImpl);
  } catch {
    return { error: "Cursor login poll failed", fatal: false };
  }

  if (result.tokens || result.fatal) sessions.delete(loginId);
  return result;
}

export function decodeCursorJwt(token) {
  if (typeof token !== "string" || !token) return null;
  const jwt = token.includes("::") ? token.split("::").pop() : token;
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function cursorIdentity(accessToken, refreshToken) {
  const payload = decodeCursorJwt(accessToken) || decodeCursorJwt(refreshToken);
  const email = typeof payload?.email === "string" && payload.email.includes("@")
    ? payload.email
    : null;
  const userId = typeof payload?.sub === "string" && payload.sub ? payload.sub : null;
  return { email, userId };
}

export function cursorTokenExpiry(accessToken, nowMs = Date.now()) {
  const payload = decodeCursorJwt(accessToken);
  if (typeof payload?.exp === "number" && Number.isFinite(payload.exp)) {
    const expiresAtMs = payload.exp * 1000;
    return {
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresIn: Math.max(1, Math.floor((expiresAtMs - nowMs) / 1000)),
    };
  }
  const expiresIn = 3600;
  return {
    expiresAt: new Date(nowMs + expiresIn * 1000).toISOString(),
    expiresIn,
  };
}

function machineIdOf(connection) {
  const id = connection?.providerSpecificData?.machineId;
  return typeof id === "string" && id ? id : null;
}

/**
 * Keep a connection's machine ID when it is not shared.
 * A shared IDE machine ID is what makes Cursor return an empty turn for the
 * second account, so a login that would reuse one gets a new id instead.
 */
export function resolveCursorMachineId(connections, existing) {
  const current = machineIdOf(existing);
  const shared = current && connections.some((connection) => {
    if (connection === existing) return false;
    if (existing?.id && connection?.id === existing.id) return false;
    return machineIdOf(connection) === current;
  });
  if (current && !shared) return current;

  const used = new Set(connections.map(machineIdOf).filter(Boolean));
  let id = crypto.randomUUID();
  while (used.has(id)) id = crypto.randomUUID();
  return id;
}

/**
 * Save a Cursor browser login. A shared IDE machine ID is replaced so the
 * new account is not tied to a machine ID another connection already uses.
 */
export async function persistCursorLoginTokens({ accessToken, refreshToken }) {
  const { createProviderConnection, getProviderConnections, updateProviderConnection } = await import("@/models");
  const { email, userId } = cursorIdentity(accessToken, refreshToken);
  const { expiresAt, expiresIn } = cursorTokenExpiry(accessToken);
  const connections = await getProviderConnections({ provider: "cursor" });
  const byEmail = email
    ? connections.find((connection) => connection.authType === "oauth" && connection.email === email)
    : null;
  const byUser = !byEmail && userId
    ? connections.find((connection) => connection.providerSpecificData?.userId === userId)
    : null;
  const existing = byEmail || byUser;
  const machineId = resolveCursorMachineId(connections, existing);
  const payload = {
    provider: "cursor",
    authType: "oauth",
    accessToken,
    refreshToken,
    expiresAt,
    expiresIn,
    email: email || existing?.email || null,
    providerSpecificData: {
      ...(existing?.providerSpecificData || {}),
      machineId,
      authMethod: "login",
      ...(userId ? { userId } : {}),
    },
    testStatus: "active",
  };
  const connection = byUser
    ? await updateProviderConnection(byUser.id, payload)
    : await createProviderConnection(payload);
  return {
    id: connection?.id,
    provider: "cursor",
    email: connection?.email || email || null,
  };
}

/**
 * Another connection already owns this machine ID under a different account.
 * Re-importing the same account (same email, user id, or token) is allowed.
 */
export function machineIdConflict(connections, machineId, identity = {}) {
  if (!machineId) return null;
  for (const connection of connections) {
    if (machineIdOf(connection) !== machineId) continue;
    const sameEmail = identity.email && connection.email && connection.email === identity.email;
    const sameUser = identity.userId && connection.providerSpecificData?.userId === identity.userId;
    const sameToken = identity.accessToken && connection.accessToken === identity.accessToken;
    if (sameEmail || sameUser || sameToken) continue;
    if (connection.email || connection.providerSpecificData?.userId || connection.accessToken) {
      return connection;
    }
  }
  return null;
}
