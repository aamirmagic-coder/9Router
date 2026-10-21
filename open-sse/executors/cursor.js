import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import {
  generateCursorBody,
  encodeField,
  wrapConnectRPCFrame,
  decodeMessage,
  parseConnectRPCFrame,
  extractTextFromResponse,
  encodeMcpTools,
  decodeMcpArgs,
} from "../utils/cursorProtobuf.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { resolveCursorModels, resolveAutoModelSelection } from "../services/cursorModels.js";
import { estimateUsage } from "../utils/usageTracking.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { chatChunkSse, sseChunk } from "../utils/sse.js";
import { FORMATS } from "../translator/formats.js";
import { ROLE, OPENAI_BLOCK } from "../translator/schema/index.js";
import { proxyAwareFetch, resolveOutboundProxyUrl } from "../utils/proxyFetch.js";
import { connectHttp2 } from "../utils/http2Connect.js";
import zlib from "zlib";
import crypto from "crypto";

function maskProxyUrl(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "proxy";
  }
}

// Detect cloud environment
const isCloudEnv = () => {
  if (typeof caches !== "undefined" && typeof caches === "object") return true;
  if (typeof EdgeRuntime !== "undefined") return true;
  return false;
};

// Lazy import http2 (only in Node.js environment)
let http2 = null;
if (!isCloudEnv()) {
  try {
    http2 = await import("http2");
  } catch {
    // http2 not available
  }
}

const COMPRESS_FLAG = {
  NONE: 0x00,
  GZIP: 0x01,
  TRAILER: 0x02,
  GZIP_TRAILER: 0x03
};

const AGENT_RUN_PATH = "/agent.v1.AgentService/Run";
const PROTOBUF_LEN = 2;
const PROTOBUF_VARINT = 0;

function concatBuffers(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const agentString = (field, value) => encodeField(field, PROTOBUF_LEN, value);
const agentMessage = (field, value) => encodeField(field, PROTOBUF_LEN, value);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === OPENAI_BLOCK.TEXT && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function isTextPart(part) {
  return !part || part.type === OPENAI_BLOCK.TEXT || typeof part === "string";
}

export function isAgentCapableRequest(body) {
  // ChatService rejects auto/composer and most thinking variants. AgentService
  // can answer text turns (including declared tool schemas) and tool-call
  // history. Image parts still need the legacy protobuf path.
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return false;
  return body.messages.every((message) => {
    if (Array.isArray(message?.content)) return message.content.every(isTextPart);
    return message?.content == null || typeof message.content === "string";
  });
}

function encodeHistoryMessage(message) {
  const content = textFromContent(message?.content);
  const extras = [];
  if (message?.role === ROLE.ASSISTANT && message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      extras.push(`[tool_call id=${tc.id || ""} name=${tc.function?.name || "tool"} args=${tc.function?.arguments || "{}"}]`);
    }
  }
  if (message?.role === ROLE.TOOL) {
    extras.push(`[tool_result id=${message.tool_call_id || ""}]`);
  }
  const textBody = [content, ...extras].filter(Boolean).join("\n");
  if (!textBody) return null;

  // ConversationHistoryMessage.user / .assistant -> repeated content -> text.
  const text = agentString(1, textBody);
  if (message.role === ROLE.ASSISTANT) {
    return agentMessage(2, agentMessage(1, agentMessage(1, text)));
  }
  return agentMessage(1, agentMessage(1, agentMessage(1, text)));
}

// Effort / thinking / fast suffixes on Cursor picker ids are ModelParameter
// entries, not part of model_id. Sending `claude-4.5-opus-high-thinking` as the
// id makes AgentService accept the RPC and stream an empty turn.
const CURSOR_EFFORT_SUFFIXES = ["xhigh", "medium", "high", "low", "max", "minimal", "ultra"];

function encodeModelParameter(id, value) {
  return agentMessage(3, concatBuffers(agentString(1, id), agentString(2, value)));
}

function normalizeBodyEffort(reasoningEffort) {
  const bodyEffort = String(reasoningEffort || "").toLowerCase();
  if (!bodyEffort || bodyEffort === "none") return null;
  if (bodyEffort === "ultra") return "max";
  if (bodyEffort === "minimal") return "low";
  return bodyEffort;
}

function idHasEffortToken(id) {
  return CURSOR_EFFORT_SUFFIXES.some((effort) => (
    id.endsWith(`-${effort}`) || id.includes(`-${effort}-`)
  ));
}

/**
 * Split a Cursor picker id into the base AgentService model_id plus parameters.
 * Claude/Gemini/Grok/Composer use `effort`; GPT uses `reasoning`. `-thinking`
 * and Composer/Fable `-fast` become toggles. Opus/GPT/Grok `*-fast` catalog
 * ids stay intact.
 *
 * Catalog rules (live GetUsableModels):
 * 1. Exact id listed → send verbatim (Cursor often lists effort tiers as full ids).
 * 2. Else strip suffixes only when the resulting base is listed.
 * 3. Else keep the original id — inventing a base that is not usable yields an
 *    empty AgentService turn (seen with gpt-5.6-luna-medium / cursor-grok-*).
 */
export function resolveRequestedModel(modelId, reasoningEffort = null, catalogIds = null) {
  const original = String(modelId || "").trim().split("/").pop() || "";
  const bodyValue = normalizeBodyEffort(reasoningEffort);
  let id = original === "auto" ? "default" : original;

  const attachBodyEffort = (model, params) => {
    if (bodyValue && !idHasEffortToken(model) && !params.some((p) => p.id === "effort" || p.id === "reasoning")) {
      params.push({ id: /gpt-/i.test(model) ? "reasoning" : "effort", value: bodyValue });
    }
    return params;
  };

  // Exact catalog hit: the account's usable list is authoritative.
  if (catalogIds instanceof Set && catalogIds.has(id)) {
    return { modelId: id, parameters: attachBodyEffort(id, []) };
  }

  const parameters = [];
  let working = id;

  // Strip -thinking before effort so `…-high-thinking` becomes base + both params.
  if (working.endsWith("-thinking")) {
    working = working.slice(0, -"-thinking".length);
    parameters.push({ id: "thinking", value: "true" });
  }

  // Composer / Fable `-fast` is a parameter; other families keep catalog `*-fast` ids.
  if (
    (working.startsWith("composer-") || /claude-fable/i.test(working))
    && working.endsWith("-fast")
  ) {
    working = working.slice(0, -"-fast".length);
    parameters.push({ id: "fast", value: "true" });
  }

  let effortFromId = null;
  for (const effort of CURSOR_EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (working.length > suffix.length && working.endsWith(suffix)) {
      working = working.slice(0, -suffix.length);
      effortFromId = effort === "ultra" ? "max" : effort === "minimal" ? "low" : effort;
      break;
    }
  }

  const stripped = working !== id || parameters.length > 0;
  // Catalog-aware strip:
  // - exact id already handled above
  // - strip only when the resulting base is listed as usable
  // - empty Set = live fetch failed/empty → keep original (invented bases empty-turn)
  // - null catalogIds = unit-test / offline path → allow legacy strip
  if (stripped && catalogIds instanceof Set && (catalogIds.size === 0 || !catalogIds.has(working))) {
    return { modelId: id, parameters: attachBodyEffort(id, []) };
  }

  if (effortFromId) {
    parameters.push({ id: /gpt-/i.test(working) ? "reasoning" : "effort", value: effortFromId });
  } else {
    attachBodyEffort(working, parameters);
  }

  return { modelId: working, parameters };
}

export function buildAgentRunFrame(messages, model, tools = [], reasoningEffort = null, catalogIds = null) {
  // custom_system_prompt (RunRequest field 8) makes AgentService return an
  // empty turn. Fold system text into the current user message instead.
  const system = messages
    .filter((message) => message?.role === ROLE.SYSTEM)
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const chatMessages = messages.filter((message) => message?.role !== ROLE.SYSTEM);
  const currentIndex = [...chatMessages].map((message) => message?.role).lastIndexOf(ROLE.USER);
  const current = currentIndex >= 0 ? chatMessages[currentIndex] : chatMessages.at(-1);
  const history = chatMessages
    .slice(0, currentIndex >= 0 ? currentIndex : -1)
    .map(encodeHistoryMessage)
    .filter(Boolean);
  const rawUser = textFromContent(current?.content) || "Continue.";
  const userText = system ? `${system}\n\n${rawUser}` : rawUser;

  // agent.v1.UserMessageAction.user_message and its optional history.
  // selected_context (3) + mode=1 (4) match cursor-agent's wire format; without
  // them the server may accept the RPC and stream an empty turn.
  const userMessage = concatBuffers(
    agentString(1, userText),
    agentString(2, crypto.randomUUID()),
    agentMessage(3, new Uint8Array()),
    encodeField(4, PROTOBUF_VARINT, 1),
  );
  const conversationHistory = history.length
    ? concatBuffers(...history.map((entry) => agentMessage(1, entry)))
    : null;
  const userAction = concatBuffers(
    agentMessage(1, userMessage),
    ...(conversationHistory ? [agentMessage(7, conversationHistory)] : []),
  );
  const conversationAction = agentMessage(1, userAction);

  const { modelId, parameters } = resolveRequestedModel(model, reasoningEffort, catalogIds);
  // RequestedModel: model_id (1) + parameters (3). Field 7 is Bedrock credentials,
  // not max_mode — writing a bool there yields empty turns on Claude/GPT.
  const requestedModel = concatBuffers(
    agentString(1, modelId),
    ...parameters.map((param) => encodeModelParameter(param.id, param.value)),
  );
  // ModelDetails (field 3): thinking variants (Composer, Grok, *-thinking)
  // return an empty turn when only RequestedModel (field 9) is set. Use the
  // resolved base id so the server can match the catalog entry.
  const modelDetails = concatBuffers(
    agentString(1, modelId),
    agentString(3, modelId),
    agentString(4, modelId),
  );
  const mcpTools = encodeMcpTools(tools);
  const runRequest = concatBuffers(
    // An empty ConversationStateStructure starts a fresh local agent session.
    agentMessage(1, new Uint8Array()),
    agentMessage(2, conversationAction),
    agentMessage(3, modelDetails),
    ...(mcpTools.length ? [agentMessage(4, mcpTools)] : []),
    agentMessage(9, requestedModel),
  );

  // agent.v1.AgentClientMessage.run_request.
  return wrapConnectRPCFrame(agentMessage(1, runRequest));
}

function extractAgentString(message, field) {
  const value = message?.get(field)?.[0]?.value;
  return value ? Buffer.from(value).toString("utf8") : "";
}

function decodeAgentFrames(buffer, onFrame) {
  let pending = Buffer.from(buffer || []);
  while (pending.length >= 5) {
    const flags = pending[0];
    const length = pending.readUInt32BE(1);
    if (pending.length < 5 + length) break;
    let payload = pending.subarray(5, 5 + length);
    pending = pending.subarray(5 + length);
    if (flags & COMPRESS_FLAG.GZIP) {
      payload = zlib.gunzipSync(payload);
    }
    if (!(flags & COMPRESS_FLAG.TRAILER)) onFrame(payload);
  }
  return pending;
}

function execIds(execRequest) {
  const id = Number(execRequest?.get(1)?.[0]?.value || 0);
  const execId = extractAgentString(execRequest, 15);
  return { id, execId };
}

function wrapExecClientMessage(execMsgId, execId, resultField, resultPayload) {
  const parts = [];
  if (execMsgId) parts.push(encodeField(1, PROTOBUF_VARINT, execMsgId));
  parts.push(agentString(15, execId || ""));
  parts.push(encodeField(resultField, PROTOBUF_LEN, resultPayload || new Uint8Array()));
  return wrapConnectRPCFrame(agentMessage(2, concatBuffers(...parts)));
}

function createRequestContextResponse(execRequest) {
  // Tools already go out on AgentRunRequest.mcp_tools. Echoing them again on
  // this ack makes AgentService stall silently (0 SSE bytes until abort).
  const { id, execId } = execIds(execRequest);
  const requestContextSuccess = agentMessage(1, new Uint8Array());
  const requestContextResult = agentMessage(1, requestContextSuccess);
  return wrapExecClientMessage(id, execId, 10, requestContextResult);
}

// ExecServerMessage variant → ExecClientMessage result field (same numbers).
const EXEC_RESULT_FIELD = {
  2: 2, 3: 3, 4: 4, 5: 5, 7: 7, 8: 8, 9: 9, 16: 16, 20: 20, 23: 23,
};

function rejectExecRequest(execRequest) {
  const { id, execId } = execIds(execRequest);
  const variant = [...(execRequest?.keys?.() || [])].find((field) => field !== 1 && field !== 15);
  const resultField = EXEC_RESULT_FIELD[variant];
  if (!resultField) return null;
  // Diagnostics has no rejected variant — empty success unblocks the stream.
  if (variant === 9) return wrapExecClientMessage(id, execId, 9, new Uint8Array());
  const rejected = agentMessage(2, agentString(2, "Tool not available in this environment. Use the MCP tools provided instead."));
  return wrapExecClientMessage(id, execId, resultField, rejected);
}

export function encodeKvClientMessage(kvId, resultField, resultPayload, metadata) {
  const parts = [];
  // Proto3: omit id when the server did not send one (do not write id=0).
  if (kvId) parts.push(encodeField(1, PROTOBUF_VARINT, kvId));
  parts.push(encodeField(resultField, PROTOBUF_LEN, resultPayload || new Uint8Array()));
  if (metadata && metadata.length) parts.push(encodeField(4, PROTOBUF_LEN, metadata));
  return wrapConnectRPCFrame(agentMessage(3, concatBuffers(...parts)));
}

function blobIdKey(blobIdBytes) {
  if (!blobIdBytes || typeof blobIdBytes === "number") return "";
  return Buffer.from(blobIdBytes).toString("hex");
}

// Strict pools must never silently fall back to a direct socket (#4333).
// With HTTP/2 CONNECT tunneling a resolved connection proxy is honored; fail
// closed when a bound pool/connection is intended but has no usable URL.
// Env HTTP_PROXY must not count as "honoring" a drained connection pool.
function proxyIntentFailed(targetUrl, proxyOptions) {
  if (proxyOptions?.strictProxy !== true) return false;
  // A vercel/cloudflare-style relay rides on plain fetch, not this h2 path.
  if (proxyOptions?.vercelRelayUrl) return false;

  const connectionEnabled = proxyOptions?.enabled === true
    || proxyOptions?.connectionProxyEnabled === true;
  const hasPoolId = Boolean(proxyOptions?.proxyPoolId);
  const explicitUrl = (proxyOptions?.url || proxyOptions?.connectionProxyUrl || "").trim();
  const proxyIntended = hasPoolId || connectionEnabled || explicitUrl.length > 0;
  if (!proxyIntended) return false;

  // Bound pool/connection: only the explicit connection URL honors the pool.
  if (hasPoolId || connectionEnabled) {
    return !explicitUrl || !resolveOutboundProxyUrl(targetUrl, {
      ...proxyOptions,
      enabled: true,
      connectionProxyEnabled: true,
      url: explicitUrl || proxyOptions?.url,
      connectionProxyUrl: explicitUrl || proxyOptions?.connectionProxyUrl,
    });
  }

  return !resolveOutboundProxyUrl(targetUrl, proxyOptions);
}

const CURSOR_STREAM_DEBUG = process.env.CURSOR_STREAM_DEBUG === "1";
const debugLog = (...args) => {
  if (CURSOR_STREAM_DEBUG) console.log(...args);
};

function isComposerModel(model) {
  const modelId = String(model || "").split("/").pop();
  return /^composer(?:-|$)/i.test(modelId);
}

function visibleComposerContentFromThinking(thinking) {
  if (!thinking) return "";
  const endTag = "</think>";
  const endIdx = thinking.lastIndexOf(endTag);
  if (endIdx < 0) return "";
  return thinking.slice(endIdx + endTag.length).trimStart();
}

function composerReasoningFromThinking(thinking) {
  if (!thinking) return "";
  const endTag = "</think>";
  const endIdx = thinking.lastIndexOf(endTag);
  if (endIdx < 0) return thinking;
  return thinking.slice(0, endIdx);
}

function decompressPayload(payload, flags) {
  // Check if payload is JSON error (starts with {"error")
  if (payload.length > 10 && payload[0] === 0x7b && payload[1] === 0x22) {
    try {
      const text = payload.toString("utf-8");
      if (text.startsWith('{"error"')) {
        debugLog(`[DECOMPRESS] Detected JSON error, skipping decompression`);
        return payload;
      }
    } catch {}
  }

  if (
    flags === COMPRESS_FLAG.GZIP ||
    flags === COMPRESS_FLAG.TRAILER ||
    flags === COMPRESS_FLAG.GZIP_TRAILER
  ) {
    // Primary: try gzip decompression (standard gzip header 0x1f 0x8b)
    try {
      return zlib.gunzipSync(payload);
    } catch (gzipErr) {
      // Fallback: TRAILER and GZIP_TRAILER frames sometimes use raw zlib deflate format
      try {
        return zlib.inflateSync(payload);
      } catch (deflateErr) {
        // Last resort: try raw deflate (no zlib header)
        try {
          return zlib.inflateRawSync(payload);
        } catch (rawErr) {
          debugLog(
            `[DECOMPRESS ERROR] flags=${flags}, payloadSize=${payload.length}, gzip=${gzipErr.message}, deflate=${deflateErr.message}, raw=${rawErr.message}`
          );
          debugLog(
            `[DECOMPRESS ERROR] First 50 bytes (hex):`,
            payload.slice(0, 50).toString("hex")
          );
          return payload;
        }
      }
    }
  }
  return payload;
}

// Read one cursor protobuf frame: header + bounds + decompress. Returns status + payload + new offset.
function readCursorFrame(buffer, offset, frameNum, tag) {
  if (offset + 5 > buffer.length) {
    debugLog(`[CURSOR BUFFER${tag}] Reached end, offset=${offset}, remaining=${buffer.length - offset}`);
    return { status: "done" };
  }

  const flags = buffer[offset];
  const length = buffer.readUInt32BE(offset + 1);
  debugLog(`[CURSOR BUFFER${tag}] Frame ${frameNum + 1}: flags=0x${flags.toString(16).padStart(2, "0")}, length=${length}`);

  if (offset + 5 + length > buffer.length) {
    debugLog(`[CURSOR BUFFER${tag}] Incomplete frame, offset=${offset}, length=${length}, buffer.length=${buffer.length}`);
    return { status: "done" };
  }

  let payload = buffer.slice(offset + 5, offset + 5 + length);
  const newOffset = offset + 5 + length;
  payload = decompressPayload(payload, flags);
  if (!payload) {
    debugLog(`[CURSOR BUFFER${tag}] Frame ${frameNum + 1}: decompression failed, skipping`);
    return { status: "skip", offset: newOffset };
  }
  return { status: "ok", payload, offset: newOffset };
}

function createErrorResponse(jsonError) {
  const errorMsg = jsonError?.error?.details?.[0]?.debug?.details?.title
    || jsonError?.error?.details?.[0]?.debug?.details?.detail
    || jsonError?.error?.message
    || "API Error";
  
  const isRateLimit = jsonError?.error?.code === "resource_exhausted";
  
  return new Response(JSON.stringify({
    error: {
      message: errorMsg,
      type: isRateLimit ? "rate_limit_error" : "api_error",
      code: jsonError?.error?.details?.[0]?.debug?.error || "unknown"
    }
  }), {
    status: isRateLimit ? HTTP_STATUS.RATE_LIMITED : HTTP_STATUS.BAD_REQUEST,
    headers: { "Content-Type": "application/json" }
  });
}

// Long-session empty-turn recovery: Cursor occasionally answers a long
// history replay with HTTP 200 and zero deltas (empty turn). One retry on a
// tail-only frame recovers the session instead of failing the client turn.
const CURSOR_EMPTY_TURN_MAX_RETRIES = (() => {
  const value = Number(process.env.CURSOR_EMPTY_TURN_MAX_RETRIES);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
})();

const CURSOR_TAIL_ONLY_THRESHOLD = (() => {
  const value = Number(process.env.CURSOR_TAIL_ONLY_THRESHOLD);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 80;
})();

const CURSOR_EMPTY_TURN_RETRY_DELAY_MS = (() => {
  const value = Number(process.env.CURSOR_EMPTY_TURN_RETRY_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 400;
})();

/** Minimal tail for wedged long sessions — drops bulk history and tool XML. */
export function tailOnlyCursorMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];
  const systemMessages = messages.filter(
    (message) => message?.role === ROLE.SYSTEM && !String(message?.content || "").includes("[9router]"),
  );
  const chatMessages = messages.filter((message) => message?.role !== ROLE.SYSTEM);
  let anchor = chatMessages.length - 1;
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i]?.role === ROLE.USER || chatMessages[i]?.role === ROLE.TOOL) {
      anchor = i;
      break;
    }
  }
  const tailStart = anchor > 0 && chatMessages[anchor - 1]?.role === ROLE.ASSISTANT ? anchor - 1 : anchor;
  const tail = chatMessages.slice(Math.max(0, tailStart));
  const note = {
    role: ROLE.SYSTEM,
    content: `[9router] Long session: ${messages.length} messages trimmed to the latest turn. Answer the current request; re-read files if needed.`,
  };
  return [...systemMessages, note, ...tail];
}

/**
 * Retry an empty AgentService turn only when a long-session replay is the
 * likely cause: upstream accepts the request, streams HTTP 200, and closes
 * with zero deltas. A first-message empty turn is a protocol condition, not
 * a wedged replay, and must surface to the client without retry.
 */
function shouldRetryEmptyTurn(messageCount) {
  return messageCount >= CURSOR_TAIL_ONLY_THRESHOLD;
}

export class CursorExecutor extends BaseExecutor {
  constructor() {
    super("cursor", PROVIDERS.cursor);
  }

  buildUrl() {
    return `${this.config.baseUrl}${this.config.chatPath}`;
  }

  buildHeaders(credentials) {
    const accessToken = credentials.accessToken;
    const machineId = credentials.providerSpecificData?.machineId;
    const ghostMode = credentials.providerSpecificData?.ghostMode !== false;

    if (!machineId) {
      throw new Error("Machine ID is required for Cursor API");
    }

    return buildCursorHeaders(accessToken, machineId, ghostMode);
  }

  transformRequest(model, body, stream, credentials) {
    // Messages are already translated by chatCore (claude→openai→cursor)
    // Do NOT call openaiToCursorRequest again — double-translation drops tool_results
    const messages = body.messages || [];
    const tools = body.tools || [];
    const reasoningEffort = body.reasoning_effort || null;
    // Detect Claude Code UA to force Agent mode (issue #643)
    const ua = credentials?.rawHeaders?.["user-agent"] || "";
    const forceAgentMode = ua.includes("claude-cli") || ua.includes("claude-code") || ua.includes("Claude Code");
    return generateCursorBody(messages, model, tools, reasoningEffort, forceAgentMode);
  }

  async makeFetchRequest(url, headers, body, signal, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body,
      signal
    }, proxyOptions);

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer())
    };
  }

  makeHttp2Request(url, headers, body, signal) {
    if (!http2) {
      throw new Error("http2 module not available");
    }

    const HTTP2_TIMEOUT_MS = 60000; // 60s max — prevent hung sessions

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = http2.connect(`https://${urlObj.host}`);
      const chunks = [];
      let responseHeaders = {};
      let settled = false;

      // Ensure client is always closed on settle
      const finish = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        clearTimeout(hangTimeout);
        client.close();
        fn(...args);
      };

      // Hard timeout: close session if server never responds
      const hangTimeout = setTimeout(finish(() => {
        reject(new Error("HTTP/2 request timed out"));
      }), HTTP2_TIMEOUT_MS);

      client.on("error", finish(reject));

      const req = client.request({
        ":method": "POST",
        ":path": urlObj.pathname,
        ":authority": urlObj.host,
        ":scheme": "https",
        ...headers
      });

      req.on("response", (hdrs) => { responseHeaders = hdrs; });
      req.on("data", (chunk) => { chunks.push(chunk); });
      req.on("end", finish(() => {
        resolve({
          status: responseHeaders[":status"],
          headers: responseHeaders,
          body: Buffer.concat(chunks)
        });
      }));
      req.on("error", finish(reject));

      if (signal) {
        const onAbort = finish(() => reject(new Error("Request aborted")));
        signal.addEventListener("abort", onAbort, { once: true });
      }

      req.write(body);
      req.end();
    });
  }

  /**
   * AgentService (agent.api5.cursor.sh) is HTTP/2-only. Node's fetch/undici speaks
   * HTTP/1.1 and fails with HTTPParserError on the h2 preface — use http2 duplex,
   * optionally tunneled through CONNECT/SOCKS so strict proxy pools are honored.
   */
  async openAgentHttp2Stream(url, headers, signal, proxyOptions = null) {
    if (!http2) {
      throw new Error("HTTP/2 is required for Cursor AgentService (endpoint is h2-only)");
    }

    const urlObj = new URL(url);
    const proxyUrl = resolveOutboundProxyUrl(url, proxyOptions);
    if (proxyUrl) {
      console.info("CURSOR_AGENT", `Run via HTTP/2 proxy ${maskProxyUrl(proxyUrl)}`);
    }
    const client = await connectHttp2(url, { proxyUrl });
    const chunkQueue = [];
    let waiting = null;
    let ended = false;
    let streamError = null;
    let req = null;

    const wake = (result) => {
      if (!waiting) return;
      const resolve = waiting;
      waiting = null;
      resolve(result);
    };

    const fail = (error) => {
      if (streamError) return;
      streamError = error;
      ended = true;
      wake(null);
    };

    const close = () => {
      try { req?.destroy(); } catch {}
      try { client.close(); } catch {}
    };

    client.on("error", fail);

    req = client.request({
      ":method": "POST",
      ":path": urlObj.pathname,
      ":authority": urlObj.host,
      ":scheme": "https",
      ...headers,
    });

    req.on("error", fail);
    req.on("data", (chunk) => {
      if (waiting) wake({ value: chunk, done: false });
      else chunkQueue.push(chunk);
    });
    req.on("end", () => {
      ended = true;
      wake({ value: undefined, done: true });
    });

    if (signal) {
      const onAbort = () => {
        fail(new Error("Request aborted"));
        close();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const responseHeaders = new Promise((resolve, reject) => {
      const onEarlyError = (error) => reject(error);
      client.once("error", onEarlyError);
      req.once("error", onEarlyError);
      req.once("response", (hdrs) => {
        client.off("error", onEarlyError);
        req.off("error", onEarlyError);
        resolve(hdrs);
      });
    });

    return {
      responseHeaders,
      write(frame) {
        if (req && !req.destroyed) req.write(Buffer.from(frame));
      },
      end() {
        try { if (req && !req.destroyed) req.end(); } catch {}
      },
      close,
      async read() {
        if (chunkQueue.length) return { value: chunkQueue.shift(), done: false };
        if (ended) {
          if (streamError) throw streamError;
          return { value: undefined, done: true };
        }
        const result = await new Promise((resolve) => { waiting = resolve; });
        if (streamError) throw streamError;
        return result || { value: undefined, done: true };
      },
    };
  }

  async executeAgent({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const agentEndpoint = PROVIDER_OAUTH.cursor?.agentEndpoint;
    if (!agentEndpoint) throw new Error("Cursor AgentService endpoint is not configured");

    const url = `${agentEndpoint}${AGENT_RUN_PATH}`;
    // Policy guard: strict proxy intended but unresolved → fail closed rather
    // than leak the real IP on a direct socket. A resolved proxy rides CONNECT.
    if (proxyIntentFailed(url, proxyOptions)) {
      throw new Error(
        "Cursor AgentService requires a strict proxy that this HTTP/2 transport cannot honor; refusing to open a direct connection"
      );
    }

    const headers = this.buildHeaders(credentials);
    const requestController = new AbortController();
    if (signal?.addEventListener) {
      signal.addEventListener("abort", () => requestController.abort(signal.reason), { once: true });
    }

    // Empty-turn recovery works on the original client history so each retry
    // re-derives its own frame from a clean base (original vs tail-only).
    const originalMessages = body.messages || [];
    let workingMessages = originalMessages;
    const tools = body.tools || [];
    // Live catalog: resolve auto/default, and keep exact usable-model ids
    // (including effort tiers) instead of blindly stripping suffixes.
    // Always pass a Set (possibly empty) so a failed GetUsableModels does not
    // fall back to inventing stripped bases that AgentService empty-turns.
    const catalog = await resolveCursorModels(credentials, { signal, log, proxyOptions });
    const catalogIds = new Set((catalog?.models || []).map((entry) => entry.id));
    let runModel = model;
    if (model === "default" || model === "auto") {
      const selection = resolveAutoModelSelection(catalog?.models);
      if (selection) {
        log?.info?.("CURSOR", `auto model resolved: ${model} → ${selection.modelId} (${selection.matchedBy})`);
        runModel = selection.modelId;
      }
    }

    // Request-scoped blob store for AgentService KV get/set. Claude/GPT/Gemini
    // wait on this handshake; answering get with empty bytes leaves heartbeats only.
    const blobStore = new Map();

    const openAgentSession = async (frameMessages) => {
      const session = await this.openAgentHttp2Stream(url, headers, requestController.signal, proxyOptions);
      session.write(buildAgentRunFrame(
        frameMessages,
        runModel,
        tools,
        body.reasoning_effort || body.reasoning?.effort,
        catalogIds,
      ));
      return session;
    };

    let session;
    try {
      session = await openAgentSession(workingMessages);
    } catch (error) {
      throw new Error(`Cursor AgentService request failed: ${error.message}`);
    }
    let responseHeaders;
    try {
      responseHeaders = await session.responseHeaders;
    } catch (error) {
      session.close();
      throw new Error(`Cursor AgentService request failed: ${error.message}`);
    }

    const status = Number(responseHeaders[":status"] || 0);
    if (status !== 200) {
      let errorText = "";
      try {
        while (true) {
          const { done, value } = await session.read();
          if (done) break;
          errorText += Buffer.from(value).toString("utf8");
        }
      } catch {}
      session.close();
      return {
        response: new Response(JSON.stringify({
          error: { message: `Cursor AgentService ${status}: ${errorText || "request failed"}`, type: "api_error" },
        }), { status: status || HTTP_STATUS.SERVER_ERROR, headers: { "Content-Type": "application/json" } }),
        url,
        headers,
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    // The Claude SSE translator derives Anthropic's message ID by stripping
    // `chatcmpl-`. Keep the remaining ID in Anthropic's required `msg_` form
    // so strict clients such as Claude Code accept the completed stream.
    const responseId = `chatcmpl-msg_${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const composerModel = isComposerModel(runModel);
    let pending = Buffer.alloc(0);
    let finished = false;
    let thinkingAcc = "";
    let emittedVisible = 0;
    let emittedReasoning = 0;
    let emittedText = false;
    let emittedToolCall = false;

    const flushThinkingFallback = (onEvent) => {
      if (emittedText || !thinkingAcc) return;
      const fallback = composerModel
        ? visibleComposerContentFromThinking(thinkingAcc)
        : thinkingAcc.trim();
      if (fallback) {
        emittedText = true;
        onEvent({ type: "text", value: fallback });
      }
    };

    const consume = async (onEvent) => {
      const finishTurn = () => {
        flushThinkingFallback(onEvent);
        finished = true;
        if (emittedText || emittedToolCall) onEvent({ type: "done" });
        else onEvent({ type: "error", value: "Cursor AgentService returned an empty turn" });
      };
      try {
        while (!finished) {
          const { done, value } = await session.read();
          if (done) break;
          pending = Buffer.concat([pending, Buffer.from(value)]);
          pending = decodeAgentFrames(pending, (payload) => {
            // A single read can carry several frames; once the turn is over the
            // rest of the batch must not reach the already-closed controller.
            if (finished) return;
            const serverMessage = decodeMessage(payload);

            // agent.v1.AgentServerMessage.interaction_update
            if (serverMessage.has(1)) {
              const update = decodeMessage(serverMessage.get(1)[0].value);
              if (update.has(1)) {
                const textDelta = extractAgentString(decodeMessage(update.get(1)[0].value), 1);
                if (textDelta) {
                  emittedText = true;
                  onEvent({ type: "text", value: textDelta });
                }
              }
              // thinking_delta (field 4). Composer puts the visible answer after
              // </think> and reasoning before it; Grok often only sends this field.
              if (update.has(4)) {
                const thinkingDelta = extractAgentString(decodeMessage(update.get(4)[0].value), 1);
                if (thinkingDelta) {
                  thinkingAcc += thinkingDelta;
                  if (composerModel) {
                    const reasoning = composerReasoningFromThinking(thinkingAcc);
                    if (reasoning.length > emittedReasoning) {
                      const reasoningDelta = reasoning.slice(emittedReasoning);
                      emittedReasoning = reasoning.length;
                      if (reasoningDelta) onEvent({ type: "thinking", value: reasoningDelta });
                    }
                    const visible = visibleComposerContentFromThinking(thinkingAcc);
                    if (visible.length > emittedVisible) {
                      const deltaContent = visible.slice(emittedVisible);
                      emittedVisible = visible.length;
                      emittedText = true;
                      onEvent({ type: "text", value: deltaContent });
                    }
                  }
                }
              }
              if (update.has(14)) {
                finishTurn();
              }
            }

            // KvServerMessage (field 4): get/set blob. Store set payloads and
            // return them on get so Claude/GPT/Gemini can continue the turn.
            if (serverMessage.has(4)) {
              const kv = decodeMessage(serverMessage.get(4)[0].value);
              const kvId = kv.get(1)?.[0]?.value || 0;
              const metadata = kv.get(4)?.[0]?.value || null;
              if (kv.has(2)) {
                const getArgs = decodeMessage(kv.get(2)[0].value);
                const key = blobIdKey(getArgs.get(1)?.[0]?.value);
                const blobData = (key && blobStore.get(key)) || new Uint8Array();
                session.write(encodeKvClientMessage(kvId, 2, agentMessage(1, blobData), metadata));
              } else if (kv.has(3)) {
                const setArgs = decodeMessage(kv.get(3)[0].value);
                const key = blobIdKey(setArgs.get(1)?.[0]?.value);
                const blobData = setArgs.get(2)?.[0]?.value;
                if (key && blobData && typeof blobData !== "number") {
                  blobStore.set(key, Buffer.from(blobData));
                }
                session.write(encodeKvClientMessage(kvId, 3, new Uint8Array(), metadata));
              }
            }

            // AgentService requests IDE context before producing a response.
            if (serverMessage.has(2)) {
              const execRequest = decodeMessage(serverMessage.get(2)[0].value);
              if (execRequest.has(10)) {
                log?.info?.("CURSOR", "AgentService request_context ack");
                session.write(createRequestContextResponse(execRequest));
              } else if (execRequest.has(11)) {
                const mcp = decodeMcpArgs(execRequest.get(11)[0].value);
                const name = mcp.toolName || mcp.name;
                if (name) {
                  log?.info?.("CURSOR", `AgentService MCP tool_call ${name}`);
                  emittedToolCall = true;
                  finished = true;
                  onEvent({
                    type: "tool_call",
                    value: {
                      id: mcp.toolCallId || `call_${crypto.randomUUID()}`,
                      name,
                      arguments: JSON.stringify(mcp.args || {}),
                    },
                  });
                  onEvent({ type: "done", finishReason: "tool_calls" });
                } else {
                  debugLog(`[CURSOR AGENT] Unsupported exec request fields: ${[...execRequest.keys()].join(",")}`);
                  finished = true;
                  onEvent({ type: "error", value: "Cursor AgentService requested an unsupported IDE tool" });
                }
              } else {
                // Auto/Composer often probe IDE builtins (shell/read/…). Reject
                // them so the model can continue with MCP tools or a text answer
                // instead of stalling the h2 stream.
                const rejection = rejectExecRequest(execRequest);
                if (rejection) {
                  log?.info?.("CURSOR", `AgentService rejected IDE exec fields=${[...execRequest.keys()].join(",")}`);
                  session.write(rejection);
                } else {
                  debugLog(`[CURSOR AGENT] Unsupported exec request fields: ${[...execRequest.keys()].join(",")}`);
                  finished = true;
                  onEvent({ type: "error", value: "Cursor AgentService requested an unsupported IDE tool" });
                }
              }
            }
          });
        }
        if (!finished) finishTurn();
      } finally {
        try { session.end(); } catch {}
        try { session.close(); } catch {}
      }
    };

    // One AgentService attempt on the current working frame. Returns sawContent
    // so the retry policy can tell a wedged long replay from a protocol empty.
    const runAgentTurn = async (onEvent) => {
      finished = false;
      emittedText = false;
      emittedToolCall = false;
      thinkingAcc = "";
      emittedVisible = 0;
      emittedReasoning = 0;
      pending = Buffer.alloc(0);
      await consume(onEvent);
      return { sawContent: emittedText || emittedToolCall };
    };

    // Wrap events so we never retry once real output has reached the client.
    let outputStarted = false;
    const makeWrappedEvent = (onEvent) => (event) => {
      if (event.type === "text" || event.type === "thinking" || event.type === "tool_call") outputStarted = true;
      onEvent(event);
    };

    // Retry loop: fresh h2 session per attempt. An empty turn on a long replay
    // swaps to a tail-only frame; any other failure surfaces immediately.
    // While a retry is still available the empty-turn error event is withheld:
    // emitting it would close the SSE stream before recovery can run.
    const runWithRetry = async (onEvent) => {
      outputStarted = false;
      const wrapped = makeWrappedEvent(onEvent);
      let attempt = 0;
      for (;;) {
        let turnError = null;
        const result = await runAgentTurn((event) => {
          if (event.type === "error") turnError = event;
          else wrapped(event);
        });
        if (turnError && shouldRetryEmptyTurn(originalMessages.length) && !outputStarted && attempt < CURSOR_EMPTY_TURN_MAX_RETRIES && !requestController.signal.aborted) {
          attempt++;
          log?.info?.("CURSOR", `empty_turn on ${originalMessages.length}-message session; retry ${attempt}/${CURSOR_EMPTY_TURN_MAX_RETRIES} with tail-only frame`);
          workingMessages = tailOnlyCursorMessages(originalMessages);
          session = await openAgentSession(workingMessages);
          const retryHeaders = await session.responseHeaders;
          const retryStatus = Number(retryHeaders[":status"] || 0);
          if (retryStatus !== 200) {
            wrapped(turnError);
            return result;
          }
          await new Promise((resolve) => setTimeout(resolve, CURSOR_EMPTY_TURN_RETRY_DELAY_MS));
          continue;
        }
        if (turnError) wrapped(turnError);
        return result;
      }
    };

    if (stream === false) {
      let content = "";
      let reasoning = "";
      let agentError = null;
      const toolCalls = [];
      let finishReason = "stop";
      await runWithRetry((event) => {
        if (event.type === "text") content += event.value;
        else if (event.type === "thinking") reasoning += event.value;
        else if (event.type === "tool_call") {
          toolCalls.push({
            id: event.value.id,
            type: "function",
            function: { name: event.value.name, arguments: event.value.arguments },
          });
          finishReason = "tool_calls";
        }
        else if (event.type === "error") agentError = event.value;
        else if (event.type === "done" && event.finishReason) finishReason = event.finishReason;
      });
      if (agentError) {
        return {
          response: new Response(JSON.stringify({ error: { message: agentError, type: "api_error" } }), {
            status: HTTP_STATUS.BAD_REQUEST,
            headers: { "Content-Type": "application/json" },
          }),
          url,
          headers,
          transformedBody: body,
          responseFormat: FORMATS.OPENAI,
        };
      }
      const message = {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      return {
        response: new Response(JSON.stringify({
          id: responseId,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: estimateUsage(body, content.length, FORMATS.OPENAI),
        }), { headers: { "Content-Type": "application/json" } }),
        url,
        headers,
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      start(controller) {
        // Defer terminal SSE until runWithRetry settles. Emitting stop on the
        // first empty upstream turn wedges Cursor before the tail-only retry
        // can recover the session.
        runWithRetry((event) => {
          if (event.type === "text") {
            controller.enqueue(encoder.encode(chatChunkSse({ id: responseId, created, model, delta: { content: event.value } })));
          } else if (event.type === "thinking") {
            controller.enqueue(encoder.encode(chatChunkSse({ id: responseId, created, model, delta: { reasoning_content: event.value } })));
          } else if (event.type === "tool_call") {
            controller.enqueue(encoder.encode(chatChunkSse({
              id: responseId, created, model,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: event.value.id,
                  type: "function",
                  function: { name: event.value.name, arguments: event.value.arguments },
                }],
              },
            })));
          } else if (event.type === "error") {
            // An SSE error frame, not a content delta: a protocol failure must not
            // be rendered to the user as the assistant's reply, and downstream
            // usage tracking must not record the turn as a success.
            controller.enqueue(encoder.encode(sseChunk({ error: { message: event.value, type: "api_error" } })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          } else if (event.type === "done") {
            controller.enqueue(encoder.encode(chatChunkSse({
              id: responseId, created, model, delta: {},
              finishReason: event.finishReason || "stop",
            })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          }
        }).catch((error) => controller.error(error));
      },
      cancel() {
        requestController.abort();
      },
    });

    return {
      response: new Response(responseStream, { headers: SSE_HEADERS }),
      url,
      headers,
      transformedBody: body,
      responseFormat: FORMATS.OPENAI,
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    if (isAgentCapableRequest(body)) {
      try {
        return await this.executeAgent({ model, body, stream, credentials, signal, log, proxyOptions });
      } catch (error) {
        return {
          response: new Response(JSON.stringify({
            error: { message: error.message, type: "connection_error", code: "" },
          }), { status: HTTP_STATUS.SERVER_ERROR, headers: { "Content-Type": "application/json" } }),
          url: `${PROVIDER_OAUTH.cursor?.agentEndpoint || ""}${AGENT_RUN_PATH}`,
          headers: {},
          transformedBody: body,
        };
      }
    }

    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials);
    const transformedBody = this.transformRequest(model, body, stream, credentials);

    try {
      const shouldForceFetch = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true || !!proxyOptions?.vercelRelayUrl;
      const response = (http2 && !shouldForceFetch)
        ? await this.makeHttp2Request(url, headers, transformedBody, signal)
        : await this.makeFetchRequest(url, headers, transformedBody, signal, proxyOptions);

      if (response.status !== 200) {
        const errorText = response.body?.toString() || "Unknown error";
        const errorResponse = new Response(JSON.stringify({
          error: {
            message: `[${response.status}]: ${errorText}`,
            type: "invalid_request_error",
            code: ""
          }
        }), {
          status: response.status,
          headers: { "Content-Type": "application/json" }
        });
        return { response: errorResponse, url, headers, transformedBody: body };
      }

      const transformedResponse = stream !== false
        ? this.transformProtobufToSSE(response.body, model, body)
        : this.transformProtobufToJSON(response.body, model, body);

      return { response: transformedResponse, url, headers, transformedBody: body };
    } catch (error) {
      const errorResponse = new Response(JSON.stringify({
        error: {
          message: error.message,
          type: "connection_error",
          code: ""
        }
      }), {
        status: HTTP_STATUS.SERVER_ERROR,
        headers: { "Content-Type": "application/json" }
      });
      return { response: errorResponse, url, headers, transformedBody: body };
    }
  }

  transformProtobufToJSON(buffer, model, body) {
    const responseId = `chatcmpl-cursor-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    let offset = 0;
    let totalContent = "";
    let totalThinking = "";
    const toolCalls = [];
    const toolCallsMap = new Map(); // Track streaming tool calls by ID
    const finalizedIds = new Set();
    let frameCount = 0;

    debugLog(`[CURSOR BUFFER] Total length: ${buffer.length} bytes`);

    while (offset < buffer.length) {
      const frame = readCursorFrame(buffer, offset, frameCount, "");
      if (frame.status === "done") break;
      offset = frame.offset;
      frameCount++;
      if (frame.status === "skip") continue;
      const payload = frame.payload;

      // Check for JSON error frames (byte guard: skip toString on non-JSON frames)
      if (payload.length > 0 && payload[0] === 0x7b) {
        try {
          const text = payload.toString("utf-8");
          if (text.includes('"error"')) {
            const hasContent = totalContent || toolCallsMap.size > 0;
            debugLog(
              `[CURSOR BUFFER] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`
            );
            if (hasContent) {
              break;
            }
            return createErrorResponse(JSON.parse(text));
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      debugLog(`[CURSOR DECODED] Frame ${frameCount}:`, result);

      if (result.error) {
        const hasContent = totalContent || toolCallsMap.size > 0;
        debugLog(`[CURSOR BUFFER] Decoded error (hasContent=${hasContent}): ${result.error}`);
        if (hasContent) {
          break;
        }
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
          {
            status: HTTP_STATUS.RATE_LIMITED,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (result.toolCall) {
        const tc = result.toolCall;

        if (toolCallsMap.has(tc.id)) {
          // Accumulate arguments for existing tool call
          const existing = toolCallsMap.get(tc.id);
          existing.function.arguments += tc.function.arguments;
          existing.isLast = tc.isLast;
        } else {
          // New tool call
          toolCallsMap.set(tc.id, { ...tc });
        }

        // Push to final array when isLast is true
        if (tc.isLast) {
          const finalToolCall = toolCallsMap.get(tc.id);
          finalizedIds.add(tc.id);
          toolCalls.push({
            id: finalToolCall.id,
            type: finalToolCall.type,
            function: {
              name: finalToolCall.function.name,
              arguments: finalToolCall.function.arguments
            }
          });
        }
      }

      if (result.text) totalContent += result.text;
      if (result.thinking) totalThinking += result.thinking;
    }

    const visibleComposerContent = isComposerModel(model)
      ? visibleComposerContentFromThinking(totalThinking)
      : "";
    const finalContent = totalContent || visibleComposerContent;

    debugLog(
      `[CURSOR BUFFER] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, finalized toolCalls: ${toolCalls.length}`
    );

    // Finalize all remaining tool calls in map (in case stream ended without isLast=true)
    for (const [id, tc] of toolCallsMap.entries()) {
      // Check if already in final array
      if (!finalizedIds.has(id)) {
        debugLog(`[CURSOR BUFFER] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`);
        toolCalls.push({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        });
      }
    }

    debugLog(`[CURSOR BUFFER] Final toolCalls count: ${toolCalls.length}`);


    const message = {
      role: "assistant",
      content: finalContent || null
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const usage = estimateUsage(body, finalContent.length, FORMATS.OPENAI);

    const completion = {
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
      }],
      usage
    };

    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  transformProtobufToSSE(buffer, model, body) {
    const responseId = `chatcmpl-cursor-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const chunks = [];
    let offset = 0;
    let totalContent = "";
    let totalThinking = "";
    let emittedComposerThinkingContentLength = 0;
    const toolCalls = [];
    const toolCallsMap = new Map(); // Track streaming tool calls by ID
    const finalizedIds = new Set();
    const emittedToolCallIds = new Set();
    let frameCount = 0;

    debugLog(`[CURSOR BUFFER SSE] Total length: ${buffer.length} bytes`);

    while (offset < buffer.length) {
      const frame = readCursorFrame(buffer, offset, frameCount, " SSE");
      if (frame.status === "done") break;
      offset = frame.offset;
      frameCount++;
      if (frame.status === "skip") continue;
      const payload = frame.payload;

      // Check for JSON error frames (byte-guard: only decode if starts with '{')
      if (payload[0] === 0x7b) {
        try {
          const text = payload.toString("utf-8");
          if (text.includes('"error"')) {
            const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0;
            debugLog(
              `[CURSOR BUFFER SSE] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`
            );
            if (hasContent) {
              break;
            }
            return createErrorResponse(JSON.parse(text));
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      debugLog(`[CURSOR DECODED SSE] Frame ${frameCount}:`, result);

      if (result.error) {
        const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0;
        debugLog(`[CURSOR BUFFER SSE] Decoded error (hasContent=${hasContent}): ${result.error}`);
        if (hasContent) {
          break;
        }
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
          {
            status: HTTP_STATUS.RATE_LIMITED,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (result.toolCall) {
        const tc = result.toolCall;

        if (chunks.length === 0) {
          chunks.push(chatChunkSse({ id: responseId, created, model, delta: { role: "assistant", content: "" } }));
        }

        if (toolCallsMap.has(tc.id)) {
          // Accumulate arguments for existing tool call
          const existing = toolCallsMap.get(tc.id);
          const oldArgsLen = existing.function.arguments.length;
          existing.function.arguments += tc.function.arguments;
          existing.isLast = tc.isLast;

          // Stream the delta arguments
          if (tc.function.arguments) {
            emittedToolCallIds.add(tc.id);
            chunks.push(chatChunkSse({
              id: responseId, created, model,
              delta: {
                tool_calls: [
                  {
                    index: existing.index,
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments
                    }
                  }
                ]
              }
            }));
          }
        } else {
          // New tool call - assign index and add to map
          const toolCallIndex = toolCalls.length;
          finalizedIds.add(tc.id);
          toolCalls.push({ ...tc, index: toolCallIndex });
          toolCallsMap.set(tc.id, { ...tc, index: toolCallIndex });

          // Stream initial tool call with name
          emittedToolCallIds.add(tc.id);
          chunks.push(chatChunkSse({
            id: responseId, created, model,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments
                  }
                }
              ]
            }
          }));
        }
      }

      if (result.text) {
        totalContent += result.text;
        chunks.push(chatChunkSse({
          id: responseId, created, model,
          delta:
            chunks.length === 0 && toolCalls.length === 0
              ? { role: "assistant", content: result.text }
              : { content: result.text }
        }));
      }

      if (isComposerModel(model) && result.thinking) {
        totalThinking += result.thinking;
        const visibleContent = visibleComposerContentFromThinking(totalThinking);
        if (visibleContent.length > emittedComposerThinkingContentLength) {
          const deltaContent = visibleContent.slice(emittedComposerThinkingContentLength);
          emittedComposerThinkingContentLength = visibleContent.length;
          totalContent += deltaContent;
          chunks.push(chatChunkSse({
            id: responseId, created, model,
            delta:
              chunks.length === 0 && toolCalls.length === 0
                ? { role: "assistant", content: deltaContent }
                : { content: deltaContent }
          }));
        }
      }
    }

    debugLog(
      `[CURSOR BUFFER SSE] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, toolCalls array: ${toolCalls.length}`
    );

    // Finalize all remaining tool calls in map (stream may have ended without isLast=true)
    for (const [id, tc] of toolCallsMap.entries()) {
      if (!finalizedIds.has(id)) {
        debugLog(`[CURSOR BUFFER SSE] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`);
        const toolCallIndex = toolCalls.length;
        toolCalls.push({
          id: tc.id,
          type: tc.type,
          index: toolCallIndex,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        });

        // Emit SSE chunk for the finalized tool call if not already emitted
        if (!emittedToolCallIds.has(tc.id)) {
          chunks.push(chatChunkSse({
            id: responseId, created, model,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments
                  }
                }
              ]
            }
          }));
        }
      }
    }

    if (chunks.length === 0 && toolCalls.length === 0) {
      chunks.push(chatChunkSse({ id: responseId, created, model, delta: { role: "assistant", content: "" } }));
    }

    const usage = estimateUsage(body, totalContent.length, FORMATS.OPENAI);

    chunks.push(
      `data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
          }
        ],
        usage
      })}\n\n`
    );
    chunks.push(SSE_DONE);

    return new Response(chunks.join(""), {
      status: 200,
      headers: { ...SSE_HEADERS }
    });
  }

  async refreshCredentials() {
    return null;
  }
}

export default CursorExecutor;
