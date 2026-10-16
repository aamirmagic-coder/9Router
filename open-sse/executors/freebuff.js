import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import {
  FETCH_CONNECT_TIMEOUT_MS,
  DEFAULT_RETRY_CONFIG,
  resolveRetryEntry,
} from "../config/runtimeConfig.js";
import { markPoolUnfit, clearPoolUnfit } from "../services/proxyPoolFitness.js";

/**
 * Freebuff Executor — OpenAI-compatible chat completions on
 * https://www.codebuff.com/api/v1/chat/completions (the Codebuff/Freebuff backend).
 *
 * Wire shape mirrors the official CLI exactly. The CLI (Vercel AI SDK with the
 * codebuff openai-compatible provider) builds `providerOptions.codebuff` =
 * { codebuff_metadata, provider } and the provider spreads those entries at
 * the TOP LEVEL of the request body — i.e. the body is:
 *   { model, messages, codebuff_metadata: { run_id, client_id, cost_mode,
 *     freebuff_instance_id? }, provider: { allow_fallbacks } }
 * NOT nested under a `codebuff` object (the backend rejects the nested shape
 * with 400 "No runId found in request body").
 *
 * The run_id is not a free-form uuid: the backend resolves it against its
 * agent-run store and rejects unknown ids with 400 "runId Not Found". So every
 * chat request first registers a run via POST /api/v1/agent-runs
 * ({ action:"START", agentId, ancestorRunIds:[] }) → { runId }, and that id is
 * what goes in codebuff_metadata.run_id. The free tier additionally gates on a
 * session: POST /api/v1/freebuff/session with an `x-freebuff-model` header
 * claims a row (bound to one model, ~1h); its instance id must ride along as
 * codebuff_metadata.freebuff_instance_id.
 */
const SESSION_PATH = "/api/v1/freebuff/session";
// Endpoint KLAIM yang dipakai CLI resmi — bukan SESSION_PATH. Binary 0.0.199
// mendefinisikannya sebagai konstanta terpisah (`HLA`) dan memakai POST ke sini
// untuk admit; POST ke /session langsung tidak pernah dilakukan CLI.
// Binary juga menangani 404/405 dari endpoint ini sebagai
// `session_admission_unsupported` dan menyuruh update CLI.
const SESSION_ADMISSION_PATH = "/api/v1/freebuff/session/admission";
const RUN_PATH = "/api/v1/agent-runs";
const ME_PATH = "/api/v1/me";
const SESSION_DEFAULT_TTL_MS = 60 * 60 * 1000; // active sessions live ~1h

/**
 * User-Agent per jenis panggilan — dipisah karena upstream membedakannya.
 *
 * `CHAT_UA` hanya untuk panggilan CHAT. CLI resmi memasang UA ini di
 * `model-provider.ts` saja; ini yang membuat request dikenali sebagai klien
 * openai-compatible resmi.
 *
 * `PLAIN_UA` untuk panggilan NON-CHAT (session, offers, agent-runs) — CLI
 * mengirim UA runtime biasa di sana, meniru fetch Bun bawaan. Sebelumnya
 * keempatnya memakai `codebuff-cli/0.0.138`, yaitu versi paket yang sudah
 * usang (paket `freebuff` di npm kini 0.0.197) dan BUKAN UA yang dipakai CLI
 * untuk panggilan API.
 */
const CHAT_UA = "ai-sdk/openai-compatible/1.0.0/codebuff";
const PLAIN_UA = "Bun/1.3.11";

/**
 * Header protokol sesi — nama-namanya diambil persis dari binary CLI 0.0.199
 * (konstanta `r$A`, `s$A`, `e$A`, `i2`, `$LA`, `LLA`, `ILA`, `ELA`, `TTA`,
 * `DLA`, `LQA`, `$QA`). Sebelumnya hanya `x-freebuff-model` yang dikirim.
 *
 * `x-freebuff-wallet-spend-limit: "0"` dan `x-freebuff-first-tab-discount: "0"`
 * adalah NILAI JUJUR yang CLI sendiri pasang di setiap panggilan sesi: akun ini
 * tidak membelanjakan wallet dan tidak mengklaim diskon tab pertama. Keduanya
 * dipasang tanpa syarat (bukan hanya saat false) — lihat fungsi `VB` di binary:
 *   L = { Authorization, ...AQA(), [TTA]: firstTabDiscount ? "1" : "0" }
 *   if (H === "POST") { ...; L[e$A] = String(walletSpendLimit ?? 0) }
 *
 * `x-fb-timezone` = zona waktu IANA dari mesin yang menjalankan gateway
 * (binary: `Intl.DateTimeFormat().resolvedOptions().timeZone`). Dipakai
 * server untuk menghitung jendela reset harian.
 */
const HEADER_MODEL = "x-freebuff-model";
const HEADER_INSTANCE = "x-freebuff-instance-id";
const HEADER_WALLET_SPEND_LIMIT = "x-freebuff-wallet-spend-limit";
const HEADER_FIRST_TAB_DISCOUNT = "x-freebuff-first-tab-discount";
const HEADER_TIMEZONE = "x-fb-timezone";
const HEADER_ACTING_USER_ID = "x-freebuff-acting-user-id";
const HEADER_API_KEY = "x-codebuff-api-key";
// Dipasang HANYA di GET status saat kita sudah memegang instance id — binary:
//   if (H === "GET" && $.instanceId) { L[ILA] = "1"; if (!$.compact) L[$LA] = "1" }
const HEADER_HEARTBEAT = "x-freebuff-heartbeat";
const HEADER_INCLUDE_UNUSED = "x-freebuff-include-unused-rate-limits";

// Zona waktu IANA mesin ini. `Intl` bisa melempar di runtime tanpa data
// timezone lengkap — CLI membungkusnya try/catch dan menghilangkan header
// kalau gagal, jadi kita ikuti (header kosong lebih buruk daripada tidak ada).
function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// Header sesi bersama: dipasang di SEMUA panggilan /freebuff/session
// (admission, status GET, release DELETE) persis seperti `sessionHeaders()`
// di binary. `extra` menimpa/menambah per pemanggilan.
function sessionHeaders(token, extra = {}) {
  const tz = localTimezone();
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": PLAIN_UA,
    [HEADER_WALLET_SPEND_LIMIT]: "0",
    [HEADER_FIRST_TAB_DISCOUNT]: "0",
    ...(tz ? { [HEADER_TIMEZONE]: tz } : {}),
    ...extra,
  };
}

// Chat statuses that mean our claimed session is stale and must be re-claimed
// before retrying (mirrors the CLI's FreebuffGateErrorKind statuses).
const SESSION_STALE_CODES = new Set([428, 409, 410]);

// Models the backend runs as a CAPACITY-LIMITED OFFER rather than a standing
// picker row. Claude Fable 5 is not in the client catalog at all: the server
// advertises it per-session-response (`limitedModelOffers`) only while its
// shared wave pool has sessions left, and a request without a live offer is
// refused. A claim must therefore peek at the current offers first instead of
// POSTing blind (mirrors the CLI: the "Claude Fable 5 · N of M left" row only
// renders from that payload). Offer state is per-account and cached briefly —
// the pool can reopen at any time, so a closed offer must NOT set a long
// cooldown.
// Id wire Fable: binary resmi memakai "anthropic/claude-fable-5.1" — agent
// `base2-free-fable` mendeklarasikan model itu, dan id TANPA ".1" tidak pernah
// muncul sebagai model yang dijalankan agent mana pun (hanya di daftar tipe TS).
const FABLE_MODEL = "anthropic/claude-fable-5.1";
const OFFER_GATED_MODELS = new Set([FABLE_MODEL]);
const OFFER_CACHE_TTL_MS = 45_000;

// The free tier rejects requests whose first system message doesn't open with
// the canonical Freebuff CLI root prompt (server gate
// requestHasFreebuffSystemMarker → 403 free_mode_cli_required). The check is a
// byte-exact prefix test on position 0, so we prepend the canonical opening.
// Same anti-abuse pattern as mimo-free's MIMO_SYSTEM_MARKER injection.
const FREEBUFF_SYSTEM_MARKER = "You are Buffy, the strategic coding assistant.";

// Canonical openings accepted by the server gate (mirrors the CLI's
// FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS). The check is a byte-exact prefix on
// the first message, so our injected marker must be one of these verbatim.
const FREEBUFF_ROOT_SYSTEM_OPENINGS = [
  "You are Buffy, the strategic coding assistant.",
  "You are Buffy, the Freebuff Cloud project planner.",
  "You are Buffy, a strategic assistant that orchestrates complex coding tasks through specialized sub-agents.",
];

// Ensure messages[0] opens with a canonical Freebuff root prompt (idempotent).
function injectFreebuffMarker(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return body;
  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    const trimmed = first.content.trimStart();
    if (FREEBUFF_ROOT_SYSTEM_OPENINGS.some((opening) => trimmed.startsWith(opening))) return body; // already marked
    // Prepend the canonical opening to the existing system prompt so it stays
    // the first thing the model reads (keep the rest of the messages intact).
    return {
      ...body,
      messages: [{ ...first, content: `${FREEBUFF_SYSTEM_MARKER}\n\n${first.content}` }, ...messages.slice(1)],
    };
  }
  // No leading system message — insert one with the canonical opening.
  return { ...body, messages: [{ role: "system", content: FREEBUFF_SYSTEM_MARKER }, ...messages] };
}

// The backend's foreign_toolset gate rejects any tool-calling request whose
// toolset lacks the CLI's `end_turn` tool with a misleading 404 "No endpoints
// found for {model}" (verified live 2026-08-14; the freebuff-proxy bridge
// works around the same gate by injecting this definition). Every request that
// declares tools must carry it or the router finds no serving endpoint.
const END_TURN_TOOL = {
  type: "function",
  function: {
    name: "end_turn",
    description: "Signal the end of the current task.",
    parameters: { type: "object", properties: {} },
  },
};

function injectEndTurnTool(body) {
  const tools = body?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return body;
  const hasEndTurn = tools.some(
    (t) => t?.function?.name === "end_turn",
  );
  if (hasEndTurn) return body;
  return { ...body, tools: [...tools, END_TURN_TOOL] };
}

// Freebuff root agent id per model — diambil LANGSUNG dari binary CLI resmi
// `freebuff` v0.0.199 (fungsi pemilih `rw$` → `n6A` → `PKH`/`l6A`).
//
// Peta di binary itu ADA DUA, dan urutan pemakaiannya begini:
//
//   rw$(model) { return Kt === "base3" ? n6A(model) : FKH(model) }
//   n6A(model) { return PKH[model] ?? FKH(model) }   // peta base3
//   FKH(model) { return nw$[model] ?? "base2-free" } // peta base2 + fallback
//
// `Kt` = "base3" (harness aktif saat ini), jadi jalur normal = PKH (base3),
// dan FKH (base2) HANYA dipakai untuk model yang TIDAK ada di PKH.
//
// Konsekuensi penting: Fable TIDAK ada di PKH/l6A — ia hanya ada di peta
// base2 sebagai `base2-free-fable`. Jadi root yang benar untuk Fable adalah
// **base2**, bukan base3. Model di peta ini harus mengikuti peta mana yang
// benar-benar memuatnya di binary, bukan diseragamkan ke base3.
//
// Model yang ditarik upstream (deepseek-v4-pro, minimax-m3, stealth/ox-alpha,
// google/gemini-3.8-flash, meta/muse-spark-1.3-contributor) sengaja tidak
// dipetakan: tidak ada sesi baru yang bisa diadmit di sana. z-ai/glm-5.2 tetap
// dipetakan (akun hasil referral masih bisa menjalankannya) walau bukan baris
// picker tetap.
const FREE_ROOT_AGENT_BY_MODEL = {
  "deepseek/deepseek-v4-flash": "base3-free-deepseek-flash",
  "z-ai/glm-5.2": "base3-free-glm",
  "z-ai/glm-5.3-flash": "base3-free-glm-5-3-flash",
  "mimo/mimo-v2.5": "base3-free-mimo",
  "openai/gpt-5.6-luna": "base3-free-luna",
  "upstage/solar-pro4": "base3-free-solar-pro4",
  "meta/muse-spark-1.2-contributor": "base3-free-muse-spark",
  // Fable: peta base2 satu-satunya yang memuatnya (lihat catatan di atas).
  "anthropic/claude-fable-5.1": "base2-free-fable",
};

// Agent id yang BENAR-BENAR terdefinisi di binary resmi. Dipakai untuk
// memvalidasi fallback di bawah — fallback yang menunjuk agent tak dikenal
// hanya memindahkan kegagalan dari 404 "No endpoints found" ke 404 yang sama,
// tapi tanpa jejak bahwa kita salah menebak.
const KNOWN_ROOT_AGENTS = new Set([
  "base2-free",
  "base2-free-fable",
  "base3-free-deepseek",
  "base3-free-deepseek-flash",
  "base3-free-mimo",
  "base3-free-mimo-2-6-pro",
  "base3-free-minimax-m3",
  "base3-free-luna",
  "base3-free-luna-6",
  "base3-free-glm",
  "base3-free-glm-5-3-flash",
  "base3-free-kimi-k3-eco",
  "base3-free-luna-es",
  "base3-free-muse-spark",
  "base3-free-muse-spark-1-3",
  "base3-free-ox-alpha",
  "base3-free-solar-pro4",
  "base3-free-solar-mini4",
  "base3-free-space-bunny-alpha",
  "base3-free-gemini-3-8-flash",
]);

// Per-token+model session cache (in-memory; keyed so multi-account setups
// don't share one session row). Re-claims are driven by the cache expiring or
// by a 428 from chat — no early re-claim, so we never POST /session while our
// own row is still active (which could come back as a spurious model_locked).
// All state lives on globalThis so Next dev (Turbopack) bundles share ONE copy.
const FB_STATE_KEY = "__9routerFreebuffState__";
const fbState = (globalThis[FB_STATE_KEY] ??= {
  sessionCache: new Map(),      // `${token}::${model}` -> { instanceId, expiresAt }
  inflight: new Map(),          // dedupe concurrent claims for the same key
  modelLockCooldowns: new Map(), // `${token}::${model}` -> expiresAt (ms)
  poolLimitCooldowns: new Map(), // `${proxyKey}::${model}` -> expiresAt (ms)
  offerCache: new Map(),        // `${token}` -> { fetchedAt, offers: [] } (limited-offer rows)
  userIdCache: new Map(),       // `${token}` -> id akun dari GET /api/v1/me
});
const sessionCache = fbState.sessionCache;
const inflight = fbState.inflight;
const modelLockCooldowns = fbState.modelLockCooldowns;
const poolLimitCooldowns = fbState.poolLimitCooldowns;
const offerCache = fbState.offerCache;
const userIdCache = fbState.userIdCache;

const MODEL_LOCK_COOLDOWN_MS = 10 * 60 * 1000; // session bound to another model (~1h) — re-check every 10 min
const POOL_LIMITED_COOLDOWN_MS = 5 * 60 * 1000; // IP tier refuses this model — try a different pool/relay

// Cooldown maps need pruning: expired entries are cleared on write (sweep) and
// on read, so long-running servers don't accumulate one entry per (account,model)
// / (proxy,model) forever.
function setCooldown(map, key, until) {
  const now = Date.now();
  for (const [k, v] of map) {
    if (v <= now) map.delete(k);
  }
  map.set(key, until);
}

function getCooldown(map, key) {
  const until = map.get(key);
  if (until == null) return null;
  if (until <= Date.now()) {
    map.delete(key);
    return null;
  }
  return until;
}

function proxyKeyOf(proxyOptions) {
  return proxyOptions?.vercelRelayUrl || proxyOptions?.connectionProxyUrl || "direct";
}

function sessionGateFromText(text) {
  let parsed = {};
  try { parsed = JSON.parse(String(text || "")); } catch { parsed = {}; }
  return classifySessionGate(parsed.error || parsed.error_type || "", parsed.message || "", parsed.currentModel || null);
}

// Parse a 409/428/410 body into { kind, currentModel }. `msg` may be a whole
// error string containing a JSON tail (requestSession errors embed the body).
function sessionGateFromError(error) {
  const msg = String(error?.message || "");
  const start = msg.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(msg.slice(start));
    return classifySessionGate(parsed.error || "", parsed.message || "", parsed.currentModel || null);
  } catch {
    return null;
  }
}

function classifySessionGate(code, message, currentModel) {
  if (code === "session_superseded") return { kind: "superseded" };
  if (code === "model_locked") return { kind: "model_locked", currentModel };
  // session_model_mismatch with the limited-tier message is an IP-tier refusal;
  // without it (or unknown) treat it as a model lock so we don't reclaim in a loop.
  if (code === "session_model_mismatch") {
    return /limited/i.test(String(message || ""))
      ? { kind: "limited_ip" }
      : { kind: "model_locked", currentModel };
  }
  return { kind: "stale" }; // 428/410/unknown → reclaim
}

// Applies cooldowns and throws for non-reclaimable gates. Never returns for them.
function throwSessionGateError(gate, { token, model, proxyKey, poolId, log }) {
  if (gate.kind === "model_locked") {
    const until = Date.now() + MODEL_LOCK_COOLDOWN_MS;
    setCooldown(modelLockCooldowns, `${token}::${model}`, until);
    const label = gate.currentModel ? `"${gate.currentModel}"` : "another model";
    const err = new Error(
      `Freebuff session is locked to ${label} — it cannot serve ${model}. End the session on freebuff.com or wait for it to expire (~1h).`,
    );
    err.status = 409;
    err.resetsAtMs = until;
    log?.warn?.("AUTH", `Freebuff model_locked (session=${label}, requested=${model}) — model cooldown ${MODEL_LOCK_COOLDOWN_MS / 60000}min`);
    throw err;
  }
  if (gate.kind === "limited_ip") {
    const until = Date.now() + POOL_LIMITED_COOLDOWN_MS;
    setCooldown(poolLimitCooldowns, `${proxyKey}::${model}`, until);
    const scope = `freebuff::${model}`;
    if (poolId) markPoolUnfit(poolId, scope, until, "limited_ip");
    // Pool-scoped, not account-scoped: the caller retries via another pool
    // instead of locking the account (resetsAtMs intentionally absent).
    const err = new Error(
      `Freebuff limited-mode IP rejected ${model} — this IP only allows DeepSeek V4 Flash / MiMo 2.5. Use a full-access proxy or a different model.`,
    );
    err.status = 409;
    err.poolScoped = { poolId, scope, reason: "limited_ip" };
    log?.warn?.("AUTH", `Freebuff limited-IP refused ${model} (proxy=${proxyKey.slice(0, 40)}…) — cooldown ${POOL_LIMITED_COOLDOWN_MS / 60000}min`);
    throw err;
  }
}

function sessionOrigin() {
  return new URL(PROVIDERS.freebuff.baseUrl).origin; // https://www.codebuff.com
}

function sessionCacheKey(token, model) {
  return `${token}::${model}`;
}

function rootAgentIdForModel(model) {
  const mapped = FREE_ROOT_AGENT_BY_MODEL[model];
  if (mapped) return mapped;

  // Model tak dikenal: pakai "base2-free".
  //
  // Ini BUKAN tebakan — `base2-free` adalah satu-satunya fallback yang
  // benar-benar ada di binary resmi. Rantai pemilihnya:
  //
  //   rw$(m) { return Kt === "base3" ? n6A(m) : FKH(m) }
  //   n6A(m) { return PKH[m] ?? FKH(m) }      // peta base3
  //   FKH(m) { return nw$[m] ?? "base2-free" } // peta base2 + fallback
  //
  // Saat harness base3 aktif, model yang tidak ada di PKH jatuh ke FKH, dan
  // di sana `nw$[m]` (peta base2) masih bisa MENANGKAPNYA — jadi fallback
  // terakhir yang pernah dijangkau adalah "base2-free".
  //
  // "base3-free" (tanpa suffix) TIDAK PERNAH ada di binary: ia tidak
  // terdefinisi sebagai agent (`id:"base3-free"` nol kemunculan) dan tidak
  // ada di daftar agent bebas `iw$`. Mengirimnya = 404 "No endpoints found".
  return "base2-free";
}

// Retry transient network errors (ECONNRESET, TLS reset, …) on the session/
// run API calls — mirrors the CLI's fetchWithRetry. Only fetch-level throws
// are retried; HTTP error responses are returned as-is.
//
// The timeout signal is built per attempt: a single shared
// AbortSignal.timeout() would stay aborted forever after it fires, silently
// turning attempts 2..n into instant no-op rejections.
async function fetchWithNetworkRetry(url, options, proxyOptions, attempts = 3, timeoutMs = FETCH_CONNECT_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const opts = { ...options, signal: AbortSignal.timeout(timeoutMs) };
      return await proxyAwareFetch(url, opts, proxyOptions);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  }
  throw lastError;
}

async function requestSession(token, model, proxyOptions) {
  // Offer-gated models (Fable) refuse claims while their wave pool is closed —
  // checked before the POST so a closed offer never burns a claim attempt.
  await guardOfferClaim(token, model, proxyOptions);

  const response = await fetchWithNetworkRetry(`${sessionOrigin()}${SESSION_ADMISSION_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...sessionHeaders(token, { [HEADER_MODEL]: model }),
    },
    body: JSON.stringify({}),
  }, proxyOptions);

  let data = {};
  try { data = await response.json(); } catch { data = {}; }

  // Binary menandai 404/405 di endpoint admission sebagai
  // `session_admission_unsupported` dan menyuruh update CLI — artinya server
  // tidak (lagi) punya rute itu. Jangan jatuh ke /session: POST ke sana tidak
  // pernah jadi jalur resmi, dan menebak hanya menutupi masalah nyata.
  if (response.status === 404 || response.status === 405) {
    const err = new Error(
      `Freebuff session admission endpoint tidak tersedia (${response.status}) — server Freebuff mungkin sudah pindah ke rute lain. Coba update 9router; jangan paksa POST ke /freebuff/session karena itu bukan jalur resmi CLI.`,
    );
    err.status = response.status;
    err.code = "session_admission_unsupported";
    throw err;
  }

  if (response.status === 401) {
    const err = new Error("Freebuff session auth failed (401) — re-login in the dashboard");
    err.status = 401;
    throw err;
  }
  const status = data?.status;
  const GATE_MESSAGES = {
    country_blocked: "Freebuff is not available in your region (country blocked).",
    banned: "Your Freebuff account has been banned.",
    ip_capped: "Freebuff IP cap reached — try again later.",
    rate_limited: "Freebuff session limit reached for this model — try again later.",
    spend_limited: "Freebuff spend limit reached — add credits or wait for the window to reset.",
    model_locked: "Freebuff session is locked to another model — end it in the CLI or wait for it to expire.",
    model_unavailable: "This model is not available on Freebuff right now.",
    premium_slot_taken: "Freebuff premium slot is taken — try another model.",
  };
  // Gate statuses ride BOTH 200 (pre-join refusals) and 4xx — the backend
  // sends spend_limited/rate_limited as HTTP 429 with the gate in the body.
  // Handle them BEFORE the generic !response.ok throw so exhaustion carries
  // resetsAtMs (skip-until-reset) instead of a bare status.
  if (GATE_MESSAGES[status]) {
    const err = new Error(data?.message ? `${GATE_MESSAGES[status]} ${data.message}` : GATE_MESSAGES[status]);
    // Freebucks / session-allowance exhaustion is a hard stop until the daily
    // Pacific reset — mark the account unavailable until then so accountFallback
    // SKIPS it for the rest of the day instead of retrying every 30s and getting
    // refused repeatedly. resetsAtMs is honored by markAccountUnavailable;
    // freebuff bypasses the generic 30-min cap (see auth.js).
    if (status === "rate_limited" || status === "spend_limited") {
      const resetAtMs = Date.parse(data?.resetAt || "");
      if (Number.isFinite(resetAtMs) && resetAtMs > Date.now()) {
        err.resetsAtMs = resetAtMs;
        err.status = 429;
      } else {
        const retryAfterMs = Number(data?.retryAfterMs);
        if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          err.resetsAtMs = Date.now() + retryAfterMs;
          err.status = 429;
        }
      }
    }
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`Freebuff session request failed: ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  if (status === "active") {
    const parsedExp = Date.parse(data.expiresAt || "");
    const entry = {
      instanceId: data.instanceId,
      expiresAt: Number.isFinite(parsedExp) ? parsedExp : Date.now() + SESSION_DEFAULT_TTL_MS,
    };
    sessionCache.set(sessionCacheKey(token, model), entry);
    return { instanceId: data.instanceId, status: "active" };
  }
  if (status === "none") {
    // Not session-gated right now — proceed without an instance id; a 428 on
    // chat tells us the admission gate actually requires a session.
    return { instanceId: null, status: "none" };
  }

  throw new Error(`Freebuff session rejected (${status || response.status}): ${JSON.stringify(data).slice(0, 200)}`);
}

// Fetch the account's current limited-model offers (GET — never claims).
// Cached per token for OFFER_CACHE_TTL_MS: the wave pool changes on server
// time, not ours, and a claim only needs to know "is it open right now".
async function fetchSessionOffers(token, proxyOptions) {
  const now = Date.now();
  const cached = offerCache.get(token);
  if (cached && now - cached.fetchedAt < OFFER_CACHE_TTL_MS) {
    return cached.offers;
  }

  // GET status TANPA x-freebuff-instance-id: kita hanya mengintip penawaran,
  // belum memegang seat. Itu sebabnya header heartbeat/include-unused tidak
  // dipasang di sini — binary memasangnya hanya saat `$.instanceId` ada.
  const response = await fetchWithNetworkRetry(`${sessionOrigin()}${SESSION_PATH}`, {
    method: "GET",
    headers: {
      ...sessionHeaders(token),
      Accept: "application/json",
    },
  }, proxyOptions);

  let data = {};
  try { data = await response.json(); } catch { data = {}; }

  if (response.status === 401) {
    const err = new Error("Freebuff session auth failed (401) — re-login in the dashboard");
    err.status = 401;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`Freebuff offer check failed: ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const offers = Array.isArray(data?.limitedModelOffers)
    ? data.limitedModelOffers.filter((o) => o && typeof o.model === "string")
    : [];
  offerCache.set(token, { fetchedAt: now, offers });
  return offers;
}

// For an offer-gated model (Fable), refuse the claim BEFORE the POST when the
// backend is not currently advertising it. Returns the matching offer when the
// claim may proceed. Throws a plain Error (no JSON tail) so the executor's
// sessionGateFromError stays null and the cooldown maps are never touched —
// a closed offer is availability, not a lock, and the pool can reopen any time.
async function guardOfferClaim(token, model, proxyOptions) {
  if (!OFFER_GATED_MODELS.has(model)) return null;

  const offers = await fetchSessionOffers(token, proxyOptions);
  const offer = offers.find((o) => o.model === model);
  if (!offer || Number(offer.remaining) <= 0) {
    const err = new Error(
      `Claude Fable 5 is not being offered right now — it is a capacity-limited trial served in waves, and freebuff's shared Fable pool is currently empty. Watch the official freebuff CLI for the "Claude Fable 5 · N of M left" row, or retry later.`,
    );
    err.status = 409;
    err.code = "offer_closed";
    throw err;
  }
  const userLeft = Number(offer.userRemaining);
  if (Number.isFinite(userLeft) && userLeft <= 0) {
    const resetAt = Date.parse(offer.userResetAt || "");
    const err = new Error(
      `Your Freebuff account has used its Claude Fable 5 sessions for today (pool: ${offer.remaining} of ${offer.total} left)${Number.isFinite(resetAt) ? ` — next slot ${new Date(resetAt).toLocaleString()}` : ""}.`,
    );
    err.status = 409;
    err.code = "offer_user_capped";
    if (Number.isFinite(resetAt)) err.resetsAtMs = resetAt;
    throw err;
  }
  return offer;
}

async function ensureSession(token, model, proxyOptions, force = false) {
  const key = sessionCacheKey(token, model);
  // Lazy prune: drop stale rows so the cache never accumulates expired entries.
  const cached = sessionCache.get(key);
  if (cached && cached.expiresAt <= Date.now()) {
    sessionCache.delete(key);
  }
  if (!force && cached && cached.expiresAt > Date.now()) {
    return { instanceId: cached.instanceId, status: "active" };
  }
  if (force) {
    // Drop both the cached row and any in-flight claim so the fresh POST can't
    // race a stale one back into the cache.
    sessionCache.delete(key);
    inflight.delete(key);
    return requestSession(token, model, proxyOptions);
  }
  if (!inflight.has(key)) {
    inflight.set(key, requestSession(token, model, proxyOptions).finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

// Register an agent run so the chat backend can resolve the run_id we send.
//
// DUAL-AUTH: binary mengirim `Authorization: Bearer` DAN `x-codebuff-api-key`
// (token yang sama) di setiap panggilan /agent-runs:
//   headers: this.token ? { 'x-codebuff-api-key': this.token } : {}
// Token-nya identik, jadi ini bukan kredensial kedua — server memakai header
// itu untuk mengaitkan run dengan akun. Tanpa itu run bisa tidak terlihat
// sebagai milik akun kita.
async function startRun(token, model, proxyOptions) {
  const response = await fetchWithNetworkRetry(`${sessionOrigin()}${RUN_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": PLAIN_UA,
      [HEADER_API_KEY]: token,
    },
    body: JSON.stringify({
      action: "START",
      agentId: rootAgentIdForModel(model),
      ancestorRunIds: [],
    }),
  }, proxyOptions);

  const text = await response.text().catch(() => "");
  let data = {};
  try { data = JSON.parse(text); } catch { data = {}; }

  if (response.status === 401) {
    const err = new Error("Freebuff run auth failed (401) — re-login in the dashboard");
    err.status = 401;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`Freebuff run start failed: ${response.status} ${text.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  if (!data?.runId) {
    throw new Error(`Freebuff run start returned no runId: ${text.slice(0, 200)}`);
  }
  return data.runId;
}

// Ambil id akun sendiri dari GET /api/v1/me?fields=id,email — probe token yang
// dipakai CLI setelah login, dan sumber `x-freebuff-acting-user-id`.
//
// Hanya dipanggil sebagai CADANGAN saat kredensial belum menyimpan userId
// (akun lama yang tersambung sebelum field itu ikut disimpan). Hasilnya
// di-cache per token supaya tidak memanggil endpoint ini di setiap request.
// Gagal = null (bukan throw): identitas adalah pelengkap, bukan syarat.
async function fetchActingUserId(token, proxyOptions) {
  const cached = userIdCache.get(token);
  if (cached !== undefined) return cached;

  try {
    const response = await fetchWithNetworkRetry(
      `${sessionOrigin()}${ME_PATH}?fields=id,email`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "User-Agent": PLAIN_UA, Accept: "application/json" },
      },
      proxyOptions,
    );
    if (!response.ok) {
      // Server menjawab tegas (401/403/404) — tidak ada id untuk token ini.
      // Simpan hasil negatifnya supaya endpoint ini tidak dipanggil ulang di
      // setiap request: header ini pelengkap, bukan syarat.
      userIdCache.set(token, null);
      return null;
    }
    const data = await response.json().catch(() => null);
    const id = data?.id ? String(data.id) : null;
    userIdCache.set(token, id);
    return id;
  } catch {
    // Gangguan jaringan: JANGAN simpan — percobaan berikutnya boleh mencoba lagi.
    return null;
  }
}

// Best-effort run completion — mirrors the CLI's finishAgentRun. Never throws.
async function finishRun(token, runId, status, proxyOptions) {
  if (!runId) return;
  try {
    await proxyAwareFetch(`${sessionOrigin()}${RUN_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": PLAIN_UA,
        [HEADER_API_KEY]: token, // dual-auth, sama seperti startRun
      },
      body: JSON.stringify({ action: "FINISH", runId, status }),
      signal: AbortSignal.timeout(10_000),
    }, proxyOptions);
  } catch {
    // Best-effort only — the server sweeps stale runs.
  }
}

export function resetSessionCache() {
  sessionCache.clear();
  inflight.clear();
  offerCache.clear();
  userIdCache.clear();
}

// Snapshot sizes of in-memory freebuff state (for the dashboard memory panel).
export function sessionStateSize() {
  return {
    sessions: sessionCache.size,
    inflight: inflight.size,
    modelLocks: modelLockCooldowns.size,
    poolLimits: poolLimitCooldowns.size,
    offerCaches: offerCache.size,
    userIds: userIdCache.size,
  };
}

// Periodic sweeper: drop stale session rows + expired cooldowns so long-running
// servers never accumulate state for accounts/models no longer in use.
// Returns how many entries were removed.
export function pruneSessionState(now = Date.now()) {
  let removed = 0;
  for (const [key, entry] of sessionCache) {
    if (entry?.expiresAt && entry.expiresAt <= now) {
      sessionCache.delete(key);
      removed += 1;
    }
  }
  for (const [key, entry] of offerCache) {
    if (now - entry.fetchedAt >= OFFER_CACHE_TTL_MS) {
      offerCache.delete(key);
      removed += 1;
    }
  }
  for (const [key, until] of modelLockCooldowns) {
    if (until <= now) {
      modelLockCooldowns.delete(key);
      removed += 1;
    }
  }
  for (const [key, until] of poolLimitCooldowns) {
    if (until <= now) {
      poolLimitCooldowns.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff);
  }

  buildUrl() {
    return this.config.baseUrl;
  }

  // The backend's model router answers 404 "No endpoints found for {model}"
  // when a tool-calling request's toolset fails its foreign_toolset gate —
  // normally prevented by injecting the CLI's `end_turn` tool (see
  // injectEndTurnTool). If one still slips through, surface a helpful message
  // instead of a bare 404, and let the standard cooldown pace retries.
  async parseError(response, bodyText) {
    const text = String(bodyText || "");
    if (response?.status === 404 && /No endpoints found/i.test(text)) {
      return {
        status: 404,
        message: `Freebuff upstream rejected the request (404: "${text.trim().slice(0, 90)}"). Tool-calling requests need the CLI's end_turn tool — retry; if it persists the Codebuff backend may be having trouble.`,
        resetsAtMs: Date.now() + 120_000,
      };
    }
    return super.parseError(response, bodyText);
  }

  transformRequest(model, body, stream, credentials) {
    // Top-level wire shape — see header comment. `run_id` and
    // `freebuff_instance_id` are attached by execute() (they need the async
    // run/session registration), so this only sets the static parts.
    body.codebuff_metadata = {
      client_id:
        credentials?.providerSpecificData?.fingerprintId ||
        `9router-${crypto.randomUUID()}`,
      cost_mode: "free",
      // Setiap request chat adalah SATU langkah agen; binary menomori langkah
      // per loop (`llm_step_number: String(CH)` dengan CH di-increment sebelum
      // panggilan). Request kita = satu panggilan, jadi selalu "1".
      llm_step_number: "1",
    };
    // `allow_fallbacks` BUKAN konstanta — binary menghitungnya per model:
    //   F = { order: CV$[model], allow_fallbacks: !lm(model) }
    //   lm(m) { return cmA.has(m) }        // cmA = Set dari peta model lama (h1)
    // Model freebuff yang kita pakai TIDAK ada di himpunan itu, jadi nilainya
    // `true` untuk semua model di FREE_ROOT_AGENT_BY_MODEL.
    //
    // `data_collection: "deny"` datang dari agent-nya sendiri: SETIAP agent
    // free di binary mendeklarasikan providerOptions itu (mis. base3-free-mimo
    // → { data_collection: "deny" }), dan CLI menyebarkannya ke request.
    // Fable memakai daftar lebih sempit: { only: ["anthropic"],
    // data_collection: "deny" }. Lapisan provider inilah yang membawa
    // preferensi itu ke upstream.
    body.provider = {
      allow_fallbacks: true,
      data_collection: "deny",
      ...(model === FABLE_MODEL ? { only: ["anthropic"] } : {}),
    };
    // Freebuff agents (base3-free-*) own reasoning: the backend applies the
    // agent's reasoningOptions.effort server-side, so a client-sent
    // reasoning_effort / reasoning.effort collides with that default →
    // 400 "both provided with conflicting values". Mirror the CLI: send none.
    delete body.reasoning_effort;
    delete body.reasoning;
    // Free-tier gate: first system message must open with the CLI marker.
    body = injectFreebuffMarker(body);
    // Foreign-toolset gate: tool-calling requests must declare `end_turn`.
    return injectEndTurnTool(body);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = credentials?.accessToken;
    if (!token) {
      throw new Error("Freebuff requires a connected Freebuff login (no access token found)");
    }

    // Fail fast while a known-dead (account,model) / (proxy,model) pair is in
    // cooldown — no session claim, no run registration, no upstream spam.
    const proxyKey = proxyKeyOf(proxyOptions);
    const poolId = proxyOptions?.proxyPoolId || null;
    const scope = `freebuff::${model}`;
    const lockUntil = getCooldown(modelLockCooldowns, `${token}::${model}`);
    if (lockUntil) {
      const err = new Error(`Freebuff session locked to another model — retry after ${new Date(lockUntil).toLocaleTimeString()}`);
      err.status = 409;
      err.resetsAtMs = lockUntil;
      throw err;
    }
    const poolUntil = getCooldown(poolLimitCooldowns, `${proxyKey}::${model}`);
    if (poolUntil) {
      const err = new Error(`Freebuff limited-mode IP rejected ${model} — retry with a full-access proxy after ${new Date(poolUntil).toLocaleTimeString()}`);
      err.status = 409;
      err.poolScoped = { poolId, scope, reason: "limited_ip" };
      throw err;
    }

    let session;
    try {
      session = await ensureSession(token, model, proxyOptions);
    } catch (error) {
      const gate = sessionGateFromError(error);
      if (gate) throwSessionGateError(gate, { token, model, proxyKey, poolId, log });
      log?.error?.("AUTH", `Freebuff session failed: ${error.message}`);
      throw error;
    }

    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials, stream);
    // Identitas akun yang bertindak — dikirim CLI di SETIAP panggilan chat:
    //   ...(this.userId ? { 'x-freebuff-acting-user-id': this.userId } : {})
    // userId sudah tersimpan saat login (mapTokens → providerSpecificData.userId).
    // Kalau tidak ada, header dihilangkan — sama seperti CLI (bukan diisi "").
    // Akun lama mungkin belum menyimpan userId — ambil sekali dari
    // /api/v1/me (di-cache), sama seperti CLI yang memakai endpoint itu
    // sebagai probe token. Kalau tetap tidak ada, header dihilangkan.
    const actingUserId =
      credentials?.providerSpecificData?.userId ||
      (await fetchActingUserId(token, proxyOptions));
    if (actingUserId) headers[HEADER_ACTING_USER_ID] = String(actingUserId);
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Registered run whose id the backend resolves on chat. Per-request, like
    // the CLI's one-run-per-prompt granularity; closure-local so concurrent
    // requests never share a runId. trace_session_id mirrors the CLI's
    // extraCodebuffMetadata — one per run, stable across retries.
    let runId = null;
    const traceSessionId = crypto.randomUUID();

    const buildBody = () => {
      const transformed = this.transformRequest(model, body, stream, credentials);
      transformed.codebuff_metadata.run_id = runId;
      transformed.codebuff_metadata.trace_session_id = traceSessionId;
      if (session?.instanceId) {
        transformed.codebuff_metadata.freebuff_instance_id = session.instanceId;
      }
      return transformed;
    };

    // Chat POST with connect timeout + registry 429/502/503 retry + up to 2
    // retries on fetch-level network errors (per attempt the body is rebuilt
    // so each retry reuses the same registered run_id).
    const doChat = async () => {
      let networkAttempts = 0;
      const MAX_NETWORK_ATTEMPTS = 2;
      for (let attempt = 0; ; attempt++) {
        const transformedBody = buildBody();
        const bodyStr = JSON.stringify(transformedBody);

        const connectCtrl = new AbortController();
        const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
        const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
        const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;
        let response;
        try {
          response = await proxyAwareFetch(url, { method: "POST", headers, body: bodyStr, signal: mergedSignal }, proxyOptions);
        } catch (error) {
          // A caller/stream abort (AbortError) is genuine — never retry it. A
          // transient socket/TLS reset (same class as the run-registration
          // failure in the field) gets a couple of quick retries so a network
          // blip doesn't fail the request and lock the model for 30s.
          const aborted = error?.name === "AbortError";
          if (aborted || networkAttempts >= MAX_NETWORK_ATTEMPTS) throw error;
          networkAttempts += 1;
          log?.debug?.("RETRY", `network error on ${url} (${error.message}), retry ${networkAttempts}/${MAX_NETWORK_ATTEMPTS}`);
          await new Promise((resolve) => setTimeout(resolve, 750));
          continue;
        } finally {
          clearTimeout(connectTimer);
        }

        const entry = resolveRetryEntry(retryConfig[response.status]);
        if (entry && attempt < entry.attempts) {
          log?.debug?.("RETRY", `${response.status} on ${url}, retry ${attempt + 1}/${entry.attempts} after ${entry.delayMs / 1000}s`);
          await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
          continue;
        }
        return { response, transformedBody };
      }
    };

    // The run currently in flight. Only this one is FINISH-able: after a stale
    // session (428/409/410) the old run is FINISH'd "cancelled" and cleared, so
    // a later failure can never double-FINISH it (the server rejects duplicate
    // FINISHes for the same runId).
    let activeRunId = null;
    const markFinished = (status) => {
      if (!activeRunId) return;
      const id = activeRunId;
      activeRunId = null;
      finishRun(token, id, status, proxyOptions);
    };

    try {
      try {
        runId = await startRun(token, model, proxyOptions);
        activeRunId = runId;
      } catch (error) {
        log?.error?.("AUTH", `Freebuff run start failed: ${error.message}`);
        throw error;
      }

      let { response, transformedBody } = await doChat();

      // Session gates that mean our claimed session is stale/absent:
      //   428 waiting_room_required — no session row / instance id missing
      //   409 session_superseded — another instance took over the session
      //   409 session_model_mismatch — session bound to a different model
      //   410 session_expired    — the active session's expires_at passed
      // model_locked / limited-tier mismatches are NOT reclaimable — the server
      // keeps refusing until the session expires or the IP tier changes, so we
      // set a cooldown and fail fast instead of force re-claiming in a loop.
      if (SESSION_STALE_CODES.has(response.status)) {
        const text = await response.text().catch(() => "");
        const gate = sessionGateFromText(text);
        if (gate.kind === "model_locked" || gate.kind === "limited_ip") {
          markFinished("cancelled");
          throwSessionGateError(gate, { token, model, proxyKey, poolId, log });
        }

        log?.debug?.("AUTH", `Freebuff ${response.status} session gate — re-claiming session`);
        markFinished("cancelled");
        try {
          session = await ensureSession(token, model, proxyOptions, true);
          runId = await startRun(token, model, proxyOptions);
          activeRunId = runId;
        } catch (error) {
          const gate2 = sessionGateFromError(error);
          if (gate2) throwSessionGateError(gate2, { token, model, proxyKey, poolId, log });
          log?.error?.("AUTH", `Freebuff session re-claim failed: ${error.message}`);
          throw error;
        }
        ({ response, transformedBody } = await doChat());

        if (SESSION_STALE_CODES.has(response.status)) {
          const text2 = await response.text().catch(() => "");
          const gate3 = sessionGateFromText(text2);
          if (gate3.kind === "model_locked" || gate3.kind === "limited_ip") {
            throwSessionGateError(gate3, { token, model, proxyKey, poolId, log });
          }
          const err = new Error(
            `Freebuff session gate refused (${response.status}) — another freebuff instance may be holding the session. ${text2.slice(0, 160)}`,
          );
          err.status = response.status;
          throw err;
        }
      }

      // A successful chat means the pair is healthy again — lift any cooldowns.
      if (response.ok) {
        modelLockCooldowns.delete(`${token}::${model}`);
        poolLimitCooldowns.delete(`${proxyKey}::${model}`);
        if (poolId) clearPoolUnfit(poolId, scope);
      }

      // The authToken has no refresh path — when it dies, the user re-logs in.
      // Drop the cached session for this token so a re-login starts clean.
      if (response.status === 401) {
        sessionCache.delete(sessionCacheKey(token, model));
        const text = await response.text().catch(() => "");
        const err = new Error(`Freebuff auth failed (401) — re-login in the dashboard. ${text.slice(0, 120)}`);
        err.status = 401;
        throw err;
      }

      // Best-effort run accounting, mirroring the CLI.
      markFinished(response.ok ? "completed" : "failed");

      return { response, url, headers, transformedBody };
    } finally {
      // Never leave the current run dangling on thrown paths (network/abort/gate).
      if (activeRunId) {
        finishRun(token, activeRunId, "failed", proxyOptions);
      }
    }
  }
}

export const __test__ = {
  ensureSession,
  requestSession,
  startRun,
  resetSessionCache,
  rootAgentIdForModel,
  injectFreebuffMarker,
  injectEndTurnTool,
  fetchWithNetworkRetry,
  fetchSessionOffers,
  guardOfferClaim,
  OFFER_GATED_MODELS,
  FREEBUFF_SYSTEM_MARKER,
  SESSION_STALE_CODES,
  FREE_ROOT_AGENT_BY_MODEL,
  KNOWN_ROOT_AGENTS,
};

export default FreebuffExecutor;
