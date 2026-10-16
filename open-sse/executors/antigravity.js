import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getActiveAntigravityHosts } from "../providers/shared.js";
import { OAUTH_ENDPOINTS, ANTIGRAVITY_HEADERS, AG_DEFAULT_TOOLS, AG_TOOL_SUFFIX, ANTIGRAVITY_PROMPT_REWRITES } from "../config/appConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { resolveSessionId, toNumericSessionId } from "../utils/sessionManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { cleanJSONSchemaForAntigravity, normalizeGeminiContents } from "../translator/formats/gemini.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../config/defaultThinkingSignature.js";
import { GEMINI_ROLE } from "../translator/schema/roles.js";
import { getGeminiThoughtSignatureSync } from "../services/thoughtSignatureStore.js";
import { extractGoogleQuotaReset } from "../utils/googleQuota.js";

// Sanitize function name: Gemini requires [a-zA-Z_][a-zA-Z0-9_.:\-]{0,63}
function sanitizeFunctionName(name) {
  if (!name) return "_unknown";
  let s = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.substring(0, 64);
}

const MAX_RETRY_AFTER_MS = 10000;
const ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS = 15000;
const MAX_ANTIGRAVITY_OUTPUT_TOKENS = 64000;
const ANTIGRAVITY_IDE_REQUEST_ID_RE = /^agent\/[^/]+\/\d+\/[^/]+\/\d+$/;

const ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS = [
  /high\s+traffic/i,
  /agent\s+(execution\s+)?terminated\s+due\s+to\s+error/i,
  /capacity/i,
  /temporarily\s+unavailable/i,
  /timeout/i,
  /stream\s+(ended|closed|terminated|interrupted)/i,
  /empty\s+response/i,
];

const ANTIGRAVITY_TRANSIENT_STATUSES = new Set([
  HTTP_STATUS.SERVER_ERROR,
  HTTP_STATUS.BAD_GATEWAY,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  HTTP_STATUS.GATEWAY_TIMEOUT,
]);

// Fields Google generateContent rejects (Claude/OpenAI/Qwen thinking fields set at body root by thinkingUnified.js)
const ANTIGRAVITY_REQUEST_BLACKLIST = [
  "output_config",
  "thinking",
  "reasoning_effort",
  "reasoning",
  "enable_thinking",
  "thinking_budget",
  "thinkingConfig",
];

// Strip blacklisted fields from an object (used for both body.request and top-level body)
const stripBlacklisted = obj => {
  for (const key of ANTIGRAVITY_REQUEST_BLACKLIST) delete obj[key];
};

// Image generation model name patterns
const IMAGE_MODEL_PATTERNS = [
  /image/i,
  /imagen/i,
  /image-generation/i,
];

// Detect if a model is an image generation model
function isImageModel(model) {
  if (!model) return false;
  return IMAGE_MODEL_PATTERNS.some(p => p.test(model));
}

// Parse aspect ratio / resolution from model name suffixes
// e.g. "gemini-3.1-flash-image-16x9" -> { aspectRatio: "16:9" }
// e.g. "gemini-3.1-flash-image-1024x768" -> { aspectRatio: "4:3" }
function parseImageConfig(model) {
  const config = { aspectRatio: "1:1" };
  const resMatch = model.match(/(\d+)x(\d+)$/);
  if (resMatch) {
    const w = parseInt(resMatch[1]);
    const h = parseInt(resMatch[2]);
    if (w <= 16 && h <= 16) {
      config.aspectRatio = `${w}:${h}`;
    } else {
      // Resolution like 1024x768 — derive aspect ratio
      const gcd = (a, b) => b ? gcd(b, a % b) : a;
      const d = gcd(w, h);
      config.aspectRatio = `${w/d}:${h/d}`;
    }
  }
  return config;
}

function uuidFromSeed(seed) {
  const bytes = crypto.createHash("sha256").update(String(seed || "antigravity")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildIdeRequestId({ body, request, credentials, model, requestType }) {
  if (ANTIGRAVITY_IDE_REQUEST_ID_RE.test(body?.requestId || "")) {
    return body.requestId;
  }

  const sessionId = request?.sessionId || body?.request?.sessionId || credentials?._clientSessionId || credentials?.connectionId || credentials?.email || "anonymous";
  const conversationId = uuidFromSeed(`antigravity:conversation:${sessionId}`);
  const trajectoryId = uuidFromSeed(`antigravity:trajectory:${sessionId}:${model}:${requestType}`);
  const contentCount = Array.isArray(request?.contents) ? request.contents.length : 1;
  const step = Math.max(1, contentCount * 2 - 1);
  return `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`;
}

export class AntigravityExecutor extends BaseExecutor {
  constructor() {
    super("antigravity", PROVIDERS.antigravity);
    // Optimization #10 (revised): headers timeout for large agent payloads.
    // Measured real TTFB on 1.2 MB / 117-tool / thinking-high requests:
    // 18-23 s (Google must ingest the prompt before it emits SSE headers).
    // The old 15 s cap aborted every big Claude Code turn, and because
    // 502 retries 4× with 3 s backoff that produced a ~69 s stall
    // (15×4 + 3×3) before falling through to the next account.
    // Dead accounts do NOT need this budget: they answer 401 in <1 s, so the
    // 401 circuit breaker still rotates them instantly. Only slow-but-alive
    // upstreams consume the window. Override: ANTIGRAVITY_CONNECT_TIMEOUT_MS.
    const envTimeout = parseInt(process.env.ANTIGRAVITY_CONNECT_TIMEOUT_MS || "", 10);
    this.config.timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120000;
    // NOTE: there is deliberately NO `this.projectId` cache. This executor is a
    // singleton shared by every account, so a cached project leaks across
    // accounts and earns 403 #3501 on the sandbox hosts (see transformRequest).
    // The project is resolved per request from credentials.projectId.
    // Optimization #5: Schema cache to avoid re-processing tools on every request
    this.schemaCache = new Map();

    // Warmup connections at startup
    if (typeof window === 'undefined' && global.process?.version) {
      setTimeout(async () => {
        try {
          const httpsModule = await import("https");
          const agent = new httpsModule.Agent({ keepAlive: true });

          const controller = new AbortController();
          setTimeout(() => controller.abort(), 2000);

          await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent?alt=sse", {
            method: "POST",
            signal: controller.signal,
            agent,
            body: JSON.stringify({ test: true })
          }).catch(() => {});

          console.log("[Antigravity] Connection pool warmed up successfully");
        } catch (e) {
          // Ignore warmup failures - not critical
        }
      }, 2000);
    }
  }

  // Parse Antigravity quota error to extract precise resetsAtMs from ErrorInfo/RetryInfo
  parseError(response, bodyText) {
    if ((response.status === 429 || response.status === 409) && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        let resetsAtMs = null;
        const details = Array.isArray(err?.details) ? err.details : [];
        for (const d of details) {
          if (d?.metadata?.quotaResetTimeStamp) {
            const ms = new Date(d.metadata.quotaResetTimeStamp).getTime();
            if (!isNaN(ms) && ms > Date.now()) {
              resetsAtMs = ms;
              break;
            }
          }
          if (typeof d?.retryDelay === "string") {
            const sec = parseFloat(d.retryDelay);
            if (!isNaN(sec) && sec > 0) {
              const ms = Date.now() + Math.round(sec * 1000);
              if (ms > Date.now()) {
                resetsAtMs = ms;
                break;
              }
            }
          }
        }
        if (resetsAtMs) {
          return { status: response.status, message: err?.message || bodyText, resetsAtMs };
        }
      } catch { /* fall through to default */ }
    }
    return super.parseError(response, bodyText);
  }

  buildUrl(model, stream, urlIndex = 0) {
    const baseUrls = this.getBaseUrls();
    const baseUrl = baseUrls[urlIndex] || baseUrls[0];
    // Image generation MUST use non-streaming generateContent
    const forceNonStream = isImageModel(model);
    const action = (stream && !forceNonStream) ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${baseUrl}/v1internal:${action}`;
  }

  /**
   * Rotasi host saat pool kapasitas host ini habis.
   *
   * BaseExecutor.shouldRetry hanya memutar URL pada 429, padahal Antigravity
   * menjawab 503 {"error":{"message":"No capacity available for model …"}}
   * ketika pool kapasitas MODEL di host tersebut kelelahan — bukan quota akun.
   * Google menjalankan pool terpisah per host, jadi host berikutnya di
   * ANTIGRAVITY_IDE_BASE_URLS sering masih penuh.
   *
   * Terukur live 2026-09-13 (40 akun, claude-opus-4-6-thinking):
   *   daily → 5% sukses    autopush-sandbox → 100%    staging-sandbox → 100%
   *
   * Baseline 429 tetap dipertahankan supaya perilaku lama tidak berubah.
   * Hanya status transien di ANTIGRAVITY_TRANSIENT_STATUSES (500/502/503/504)
   * yang ikut memicu rotasi host.
   *
   * 403 juga TIDAK memicu rotasi di sini — dan itu disengaja untuk 403 auth
   * biasa (token mati: mencoba host lain hanya membuang waktu, chatCore akan
   * me-refresh token). Tapi 403 entitlement (#3501) berbeda: host sandbox
   * MENOLAK berdasarkan kepemilikan project, jadi host lain bisa saja menerima
   * request yang sama. Itu ditangani terpisah di chatCore lewat
   * shouldRotateHostOnEntitlement(), bukan di sini, supaya tidak mengubah
   * perilaku 403 auth yang sudah benar.
   */
  shouldRetry(status, urlIndex) {
    if (super.shouldRetry(status, urlIndex)) return true;
    if (urlIndex + 1 >= this.getFallbackCount()) return false;
    return ANTIGRAVITY_TRANSIENT_STATUSES.has(status);
  }

  /**
   * Rotasi host saat entitlement 403 (#3501) — dipakai chatCore, bukan loop
   * retry internal executor.
   *
   * Alasannya: pada 403 entitlement, AKUN sehat dan token valid; yang menolak
   * adalah HOST sandbox (gate kepemilikan project). Menggilir 60 akun di host
   * yang sama hanya mengulang penolakan yang sama (~13-15s masing-masing),
   * sementara `daily` menerima request yang sama tanpa masalah. Jadi satu
   * percobaan ulang ke host berikutnya jauh lebih murah daripada satu akun
   * berikutnya.
   */
  getHostForEntitlementRetry(currentUrl) {
    const urls = this.getBaseUrls();
    // currentUrl is the FULL url the executor built
    // (https://host/v1internal:streamGenerateContent?alt=sse), so a plain
    // indexOf against the bare base list never matches and this silently
    // returned urls[0] — which is why every retry went to daily instead of the
    // next host. Match on the ORIGIN instead.
    let idx = -1;
    try {
      const origin = new URL(currentUrl).origin;
      idx = urls.findIndex((u) => {
        try { return new URL(u).origin === origin; } catch { return false; }
      });
    } catch { /* not a URL — fall through */ }
    if (idx === -1) return urls[0] || null;
    return idx + 1 < urls.length ? urls[idx + 1] : null;
  }

  // sessionId comes from transformRequest output; base.execute runs transformRequest before
  // buildHeaders, so we read it from instance state cached there (fallback: explicit arg).
  buildHeaders(credentials, stream = true, sessionId = null) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.accessToken}`,
      "User-Agent": this.config.headers?.["User-Agent"] || ANTIGRAVITY_HEADERS["User-Agent"],
    };
  }

  /**
   * Host list comes from the dashboard-selected preset, not the static
   * registry value. Default is `daily-only` — see ANTIGRAVITY_HOST_PRESETS.
   * Reading it per call (rather than at construction) means changing the
   * dropdown takes effect without a restart.
   */
  getBaseUrls() {
    try {
      const active = getActiveAntigravityHosts();
      if (Array.isArray(active) && active.length) return active;
    } catch { /* fall through to the static list */ }
    return super.getBaseUrls();
  }

  transformRequest(model, body, stream, credentials) {
    // The project MUST come from the account serving THIS request.
    //
    // This used to cache the first project it ever saw on `this.projectId` and
    // reuse it forever. Because the executor is a module-level singleton
    // (executors/index.js), that cache is shared by every account: once one
    // account's project was stored, every later request sent THAT project, no
    // matter which account it belonged to.
    //
    // That is fatal on the sandbox hosts. Google gates the sandbox on project
    // ownership: a request whose `project` is not the one loadCodeAssist returns
    // for that account is refused with 403 SUBSCRIPTION_REQUIRED (#3501, "You do
    // not have a valid license of this product"). Measured live 2026-09-20 —
    // own project 21/21 -> 200, foreign project 28/28 -> 403 on autopush and
    // staging; daily accepts either. Since daily is tried first and rotates on
    // capacity errors, the foreign project only surfaced after a rotation, which
    // is why it looked like a host or account fault.
    //
    // Per-request resolution costs nothing: credentials.projectId is already
    // resolved upstream (projectId.js caches it per connection).
    //
    // The random generateProjectId() fallback was itself a 403 source and is
    // gone. Measured on autopush: a generated id ("bright-wave-ngqrb") and an
    // empty string BOTH returned 403 #3501, while the account's real project
    // returned 200. A fabricated project is not valid for ANY account, so
    // sending one can only ever earn a refusal — it never turns a failing
    // request into a working one. Omitting the field fails the same way but
    // says so honestly instead of inventing an identity.
    //
    // A credential with no project is therefore a broken credential, not a
    // request to patch up here. Callers resolve the project before dispatch
    // (chat.js -> getProjectIdForConnection); when that fails the request is
    // allowed to fail rather than sent under a fabricated identity.
    const projectId = credentials?.projectId || "";

    // OpenAI clients may include stream_options even for non-streaming calls.
    // Google generateContent rejects that combination before processing the request.
    if (stream !== true) delete body.stream_options;

    // ─── Image generation: completely different request structure ───
    if (isImageModel(model)) {
      const imageConfig = parseImageConfig(model);
      // Strip model name suffixes for the actual API model name
      const cleanModel = model.replace(/-(\d+)x(\d+)$/, "");

      // Build simplified contents — text-only, merge all user messages
      const contents = [];
      const srcContents = body.request?.contents || body.contents || [];
      for (const c of srcContents) {
        const textParts = (c.parts || []).filter(p => p.text !== undefined).map(p => ({ text: p.text }));
        if (textParts.length > 0) {
          contents.push({ role: c.role || "user", parts: textParts });
        }
      }

      const sessionId = resolveSessionId({
        headers: credentials?.rawHeaders,
        body,
        connectionId: credentials?.email || credentials?.connectionId,
        scope: "antigravity",
      });

      this._lastSessionId = sessionId;
      const request = {
        contents,
        generationConfig: {
          temperature: 1.0,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
          imageConfig,
        },
        sessionId,
        // No tools, no systemInstruction, no safetySettings for image gen
      };

      return {
        project: projectId,
        model: cleanModel,
        userAgent: "antigravity",
        requestType: "image_gen",
        requestId: buildIdeRequestId({ body, request, credentials, model: cleanModel, requestType: "image_gen" }),
        request,
      };
    }

    const rawSessionId = body.request?.sessionId || resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId: credentials?.email || credentials?.connectionId, scope: "antigravity" });
    const sessionId = toNumericSessionId(rawSessionId) || rawSessionId;

    // ─── Standard (non-image) request ───
    // Fix contents for Claude models via Antigravity
    const rawContents = (body.request?.contents || []).map(c => {
      let role = c.role;

      // Fast-path optimization (Fix #4): Skip if already clean
      if (!c.parts || c.parts.length === 0) return c;

      // Check if ANY modification needed before processing
      const needsModification = c.parts.some(p => {
        if (p.thought && !p.functionCall) return true;
        if (p.thoughtSignature && !p.functionCall && !p.text) return true;
        return false;
      });

      if (!needsModification) return c; // ← EARLY RETURN if already clean

      // Only process if modifications are actually needed
      const parts = c.parts?.filter(p => {
        if (p.thought && !p.functionCall) return false;
        if (p.thoughtSignature && !p.functionCall && !p.text) return false;
        return true;
      });

      // functionResponse must be role "user" for Claude models
      if (c.parts?.some(p => p.functionResponse)) {
        role = "user";
      }

      // Gemini 3+ rejects functionCall parts without thoughtSignature. Clients (Claude Code, IDE)
      // don't persist thoughtSignature in their history, so backfill from cache or default signature.
      // In parallel function calls, only the first call needs a signature; siblings stay unsigned.
      let firstFunctionCallSeen = false;
      const modifiedParts = parts?.map(p => {
        if (!p.functionCall) return p;
        const callId = p.functionCall.id;
        const cachedSig = callId ? getGeminiThoughtSignatureSync(callId, sessionId, body.model || model) : null;
        const callSig = p.thoughtSignature || cachedSig || (!firstFunctionCallSeen ? DEFAULT_THINKING_AG_SIGNATURE : undefined);
        firstFunctionCallSeen = true;
        if (callSig) {
          return { ...p, thoughtSignature: callSig };
        }
        if (p.thoughtSignature && !cachedSig) {
          // Unsigned sibling call
          const { thoughtSignature: _, ...rest } = p;
          return rest;
        }
        return p;
      });

      // Fork: hindari object churn — hanya bikin objek baru kalau ada yang berubah.
      const partsChanged = parts?.length !== c.parts?.length || modifiedParts?.some((p, idx) => p !== c.parts[idx]);
      if (role !== c.role || partsChanged) {
        return {
          ...c, role,
          parts: modifiedParts || parts || [],
        };
      }
      return c;
    });
    const contents = normalizeGeminiContents(rawContents, model);

    // Sanitize tool schemas and function names before sending to Antigravity.
    let tools = body.request?.tools;

    if (tools && tools.length > 0) {
      // Merge all groups into a single functionDeclarations group (Gemini expects 1 group)
      const seenToolNames = new Set();
      const allDeclarations = [];
      for (const group of tools) {
        for (const fn of group.functionDeclarations || []) {
          const name = sanitizeFunctionName(fn.name);

          // Check schema cache first (Optimization #5 - Schema Cache Optimization)
          if (this.schemaCache.has(name)) {
            if (!seenToolNames.has(name)) {
              allDeclarations.push(this.schemaCache.get(name));
              seenToolNames.add(name);
            }
            continue;
          }

          if (seenToolNames.has(name)) continue;
          seenToolNames.add(name);

          const cleanedParams = fn.parameters
            ? cleanJSONSchemaForAntigravity(structuredClone(fn.parameters))
            : { type: "object", properties: { reason: { type: "string", description: "Brief explanation" } }, required: ["reason"] };

          const declaration = {
            ...fn,
            name,
            parameters: cleanedParams
          };

          // Cache the cleaned schema for next use
          this.schemaCache.set(name, declaration);

          allDeclarations.push(declaration);
        }
      }
      tools = allDeclarations.length > 0 ? [{ functionDeclarations: allDeclarations }] : [];
    }

    // Strip tools/toolConfig (handled separately) and blacklisted fields that Google rejects
    const { tools: _originalTools, toolConfig: _originalToolConfig, ...requestWithoutTools } = body.request || {};
    stripBlacklisted(requestWithoutTools);
    
    // Rewrite competing-client branding in system prompts (e.g. Zed's Claude prompt,
    // OpenCode naming) so Antigravity doesn't flag the request with a 429 Quota Exhausted.
    if (requestWithoutTools.systemInstruction?.parts) {
      for (const part of requestWithoutTools.systemInstruction.parts) {
        if (typeof part.text !== "string") continue;
        for (const { from, to } of ANTIGRAVITY_PROMPT_REWRITES) {
          part.text = part.text.replaceAll(from, to);
        }
      }
    }

    const generationConfig = { ...(requestWithoutTools.generationConfig || {}) };
    if (generationConfig.maxOutputTokens > MAX_ANTIGRAVITY_OUTPUT_TOKENS) {
      generationConfig.maxOutputTokens = MAX_ANTIGRAVITY_OUTPUT_TOKENS;
    }

    // Google rejects a request whose last content is a model turn:
    // "Requests ending with a model turn are not supported." A client ends on an
    // assistant message whenever its previous response was interrupted (Esc /
    // stop), so append a user nudge and let the model continue instead of
    // failing. Verified live: identical payloads differ only in this tail —
    // model-last → 400, user-last → 200.
    if (contents?.at(-1)?.role === GEMINI_ROLE.MODEL) {
      contents.push({ role: GEMINI_ROLE.USER, parts: [{ text: "Continue." }] });
    }

    const transformedRequest = {
      ...requestWithoutTools,
      generationConfig,
      ...(contents && { contents }),
      ...(tools && { tools }),
      sessionId,
      safetySettings: undefined,
      ...(tools?.length > 0 && { toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } })
    };

    // Strip blacklisted thinking fields from top-level body (set by thinkingUnified.js at root, not body.request)
    stripBlacklisted(body);

    this._lastSessionId = transformedRequest.sessionId; // cached for buildHeaders (base.execute order)

    // Klien Antigravity resmi TIDAK mengirim `requestType` sama sekali di jalur
    // agent (chat). Mengirim `requestType: "agent"` — atau membiarkannya bocor
    // lewat spread `...body` dari envelope — membuat Google memasukkan request
    // ke bucket terpisah dan membalas 429 RESOURCE_EXHAUSTED TANPA details[],
    // meski kuota tersedia. Inilah 429 generik yang selama ini sulit dilacak:
    // tidak ada RetryInfo/quotaResetDelay karena penolakannya di tingkat
    // routing, bukan kuota.
    //
    // Bucket `image_gen` dan `search` tidak terpengaruh dan tetap memakai
    // requestType-nya sendiri.
    //
    // Sumber: upstream decolua/9router 5798b308.
    delete body.requestType;

    return {
      ...body,
      project: projectId,
      model: body.model || model,
      userAgent: "antigravity",
      requestId: buildIdeRequestId({ body, request: transformedRequest, credentials, model, requestType: "agent" }),
      request: transformedRequest
    };
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret
        })
      }, proxyOptions);

      if (!response.ok) return null;

      const tokens = await response.json();
      log?.info?.("TOKEN", "Antigravity refreshed");

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresIn: tokens.expires_in,
        projectId: credentials.projectId
      };
    } catch (error) {
      log?.error?.("TOKEN", `Antigravity refresh error: ${error.message}`);
      return null;
    }
  }

  // NOTE: generateProjectId() was removed on purpose. It fabricated ids like
  // "bright-wave-ngqrb" which are not valid for any account and returned 403
  // #3501 on the sandbox hosts — it could only ever turn a failing request into
  // a differently-failing one. The project now comes from the credential, or
  // the request is refused upstream with a clear error.

  generateSessionId() {
    return crypto.randomUUID() + Date.now().toString();
  }

  parseRetryHeaders(headers) {
    if (!headers?.get) return null;

    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000;

      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const diff = date.getTime() - Date.now();
        return diff > 0 ? diff : null;
      }
    }

    const resetAfter = headers.get('x-ratelimit-reset-after');
    if (resetAfter) {
      const seconds = parseInt(resetAfter, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
    }

    const resetTimestamp = headers.get('x-ratelimit-reset');
    if (resetTimestamp) {
      const ts = parseInt(resetTimestamp, 10) * 1000;
      const diff = ts - Date.now();
      return diff > 0 ? diff : null;
    }

    return null;
  }

  // Parse retry time from Antigravity error message body
  // Format: "Your quota will reset after 2h7m23s" or "1h30m" or "45m" or "30s"
  parseRetryFromErrorMessage(errorMessage) {
    if (!errorMessage || typeof errorMessage !== "string") return null;

    // Antigravity membalas DUA bentuk pesan yang berbeda:
    //   kuota mingguan : "Resets in 149h50m20s"
    //   rate limit     : "Resets in 0s."      ← perhatikan "Resets" (ada 's')
    //
    // Pola lama hanya cocok dengan "reset after ...", sehingga bentuk
    // "Resets in 0s." TIDAK pernah terbaca. Akibatnya 429 burst jatuh ke
    // backoff eksponensial 2 detik padahal upstream sudah memberi tahu reset
    // dalam milidetik (RetryInfo.retryDelay). Terukur 2026-09-20: burst 12
    // request pada satu akun menghasilkan 9x 429 dengan
    // "quotaResetDelay": "162.322081ms" — akun sehat, hanya perlu ~0,2 detik.
    const match = errorMessage.match(/resets?\s+(?:in|after)\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i);
    if (!match) return null;

    const parts = match[1].match(/(\d+)h|(\d+)m|(\d+(?:\.\d+)?)s/gi) || [];
    let totalMs = 0;
    for (const part of parts) {
      if (/h$/i.test(part)) totalMs += parseInt(part) * 3600 * 1000;
      else if (/m$/i.test(part)) totalMs += parseInt(part) * 60 * 1000;
      else if (/s$/i.test(part)) totalMs += parseFloat(part) * 1000;
    }

    return totalMs > 0 ? totalMs : null;
  }

  extractErrorMessage(errorJson, bodyText = "") {
    return [
      errorJson?.error?.message,
      errorJson?.message,
      errorJson?.error,
      bodyText,
    ].filter(Boolean).map(v => typeof v === "string" ? v : JSON.stringify(v)).join("\n");
  }

  /**
   * Delay retry PERSIS dari error.details[] Cloud Code.
   *
   * Pesan manusia membulatkan ke detik — "Resets in 0s." untuk limit yang
   * sebenarnya pulih dalam 162ms. Field terstruktur menyimpan angka aslinya:
   *
   *   RetryInfo.retryDelay        : "0.162322081s"
   *   ErrorInfo.metadata.quotaResetDelay : "162.322081ms"
   *
   * Terukur 2026-09-20 (burst 12x, satu akun, model claude-opus-4-6-thinking):
   * 9x 429 dengan delay ~162ms. Tanpa pembacaan ini, 429 jatuh ke backoff
   * eksponensial 2 detik — 12x lebih lama dari yang dibutuhkan upstream.
   */
  parseRetryFromDetails(errorJson) {
    const details = errorJson?.error?.details;
    if (!Array.isArray(details)) return null;

    const toMs = (raw) => {
      if (typeof raw !== "string") return null;
      const ms = raw.endsWith("ms")
        ? Number.parseFloat(raw)
        : raw.endsWith("s") ? Number.parseFloat(raw) * 1000 : NaN;
      return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : null;
    };

    // RetryInfo.retryDelay adalah field kanonik google.rpc untuk waktu retry —
    // diprioritaskan di atas metadata.quotaResetDelay apa pun urutannya.
    for (const d of details) {
      const ms = toMs(d?.retryDelay);
      if (ms !== null) return ms;
    }
    for (const d of details) {
      const ms = toMs(d?.metadata?.quotaResetDelay);
      if (ms !== null) return ms;
    }
    return null;
  }

  /**
   * Provider-specific error parsing, called by parseUpstreamError().
   *
   * A quota 429 from Cloud Code carries the exact reset moment in
   * error.details[] — `quotaResetTimeStamp`, `quotaResetDelay`, or
   * `RetryInfo.retryDelay`. Without this override `resetsAtMs` stayed null and
   * markAccountUnavailable() fell back to the generic exponential backoff
   * (2s → 30s), so an account whose quota returns in ~6 days was re-probed
   * every few seconds for days. Measured on one install: 233 antigravity 429s
   * over 22h at ~16s each ≈ 70 minutes of dead wall-clock.
   *
   * The reset is per model, so callers lock only that model — the account's
   * other pools (Claude models, other Gemini tiers) stay usable.
   */
  parseError(response, bodyText) {
    if (response?.status !== HTTP_STATUS.RATE_LIMITED || !bodyText) {
      return super.parseError(response, bodyText);
    }
    try {
      const json = JSON.parse(bodyText);
      const { resetsAtMs, model, reason } = extractGoogleQuotaReset(json);
      if (!resetsAtMs) return super.parseError(response, bodyText);

      const base = json?.error?.message || bodyText;
      const detail = [reason, model].filter(Boolean).join(" ");
      return {
        status: response.status,
        message: detail ? `${base} [${detail}]` : base,
        resetsAtMs,
      };
    } catch {
      return super.parseError(response, bodyText);
    }
  }

  isTransientAntigravityError(status, message) {
    if (status === HTTP_STATUS.RATE_LIMITED) return true;
    if (ANTIGRAVITY_TRANSIENT_STATUSES.has(status)) return true;
    return ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message || ""));
  }

  // Hook called by BaseExecutor.tryRetry: derive delay from Retry-After (header → body),
  // cap at MAX_RETRY_AFTER_MS, else retry transient Antigravity failures with backoff.
  // Return false to veto (fallback URL / final error).
  async computeRetryDelay(response, attempt) {
    let bodyText = "";
    let errorJson = null;
    let retryMs = this.parseRetryHeaders(response.headers);

    try {
      bodyText = await response.clone().text();
      errorJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // ignore parse errors → fall through to status/message based retry
    }

    const errorMessage = this.extractErrorMessage(errorJson, bodyText);

    // Field terstruktur lebih akurat daripada pesan manusia (yang membulatkan
    // ke detik dan menampilkan "Resets in 0s." untuk limit sub-detik).
    if (!retryMs) retryMs = this.parseRetryFromDetails(errorJson);
    if (!retryMs) retryMs = this.parseRetryFromErrorMessage(errorMessage);
    if (retryMs) return retryMs <= MAX_RETRY_AFTER_MS ? retryMs : false;

    // 429 TANPA info delay → JANGAN retry in-place; biarkan rotasi host/akun.
    //
    // Terukur 2026-09-20 pada payload besar (image + 123 tool, ~7 detik per
    // percobaan): 429 generik `"Resource has been exhausted (e.g. check
    // quota)."` — TANPA error.details[] — membuat computeRetryDelay jatuh ke
    // backoff buta. Dengan attempts:2 di tiga host itu menjadi 9 percobaan
    // = 48-64 detik sebelum menyerah, padahal sebelumnya ~12 detik.
    //
    // Prinsipnya: retry in-place hanya bila upstream menyebut KAPAN harus
    // retry (RetryInfo.retryDelay / quotaResetDelay / Retry-After). Tanpa itu,
    // menunggu 2s+4s di host yang sama hanya menunda rotasi yang lebih murah.
    if (response.status === HTTP_STATUS.RATE_LIMITED) return false;

    if (!this.isTransientAntigravityError(response.status, errorMessage)) return false;

    const cap = response.status === HTTP_STATUS.RATE_LIMITED
      ? MAX_RETRY_AFTER_MS
      : ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS;
    return Math.min(1000 * (2 ** attempt), cap); // exponential backoff
  }

  /**
   * Cloak tools before sending to Antigravity provider (anti-ban):
   * - Rename client tools with _ide suffix
   * - Inject AG default decoy tools after client tools
   * Returns { cloakedBody, toolNameMap } where toolNameMap maps suffixed → original
   */
  static cloakTools(body, clientTool = null) {
    const tools = body.request?.tools;
    if (!tools || tools.length === 0) {
      return { cloakedBody: body, toolNameMap: null };
    }

    const isCopilot = clientTool === "github-copilot";
    const toolNameMap = new Map();
    const clientDeclarations = [];
    const decoyNames = new Set(AG_DECOY_TOOLS.map(tool => tool.name));

    // First: collect renamed client tools
    for (const toolGroup of tools) {
      if (!toolGroup.functionDeclarations) continue;

      for (const func of toolGroup.functionDeclarations) {
        // For GitHub Copilot, avoid emitting duplicate native Antigravity tool names.
        // Keep the decoys only once in the final declaration list.
        if (isCopilot && AG_DEFAULT_TOOLS.has(func.name)) {
          continue;
        }

        // Skip if already covered by decoys for Copilot
        if (isCopilot && decoyNames.has(func.name)) {
          continue;
        }

        // Preserve native AG names for non-Copilot clients
        if (AG_DEFAULT_TOOLS.has(func.name)) {
          clientDeclarations.push(func);
          continue;
        }

        const suffixed = `${func.name}${AG_TOOL_SUFFIX}`;
        toolNameMap.set(suffixed, func.name);
        clientDeclarations.push({ ...func, name: suffixed });
      }
    }

    // Client tools first, then AG decoy tools
    const allDeclarations = [];
    const seenNames = new Set();
    for (const decl of [...clientDeclarations, ...AG_DECOY_TOOLS]) {
      if (!decl?.name || seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      allDeclarations.push(decl);
    }

    // Rename tool names in conversation history (contents)
    const cloakedContents = body.request?.contents?.map(msg => {
      if (!msg.parts) return msg;
      
      const cloakedParts = msg.parts.map(part => {
        // Rename functionCall.name
        if (part.functionCall && !AG_DEFAULT_TOOLS.has(part.functionCall.name)) {
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              name: `${part.functionCall.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        // Rename functionResponse.name
        if (part.functionResponse && !AG_DEFAULT_TOOLS.has(part.functionResponse.name)) {
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              name: `${part.functionResponse.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        return part;
      });
      
      return { ...msg, parts: cloakedParts };
    });

    // Single functionDeclarations group: client tools first, then decoys
    return {
      cloakedBody: {
        ...body,
        request: {
          ...body.request,
          tools: [{ functionDeclarations: allDeclarations }],
          contents: cloakedContents || body.request.contents
        }
      },
      toolNameMap
    };
  }
}

// AG decoy tools — same names as AG native defaults, redirect to _ide suffixed tools
const AG_DECOY_TOOLS = [
  {
    name: "browser_subagent",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "command_status",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "find_by_name",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "generate_image",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "grep_search",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_dir",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_resources",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "mcp_sequential-thinking_sequentialthinking",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "multi_replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "notify_user",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_resource",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_terminal",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_url_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "run_command",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "search_web",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "send_command_input",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "task_boundary",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_content_chunk",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "write_to_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  }
];

export default AntigravityExecutor;
