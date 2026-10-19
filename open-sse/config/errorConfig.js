// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff?, noFallback? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 *   - noFallback: true = account-scoped statuses skip rotation for this failure
 *     (a model-level verdict the credential cannot fix)
 *   - modelLevel: true = serving restriction on the model itself. The client-facing
 *     error is MODEL_LEVEL_ERROR and the upstream's retry hint is dropped with it.
 */

// Client-facing error for a serving restriction (`modelLevel` rules below). Not
// quota/rate-limit vocabulary on purpose: a client that reads `insufficient_quota`
// here parks the credential for a whole usage window — or aborts the turn outright —
// over a model this caller will never be served.
export const MODEL_LEVEL_ERROR = { type: "permission_error", code: "model_not_available" };

export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },
  // Model-level serving restriction (e.g. Meta's Geographic Use Policy): the key
  // and account are fine, this model is not served to this caller here. Locking
  // the connection for a cooldown turns a real answer into a bogus 503
  // "reset after 2m", and retrying cannot change a geographic verdict.
  { text: "geographic use policy",     noFallback: true, modelLevel: true },
  { text: "not available in your region", noFallback: true, modelLevel: true },
  // A plan without provider-API access: the surface answers the same denial for
  // every model, and no cooldown or account rotation can change a subscription.
  // Locking on it turns a clear entitlement answer into a bogus 503 "reset after 2m".
  { text: "doesn't include api access", noFallback: true },
  // The same surface gates Meta's `*-contributor` ids with a 403 that blames the
  // credential ("Authentication failed. Please check your credentials.") —
  // verified live: the same key served deepseek and muse-spark-1.3 on that surface
  // seconds later, and a genuinely bad key answers 401 "Invalid 'Authorization'
  // header or token." instead. The 403 status rule then locked the model for a
  // whole cooldown, so the gate kept answering 503 "reset after 14s" long after
  // upstream served the model again. Provider-scoped on purpose: the executor's
  // replay seam asks modelLevelError without a provider, so this rule does not
  // stop the CLI lane from serving a turn the provider surface refused.
  { provider: "commandcode", text: "authentication failed. please check your credentials.", noFallback: true, modelLevel: true, message: "Command Code is not serving this model right now — the upstream gate is temporary and your credential is fine. Retry the request." },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
