import { OpenCodeExecutor, generateSessionId, generateRequestId, OPENCODE_SESSION_RE } from "./opencode.js";
import { buildOpencodeHeaders, injectOpencodeTools } from "../utils/opencodeTools.js";
import { PROVIDERS } from "../config/providers.js";

// OpenCode Local: same free-tier fingerprint as opencode, but pinned to the
// /inference lane (verified live: UA + x-opencode-session + tool quartet +
// stream:true returns 200 where /zen 403s on the same combo).
//
// Session strategy (verified live 2026-10-14):
// - Upstream runs a blocklist, not a freshness window: backdated sessions
//   (even 7d old) return 200, while one over-used session 403s permanently.
// - So: one stable session per downstream identity (mirrors the real CLI),
//   mint a new one ONLY when upstream 403s with FreeTierError (burnt).
// - Session ids are minted with the official algorithm: no local DB needed,
//   docker-safe and cross-server safe.
const INFERENCE_URL = "https://opencode.ai/inference/openai/v1/chat/completions";
const SESSION_FIELD = "_opencodeSession";
const REQ_FIELD = "_opencodeRequest";
const MAX_SESSION_ATTEMPTS = 3;

export class OpenCodeLocalExecutor extends OpenCodeExecutor {
  constructor() {
    super();
    this.provider = "opencode-local";
    if (PROVIDERS["opencode-local"]) this.config = PROVIDERS["opencode-local"];
  }

  buildUrl() {
    return INFERENCE_URL;
  }

  // User-supplied session wins (e.g. a known-good ses_eca12f...); otherwise
  // fall back to the parent's stable-session cache. Freshness is NOT forced
  // here — rotation happens in execute() only after a 403 burn.
  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const headers = sourceCredentials.rawHeaders || {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "x-opencode-session"
        && typeof value === "string" && OPENCODE_SESSION_RE.test(value.trim())) {
        return {
          ...sourceCredentials,
          [SESSION_FIELD]: value.trim(),
          [REQ_FIELD]: generateRequestId(),
          _opencodeSessionUserSupplied: true,
        };
      }
    }
    return super.prepareRequestCredentials({ body, credentials, providerSessionId, clientTool });
  }

  // Local executor owns the free-tier fingerprint: the parent's
  // /zen lane keeps its own (older) fingerprint intact.
  transformRequest(model, body, stream, credentials) {
    body = super.transformRequest(model, body, stream, credentials);
    injectOpencodeTools(body);
    return body;
  }

  buildHeaders(credentials, stream = true, url = "", model) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];
    const downstreamReq = typeof lower["x-opencode-request"] === "string"
      && /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(lower["x-opencode-request"].trim())
      ? lower["x-opencode-request"].trim() : null;
    const requestId = credentials?.[REQ_FIELD] || downstreamReq || generateRequestId();

    return buildOpencodeHeaders({
      ...credentials,
      _opencodeSession: session,
      _opencodeRequest: requestId,
    });
  }

  // Read the session back out of already-prepared credentials.
  _sessionOf(credentials) {
    return credentials?.[SESSION_FIELD] || null;
  }

  // Swap in a freshly minted session + request id. The new session is also
  // injected into rawHeaders: the parent's execute() re-runs
  // prepareRequestCredentials() on the passed credentials, and nativeSession()
  // (rawHeaders first) is the only path that bypasses its stable-session
  // cache — without this the rotation would be eaten by the cache.
  _rotateSession(credentials) {
    const fresh = generateSessionId();
    return {
      ...credentials,
      rawHeaders: { ...(credentials?.rawHeaders || {}), "x-opencode-session": fresh },
      [SESSION_FIELD]: fresh,
      [REQ_FIELD]: generateRequestId(),
      _opencodeSessionUserSupplied: false,
    };
  }

  async execute(args) {
    let credentials = this.prepareRequestCredentials(args);
    let lastResult = null;
    const attempts = credentials._opencodeSessionUserSupplied ? 1 : MAX_SESSION_ATTEMPTS;
    for (let i = 0; i < attempts; i++) {
      lastResult = await super.execute({ ...args, credentials });
      const { response } = lastResult;
      if (response?.status !== 403 || i === attempts - 1) return lastResult;
      // Peek the error body: only rotate on FreeTierError (burnt session).
      // Anything else (quota, auth) is returned as-is.
      let burn = false;
      try {
        const clone = response.clone?.();
        const text = clone ? await clone.text() : "";
        burn = text.includes("FreeTierError");
      } catch { burn = true; }
      if (!burn) return lastResult;
      credentials = this._rotateSession(credentials);
    }
    return lastResult;
  }
}
