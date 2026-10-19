import { createHash, randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { FORMATS } from "../translator/formats.js";
import { openaiToCommandCodeRequest, COMMANDCODE_MAX_OUTPUT_TOKENS } from "../translator/request/openai-to-commandcode.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { modelLevelError } from "../services/accountFallback.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { escapeTemplateTokensInAssistantMessages } from "../utils/chatTemplateTokens.js";
import { SSE_DONE } from "../utils/sseConstants.js";

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-request `x-session-id` header, kept stable per client session.
 *
 * Two surfaces, same gateway:
 *  - Provider API (`/provider/v1/chat/completions`) — documented, OpenAI-shaped
 *    request, no CLI version gate. This is the default.
 *  - CLI (`/alpha/generate`) — reached only when the provider surface answers
 *    403/404 (Go plans without Provider API access, or ids served only on the
 *    CLI lane). It version-gates the caller (`403 upgrade_required` when
 *    x-command-code-version is absent or below its minimum, which this registry
 *    presents). The OpenAI body is converted to the CLI envelope on the way.
 *
 * Model verdicts are not a property of either surface: the Cloudflare edge that
 * answers decides. Meta ids answer 403 on one edge and stream on a sibling edge
 * with the same key and body (see GATE_RETRIES below), so both surfaces are read
 * through the same reconnect before their verdict is believed.
 *
 * Both surfaces return their own stream shape — the provider surface streams
 * OpenAI chunks with `data:` framing, the CLI lane AI SDK v5 NDJSON without it —
 * so `responseFormat` is pinned to COMMANDCODE and each event is translated to
 * an OpenAI chat.completion.chunk and emitted as SSE.
 */

// muse-spark (Meta) runs a hidden reasoning phase that can consume the whole
// output budget, leaving HTTP 200 with empty content. Floor only budgets the
// caller actually set; never fabricate one.
const MUSE_SPARK_PATTERN = /(?:^|\/|\b)muse-spark/i;
const MUSE_SPARK_MIN_OUTPUT_TOKENS = 512;
const OUTPUT_BUDGET_FIELDS = ["max_tokens", "max_output_tokens", "max_completion_tokens"];

function floorMuseSparkBudget(model, body) {
  if (!MUSE_SPARK_PATTERN.test(String(model || ""))) return;
  for (const field of OUTPUT_BUDGET_FIELDS) {
    const value = body[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < MUSE_SPARK_MIN_OUTPUT_TOKENS) {
      body[field] = MUSE_SPARK_MIN_OUTPUT_TOKENS;
    }
  }
}

/** The CLI surface identifies callers with its own environment label. */
const CLI_ONLY_HEADERS = {
  "x-cli-environment": "external",
  "x-project-slug": "9router",
  "x-taste-learning": "false",
  "x-co-flag": "false",
  "User-Agent": "cli",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Command Code validates `threadId` (and the CLI surface's session id) as UUIDs,
 * but the gateway's session seed is an arbitrary string — a hashed connection id.
 * Derive a stable UUID from that seed so one conversation keeps one wire thread
 * and the envelope never trips the upstream "Invalid UUID at threadId" 400.
 */
function toUuid(seed) {
  if (typeof seed === "string" && UUID_RE.test(seed)) return seed;
  const bytes = createHash("sha256").update(String(seed ?? randomUUID())).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sessionIdFor(credentials) {
  return toUuid(credentials?._ccSessionId || credentials?._clientSessionId || credentials?.connectionId);
}

// The gateway's model-level 403s are a property of the Cloudflare edge that
// answered the request, not of the model or the key: verified live with one key and
// one body milliseconds apart — the edge that answers as cf-ray HKG returns 403
// "Authentication failed. Please check your credentials." for meta/*, while SIN and
// NRT serve the same turn. The gate is therefore a per-connection lottery, and a
// pooled socket that landed on a gated edge keeps answering it, so retrying the
// same connection only pays for the same answer. Own this provider's pool so a
// gated socket can be replaced, and spend a bounded number of reconnects before
// reporting the verdict.
const GATE_RETRIES = 2;
const GATE_RETRY_DELAY_MS = 250;
let providerAgent = null;

/** The pool the provider surface draws its connection from (lazily created). */
async function providerDispatcher() {
  if (!providerAgent) {
    const { Agent } = await import("undici");
    providerAgent = new Agent();
  }
  return providerAgent;
}

/**
 * Replace the pooled connection so the next attempt negotiates a fresh edge.
 * `close()` rather than `destroy()`: a response the caller still has to read (the
 * rejection body the router reports onward) keeps its socket until it is consumed.
 */
function rotateProviderConnection() {
  const previous = providerAgent;
  providerAgent = null;
  if (previous) previous.close().catch(() => { /* sockets are already being torn down */ });
}

export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    // The provider surface receives the OpenAI body, so bound the same budget
    // fields the CLI envelope schema caps: a value above the limit fails the turn.
    for (const field of OUTPUT_BUDGET_FIELDS) {
      if (body[field] > COMMANDCODE_MAX_OUTPUT_TOKENS) body[field] = COMMANDCODE_MAX_OUTPUT_TOKENS;
    }
    floorMuseSparkBudget(model, body);
    // Both lanes render this body: the OpenAI-shaped provider surface sends it, and
    // the CLI replay builds its envelope from the returned body (executeFallback).
    return injectReasoningContent({
      provider: this.provider,
      model,
      body: escapeTemplateTokensInAssistantMessages(body),
    });
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": sessionIdFor(credentials),
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  /** Carry the resolved session id on a credentials copy for this request. */
  prepareRequestCredentials({ providerSessionId, credentials } = {}) {
    const source = credentials || {};
    if (source._ccSessionId) return source;
    // Normalized here so both the header and the CLI envelope threadId are UUIDs.
    return { ...source, _ccSessionId: toUuid(providerSessionId || source._clientSessionId || source.connectionId) };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    const maxRetries = 2;
    let result;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      result = await this.executeProviderSurface(args, credentials);
      if (!result?.response) return result;

      if (!result.response.ok) {
        // Provider surface denied (no Provider API access, or a CLI-only id):
        // replay the same turn against the CLI endpoint before giving up — unless
        // the provider surface itself stated a serving restriction on the model,
        // which the reconnect above has already tried twice on other connections.
        // The replay is kept for the denials that are about the surface rather than
        // the model (a plan without Provider API access, an id confined to the CLI
        // lane), where the CLI lane is the lane the caller is entitled to.
        if (result.response.status === 403 || result.response.status === 404) {
          if (!(await statesModelLevelVerdict(result.response))) {
            const planDenied = await statesPlanDenial(result.response);
            // Replay the body this surface actually built, not the caller's: the
            // request transform (reasoning placeholder, template-marker escape) is
            // what makes the turn renderable, and the CLI lane renders it too.
            const fallback = await this.executeCliFallback({
              ...args,
              credentials,
              body: result.transformedBody ?? args.body,
            });
            // A serving verdict from the CLI lane is not why this turn failed when
            // the provider-surface denial was a plan/entitlement answer the caller
            // can act on: keep alpha only when it answered, when the id is absent
            // from this surface (404), or when its own error is not a serving
            // verdict. A plan denial is the opposite: it closes this surface for
            // every model, so it holds no model information, and the CLI lane — the
            // lane such a plan is entitled to — keeps the last word.
            if (fallback && (planDenied
              || fallback.response.ok
              || result.response.status === 404
              || !(await statesModelLevelVerdict(fallback.response)))) {
              return fallback;
            }
          }
        }
        return result;
      }
      if (!result.response.body) return result;

      const wrappedResponse = await inspectAndWrapCommandCodeResponse(result.response, args.model);
      if (!wrappedResponse.ok && attempt < maxRetries) {
        const isRetryableStatus = wrappedResponse.status === 502 || wrappedResponse.status === 503 || wrappedResponse.status === 504;
        if (isRetryableStatus) {
          args.log?.debug?.("RETRY", `CommandCode upstream returned status ${wrappedResponse.status}, retrying ${attempt + 1}/${maxRetries}...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }

      result.response = wrappedResponse;
      result.responseFormat = FORMATS.COMMANDCODE;
      return result;
    }
    return result;
  }

  /**
   * Provider-surface attempt with the gate reconnect. A model-level 403 is read
   * again only after the connection that produced it is gone: the verdict belongs
   * to the edge that answered (see the gate comment above), so a fresh socket is a
   * fresh draw, while the pooled one repeats the same answer.
   */
  async executeProviderSurface(args, credentials) {
    for (let gateAttempt = 0; ; gateAttempt++) {
      const result = await super.execute({
        ...args,
        credentials,
        fetchOptions: { dispatcher: await providerDispatcher() },
      });
      if (!result?.response || result.response.status !== 403) {
        if (gateAttempt > 0) {
          args.log?.debug?.("RETRY", `CommandCode gate cleared on reconnect ${gateAttempt}/${GATE_RETRIES} — the edge that rejected the first attempt owns no verdict on this model.`);
        }
        return result;
      }
      if (!(await statesModelLevelVerdict(result.response, this.provider))) return result;
      // A gated answer drops its connection either way: with a reconnect left it is
      // replaced now, and with the budget spent it must not greet the next turn.
      rotateProviderConnection();
      if (gateAttempt >= GATE_RETRIES) return result;
      args.log?.debug?.("RETRY", `CommandCode answered 403 on this connection's edge, reconnecting ${gateAttempt + 1}/${GATE_RETRIES}...`);
      await new Promise(r => setTimeout(r, GATE_RETRY_DELAY_MS));
    }
  }

  /**
   * CLI-surface replay. Returns null when the executor has no CLI URL configured
   * so the caller falls back to surfacing the provider-surface response.
   */
  async executeCliFallback({ model, body, credentials, signal, log, proxyOptions = null, providerOverrides = null }) {
    const cliUrl = this.config.cliUrl;
    if (!cliUrl) return null;

    const transformedBody = openaiToCommandCodeRequest(model, body, true, credentials);
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      ...CLI_ONLY_HEADERS,
      "x-session-id": sessionIdFor(credentials),
      "Accept": "text/event-stream",
    };
    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);

    // Mirror BaseExecutor's connect-only guard: abort when headers do not arrive
    // in time, but never abort a stream that already started.
    const connectCtrl = new AbortController();
    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

    // The replay is this provider's second draw at the same host: give it a
    // connection of its own, because the socket that answered the gate answers the
    // replay the same way. close() (not destroy()) keeps the rejection body the
    // router reports onward readable while the old socket drains.
    rotateProviderConnection();

    log?.debug?.("FETCH", `COMMANDCODE → ${cliUrl} (cli fallback) | body=${JSON.stringify(transformedBody).length}B`);
    let response;
    try {
      response = await proxyAwareFetch(cliUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(transformedBody),
        signal: mergedSignal,
        dispatcher: await providerDispatcher(),
      }, proxyOptions);
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) {
      if (await statesModelLevelVerdict(response, this.provider)) rotateProviderConnection();
      return { response, url: cliUrl, headers, transformedBody, responseFormat: FORMATS.COMMANDCODE };
    }

    const wrapped = await inspectAndWrapCommandCodeResponse(response, model);
    // This lane's verdicts follow the edge as well, so a rejected answer drops its
    // connection here too — the next attempt and the next turn then draw fresh.
    // A 200 is a live stream, not a rejection: reading it here (rejectionText
    // clones and text()s the body) buffers the whole turn and kills streaming.
    if (!wrapped.ok && (await statesModelLevelVerdict(wrapped, this.provider))) rotateProviderConnection();
    return { response: wrapped, url: cliUrl, headers, transformedBody, responseFormat: FORMATS.COMMANDCODE };
  }

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "{}");
    } catch {
      parsed = null;
    }
    const errObj = parsed?.error || parsed;
    // The CLI lane gates on the version `cmd` reports. Its wording ("Run `cmd
    // update` or `npm i -g command-code`") points the operator at a binary they do
    // not run: the version under the minimum is the one this router presents in
    // x-command-code-version, verified live (any header >= minVersion is accepted,
    // none at all is answered 403 upgrade_required). `upgrade_required` is also the
    // code a plan denial carries ("Your Go plan doesn't include API access"), and
    // the router's no-cooldown rule keys on that wording — so only a body that
    // speaks about the CLI version is rewritten here.
    const versionGate = errObj?.code === "upgrade_required"
      && (errObj.minVersion || /out of date|cmd update/i.test(errObj.message || ""));
    if (versionGate) {
      const presented = this.config?.headers?.["x-command-code-version"];
      const minimum = errObj.minVersion ? ` (minimum ${errObj.minVersion})` : "";
      return {
        status: response.status,
        message: `Command Code refuses this CLI version${minimum}; this router presents ${presented ?? "none"}. Update 9router to restore the model.`,
      };
    }
    const msg = errObj?.message || parsed?.message || bodyText || response.statusText;
    const status = Number(errObj?.code || errObj?.statusCode || response.status) || response.status;
    return {
      status,
      message: msg || `CommandCode upstream error: ${response.status}`,
    };
  }
}

/**
 * The rejection's own words — message plus code/type, or the raw body when it is
 * not JSON. Read from a clone: the caller still needs the body to report onward.
 */
async function rejectionText(response) {
  try {
    const text = await response.clone().text();
    try {
      const parsed = JSON.parse(text);
      const err = parsed?.error || parsed;
      return [err?.message, err?.code, err?.type].filter(Boolean).join(" ");
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}

/**
 * True when a rejected response states a serving restriction on the model
 * (geography, policy) rather than a denial of the surface itself.
 *
 * `provider` selects which rules may match, and the two callers want opposite
 * things. The gate reconnect asks with the provider id: the CommandCode contributor
 * rule is one of these verdicts, and the provider surface words it as a credential
 * problem ("Authentication failed. Please check your credentials.") while the CLI
 * lane words the same restriction as geography, both verified live for one key and
 * one model. The replay seam below asks without it: matching that rule there would
 * read the provider surface as a model verdict and skip the replay, so a turn the
 * CLI lane can serve would fail instead. Passing the provider id at the seam kills
 * the replay.
 */
async function statesModelLevelVerdict(response, provider = null) {
  return modelLevelError(response.status, await rejectionText(response), provider) !== null;
}

/**
 * True when the rejection says the credential's plan has no provider-API access.
 * That answer closes the provider surface for every model (verified live: one Go
 * plan gets the same 403 `upgrade_required` for muse-spark and deepseek), so it
 * says nothing about the model, and the CLI lane — the lane such a plan is
 * entitled to — keeps the last word on it.
 */
async function statesPlanDenial(response) {
  return /doesn't include api access|upgrade_required/i.test(await rejectionText(response));
}

/** Truthful status text for the error Response the router reads onward. */
function statusTextFor(statusCode) {
  const known = { 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" };
  return known[statusCode] || (statusCode >= 500 ? "Service Unavailable" : "Bad Gateway");
}

export function parseCommandCodeError(event) {
  if (!event || typeof event !== "object") {
    return {
      statusCode: 503,
      message: "CommandCode upstream error",
      type: "server_error",
    };
  }

  const errVal = event.error ?? event.message ?? "unknown";
  let message = "";
  let statusCode = null;
  let type = "server_error";

  if (typeof errVal === "object" && errVal !== null) {
    message = errVal.message || errVal.error || JSON.stringify(errVal);
    if (errVal.statusCode && Number.isInteger(Number(errVal.statusCode))) {
      statusCode = Number(errVal.statusCode);
    } else if (errVal.status && Number.isInteger(Number(errVal.status))) {
      statusCode = Number(errVal.status);
    }
    if (errVal.type) type = errVal.type;
  } else if (typeof errVal === "string") {
    message = errVal;
  } else {
    message = JSON.stringify(errVal);
  }

  if (event.statusCode && Number.isInteger(Number(event.statusCode))) {
    statusCode = Number(event.statusCode);
  }

  if (!statusCode || statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing")) {
      statusCode = 402;
      type = "billing_error";
    } else if (modelLevelError(statusCode, message)) {
      // A model the caller's plan has but the gateway refuses to serve here is a
      // permission verdict, not an upstream outage: reporting 503 made the
      // router cool the connection down and retry a call that cannot succeed.
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("quota") || lower.includes("forbidden") || lower.includes("permission")) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else if (lower.includes("unavailable") || lower.includes("overloaded") || lower.includes("server error")) {
      statusCode = 503;
      type = "server_error";
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

export async function inspectAndWrapCommandCodeResponse(originalResponse, model) {
  const reader = originalResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const rawChunks = [];
  let detectedError = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const trimmed = buffer.trim();
        if (trimmed) {
          try {
            const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            const parsed = JSON.parse(jsonStr);
            if (parsed?.type === "error") {
              detectedError = parsed;
            }
          } catch {
            /* ignore */
          }
        }
        break;
      }

      rawChunks.push(value);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let stopLoop = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!jsonStr || jsonStr === "[DONE]") {
          stopLoop = true;
          break;
        }

        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        // Provider surface speaks OpenAI chunks: an error payload is an error, and
        // the first content/finish delta means the turn is live — stop buffering so
        // the rest of the stream reaches the client as it arrives.
        if (event?.object === "chat.completion.chunk") {
          if (event.error) detectedError = event;
          stopLoop = true;
          break;
        }

        if (event?.type === "error") {
          detectedError = event;
          stopLoop = true;
          break;
        }

        if (
          event?.type === "text-delta" ||
          event?.type === "reasoning-delta" ||
          event?.type === "tool-input-start" ||
          event?.type === "tool-call" ||
          event?.type === "finish" ||
          event?.type === "finish-step"
        ) {
          stopLoop = true;
          break;
        }
      }

      if (stopLoop) break;
    }
  } catch {
    try { reader.releaseLock(); } catch { /* ignore */ }
    return originalResponse;
  }

  if (detectedError) {
    try { await reader.cancel(); } catch { /* ignore */ }
    const { statusCode, message, type } = parseCommandCodeError(detectedError);
    return new Response(
      JSON.stringify({
        error: {
          message: `[CommandCode error: ${message}]`,
          type,
          code: statusCode,
        },
      }),
      {
        status: statusCode,
        // Keep the wire text truthful: the router reports this status onward.
        statusText: statusTextFor(statusCode),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const combinedStream = createRawReplayedStream(rawChunks, reader);
  return wrapNdjsonAsOpenAISse(combinedStream, model, originalResponse);
}

function createRawReplayedStream(rawChunks, reader) {
  let chunkIndex = 0;

  return new ReadableStream({
    async pull(controller) {
      if (chunkIndex < rawChunks.length) {
        controller.enqueue(rawChunks[chunkIndex++]);
        return;
      }

      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
}

function wrapNdjsonAsOpenAISse(streamBody, model, originalResponse = null) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = streamBody.pipeThrough(transform);
  return new Response(newBody, {
    status: originalResponse?.status || 200,
    statusText: originalResponse?.statusText || "OK",
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...(originalResponse?.headers ? Object.fromEntries(originalResponse.headers.entries()) : {}),
      "content-type": "text/event-stream",
    },
  });
}

export default CommandCodeExecutor;
