/**
 * Parser for Google Cloud Code / Cloud Code Assist quota-reset signals.
 *
 * A real 429 from cloudcode-pa.googleapis.com says when the quota returns three
 * different ways, and all three were previously discarded — `parseUpstreamError`
 * keeps only `error.message`, and Antigravity had no `parseError` override, so
 * `resetsAtMs` was never populated. The cooldown then fell back to the generic
 * exponential backoff (2s → 30s), meaning an account whose quota returns in
 * ~6 days was re-probed every few seconds for days.
 *
 *   {
 *     "error": {
 *       "code": 429, "status": "RESOURCE_EXHAUSTED",
 *       "message": "Individual quota reached. ... Resets in 149h50m20s.",
 *       "details": [
 *         { "@type": ".../google.rpc.ErrorInfo",
 *           "reason": "QUOTA_EXHAUSTED",
 *           "metadata": { "model": "gemini-3-flash-agent",
 *                         "quotaResetDelay": "149h50m20.179078308s",
 *                         "quotaResetTimeStamp": "2026-08-08T17:54:07Z" } },
 *         { "@type": ".../google.rpc.RetryInfo",
 *           "retryDelay": "539420.179078308s" }
 *       ]
 *     }
 *   }
 *
 * Both encodings appear in the wild and both are handled here:
 *   - protobuf Duration JSON: "539420.179078308s"  (seconds.fractional + "s")
 *   - Go duration string:     "149h50m20.179078308s"
 */

const RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo";
const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

/**
 * Parse a protobuf Duration JSON string ("539420.179078308s") to milliseconds.
 * Returns null when the value is absent or not a positive finite duration.
 */
export function parseProtobufDuration(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * Parse a Go duration string ("149h50m20.179078308s", "45m", "30s") to ms.
 * Google's ErrorInfo metadata uses this form for `quotaResetDelay`.
 */
export function parseGoDuration(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    if (m[2] === "h") total += n * 3600_000;
    else if (m[2] === "m") total += n * 60_000;
    else total += n * 1000;
  }
  if (!matched) return null;
  const ms = Math.round(total);
  return ms > 0 ? ms : null;
}

/** Parse an ISO-8601 timestamp to ms epoch; null when invalid or not in the future. */
export function parseResetTimestamp(value) {
  if (typeof value !== "string") return null;
  const t = Date.parse(value.trim());
  if (!Number.isFinite(t)) return null;
  return t > Date.now() ? t : null;
}

/** Pull the first detail object whose @type matches `type`, tolerating @type absent. */
function findDetail(details, type) {
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    if (!d || typeof d !== "object") continue;
    if (d["@type"] === type) return d;
    // Some responses omit @type but keep the distinguishing field.
    if (type === RETRY_INFO_TYPE && typeof d.retryDelay === "string") return d;
    if (type === ERROR_INFO_TYPE && d.metadata && typeof d.metadata === "object") return d;
  }
  return null;
}

/**
 * Extract the quota-reset signal from a parsed Google error body.
 *
 * Priority (most precise first):
 *   1. ErrorInfo.metadata.quotaResetTimeStamp  — absolute ISO timestamp
 *   2. ErrorInfo.metadata.quotaResetDelay      — Go duration
 *   3. RetryInfo.retryDelay                    — protobuf Duration
 *   4. "Resets in 149h50m20s" in the message   — last resort, same Go parser
 *
 * @param {object} json - Parsed response body
 * @returns {{resetsAtMs: number|null, model: string|null, reason: string|null, source: string|null}}
 */
export function extractGoogleQuotaReset(json) {
  const empty = { resetsAtMs: null, model: null, reason: null, source: null };
  const err = json?.error;
  if (!err || typeof err !== "object") return empty;

  const details = err.details;
  const errorInfo = findDetail(details, ERROR_INFO_TYPE);
  const retryInfo = findDetail(details, RETRY_INFO_TYPE);
  const meta = errorInfo?.metadata && typeof errorInfo.metadata === "object" ? errorInfo.metadata : {};

  const model = typeof meta.model === "string" && meta.model.trim() ? meta.model.trim() : null;
  const reason = typeof errorInfo?.reason === "string" && errorInfo.reason.trim() ? errorInfo.reason.trim() : null;

  const fromStamp = parseResetTimestamp(meta.quotaResetTimeStamp);
  if (fromStamp) return { resetsAtMs: fromStamp, model, reason, source: "quotaResetTimeStamp" };

  const fromDelay = parseGoDuration(meta.quotaResetDelay);
  if (fromDelay) return { resetsAtMs: Date.now() + fromDelay, model, reason, source: "quotaResetDelay" };

  const fromRetry = parseProtobufDuration(retryInfo?.retryDelay);
  if (fromRetry) return { resetsAtMs: Date.now() + fromRetry, model, reason, source: "retryDelay" };

  const msg = typeof err.message === "string" ? err.message : "";
  const m = msg.match(/reset[s]?\s+(?:in\s+)?(\d+h)?(\d+m)?(\d+s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    const fromMsg = parseGoDuration([m[1], m[2], m[3]].filter(Boolean).join(""));
    if (fromMsg) return { resetsAtMs: Date.now() + fromMsg, model, reason, source: "message" };
  }

  return { resetsAtMs: null, model, reason, source: null };
}
