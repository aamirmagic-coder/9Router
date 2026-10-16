/**
 * CodeBuddy / WorkBuddy conversation-scoped request identity.
 *
 * The CodeBuddy gateways run a channel check on every request. A call that looks
 * like it came from a non-official client is rejected with HTTP 400 / code 11128
 * ("conversation id missing" / "Request blocked … not sent from an official
 * client"). The official client sends a family of identity headers; 9router sent
 * only auth, so those calls were refused.
 *
 * Header roles (mirroring the official VS Code extension bundle — constants
 * CONVERSATION_ID_HEADER / CONVERSATION_REQUEST_ID_HEADER /
 * CONVERSATION_MESSAGE_ID_HEADER):
 *
 *   X-Conversation-ID          STABLE for the whole conversation. The gateway
 *                              uses it for affinity routing and prefix-cache
 *                              reuse, so it must NOT change per turn or per
 *                              retry — a fresh id every request defeats both.
 *   X-Conversation-Request-ID  One per TURN (aggregation key). Constant across
 *                              retries/account fallback within that turn.
 *   X-Conversation-Message-ID  One per OUTBOUND request, including retries.
 *   X-Root-Request-ID          Same value as X-Conversation-Request-ID.
 *   X-Trace-ID                 Passthrough inbound, else the turn id.
 *   X-B3-TraceId               32 hex chars. Passthrough a valid inbound B3
 *                              trace, else random. Stable within the turn.
 *   X-B3-SpanId                16 hex chars, new per outbound request.
 *   X-B3-Sampled               Passthrough inbound "0", else "1".
 *
 * Concurrency: the turn context lives in AsyncLocalStorage, never in a mutable
 * field on the executor singleton. Parallel requests share one executor object,
 * so instance state would swap their ids.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { resolveSessionIdentity } from "./sessionManager.js";

const storage = new AsyncLocalStorage();

/** Providers whose upstreams enforce the channel check. */
export const BUDDY_SCOPES = new Set(["codebuddy-intl", "codebuddy-cn"]);

const HEADER = {
  conversation: "X-Conversation-ID",
  turn: "X-Conversation-Request-ID",
  message: "X-Conversation-Message-ID",
  root: "X-Root-Request-ID",
  trace: "X-Trace-ID",
  b3Trace: "X-B3-TraceId",
  b3Span: "X-B3-SpanId",
  b3Sampled: "X-B3-Sampled",
};

/** 32 lowercase hex chars (16 bytes) — B3 trace id shape. */
const B3_TRACE_RE = /^[0-9a-f]{32}$/i;
/** 16 lowercase hex chars (8 bytes) — B3 span id shape. */
const B3_SPAN_RE = /^[0-9a-f]{16}$/i;

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Read a header case-insensitively from a plain object of inbound headers. */
function incoming(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key === "string" && key.toLowerCase() === target) {
      const v = typeof value === "string" ? value.trim() : "";
      return v || null;
    }
  }
  return null;
}

/**
 * A B3 trace id is only reusable when it is the right shape and not all-zero
 * (the spec reserves all-zero as "unknown", and forwarding it makes every
 * request look like the same trace).
 */
function validB3Trace(value) {
  if (!value || !B3_TRACE_RE.test(value)) return null;
  return /^0+$/.test(value) ? null : value.toLowerCase();
}

function validB3Span(value) {
  if (!value || !B3_SPAN_RE.test(value)) return null;
  return /^0+$/.test(value) ? null : value.toLowerCase();
}

/**
 * Build one turn's identity from the inbound request.
 *
 * The conversation id prefers an inbound X-Conversation-ID, then the existing
 * conversation-stable session resolver (client session header → assistant-text
 * hash → workspace → per-connection). The resolver's per-connection fallback is
 * NOT truly conversation-scoped — two sessions on one account share it — so it
 * is accepted here only because the gateway needs *a* stable id and a shared id
 * still routes correctly; it does not leak across accounts, since connectionId
 * is account-scoped.
 */
export function createTurn(headers, { body = null, connectionId = null, scope = "" } = {}) {
  const inboundConversation = incoming(headers, HEADER.conversation);
  let conversationId = inboundConversation;
  if (!conversationId) {
    try {
      const resolved = resolveSessionIdentity({ headers, body, connectionId, scope });
      conversationId = resolved?.sessionId || null;
    } catch {
      conversationId = null;
    }
  }
  if (!conversationId) conversationId = crypto.randomUUID();

  const turnId = incoming(headers, HEADER.turn) || crypto.randomUUID();
  const b3Trace = validB3Trace(incoming(headers, "x-b3-traceid")) || randomHex(16);

  return {
    conversationId,
    turnId,
    b3Trace,
    b3Sampled: incoming(headers, "x-b3-sampled") === "0" ? "0" : "1",
    traceId: incoming(headers, HEADER.trace) || turnId,
  };
}

/** Run `fn` with `turn` bound to the async context. */
export function run(turn, fn) {
  return storage.run(turn, fn);
}

/** The current turn, or null outside a bound context. */
export function currentTurn() {
  return storage.getStore() || null;
}

/**
 * Add the eight identity headers to `headers` (mutated in place).
 *
 * Message id and span id are regenerated on every call — that is what makes
 * them per-outbound while conversation/turn/trace stay put across retries.
 * Header names are written in one canonical capitalisation; any inbound copy
 * already present under a different casing is removed first so the request
 * never carries two spellings of the same header.
 */
export function addHeaders(headers, turn = currentTurn()) {
  if (!headers || !turn) return headers;

  const set = (name, value) => {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === target && key !== name) delete headers[key];
    }
    headers[name] = value;
  };

  set(HEADER.conversation, turn.conversationId);
  set(HEADER.turn, turn.turnId);
  set(HEADER.message, crypto.randomUUID());
  set(HEADER.root, turn.turnId);
  set(HEADER.trace, turn.traceId);
  set(HEADER.b3Trace, turn.b3Trace);
  set(HEADER.b3Span, randomHex(8));
  set(HEADER.b3Sampled, turn.b3Sampled);

  return headers;
}

/** True when this provider's upstream enforces the channel check. */
export function isBuddyProvider(provider) {
  return BUDDY_SCOPES.has(provider);
}

export const __test__ = { incoming, validB3Trace, validB3Span, HEADER };
