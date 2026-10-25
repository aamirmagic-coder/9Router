// All intercepted domains + URL patterns per tool

const fs = require("fs");

const IS_DEV = process.env.NODE_ENV === "development";

// Resolve lsof absolute path — packaged apps / sudo secure_path may strip /usr/sbin from PATH
const LSOF_BIN = (() => {
  if (process.platform === "win32") return null;
  for (const p of ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof"]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* try next */ }
  }
  return "lsof"; // last-resort fallback (depends on PATH)
})();

const TARGET_HOSTS = [
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "runtime.us-east-1.kiro.dev",
  "api2.cursor.sh",
  // RECON: Grok Bot candidate hosts (passthrough+dump only for now)
  "grok.com",
  "chat.x.com",
  "x.ai",
];

const URL_PATTERNS = {
  antigravity: [":generateContent", ":streamGenerateContent"],
  copilot: ["/chat/completions", "/v1/messages", "/responses"],
  // Legacy path form. Kiro IDE 1.0.228+ posts to `/` with x-amz-target instead —
  // see isChatRequest() for the header-based match.
  kiro: ["/generateAssistantResponse"],
  cursor: ["/BidiAppend", "/RunSSE", "/RunPoll", "/Run"],
  // RECON: match-all so every grok request is flagged as "chat" and reaches the
  // recon branch in server.js (which passthroughs + dumps). "" is a substring of
  // any URL, so isChatRequest() always returns true for grok.
  grok: [""],
};

/**
 * Whether this request is a chat turn we should intercept (vs passthrough).
 * Kiro Runtime moved GenerateAssistantResponse from path `/generateAssistantResponse`
 * to `POST /` + `x-amz-target: KiroRuntimeService.GenerateAssistantResponse`
 * (verified via live mitmproxy capture of Kiro IDE 1.0.228).
 *
 * Kiro 1.x+ also sends the main agentic chat turn as a POST /v1/responses request
 * (OpenAI Responses API format, no x-amz-target header). This is the large-body
 * request (~100 KB+) that contains the full conversation and should be intercepted
 * in addition to the legacy CodeWhisperer path.
 */
function isChatRequest(tool, req) {
  const patterns = URL_PATTERNS[tool] || [];
  if (patterns.some((p) => (req.url || "").includes(p))) return true;
  if (tool === "kiro") {
    const target = String(req.headers?.["x-amz-target"] || "");
    if (target.includes("GenerateAssistantResponse")) return true;
    // New Responses API path (Kiro 1.x+): OpenAI-compatible, no x-amz-target
    if ((req.url || "") === "/v1/responses") return true;
  }
  return false;
}

// Synonym map: rawModel from request → canonical alias key in mitmAlias DB
const MODEL_SYNONYMS = {
  kiro: {
    // Kiro IDE has shipped this slot under several ids over time. All of them must land on
    // the single canonical alias key "qwen3-coder-next" so a mapping saved once keeps working.
    "qwen3-coder-next": "qwen3-coder-next",
    "qwen3-coder": "qwen3-coder-next",
    "qwen3-coder-next-1": "qwen3-coder-next",
    "qwen-3-coder-next": "qwen3-coder-next",
    "qwen3coder-next": "qwen3-coder-next",
    // Legacy configs stored the editor model under the background slot's key. Requests that
    // still arrive as "simple-task" are background/git-commit turns and keep their own mapping;
    // only dot/dash variants of the background slot are normalized here.
    "simple-task": "simple-task",
    "simple_task": "simple-task",
  },
  antigravity: {
    "gemini-default": "gemini-3.8-flash-medium",
    "gemini-3.5-flash-high": "gemini-3.8-flash-high",
    "gemini-3.5-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.5-flash-low": "gemini-3.8-flash-low",
    "gemini-3.5-flash-extra-low": "gemini-3.8-flash-low",
    "gemini-3.8-flash": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high": "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low": "gemini-3.8-flash-low",
    "gemini-3.7-flash-high": "gemini-3.7-flash-high",
    "gemini-3.7-flash-medium": "gemini-3.7-flash-medium",
    "gemini-3.7-flash-low": "gemini-3.7-flash-low",
    "gemini-3.6-flash-high": "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium": "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low": "gemini-3.6-flash-low",
    "gemini-3.1-pro-high": "gemini-pro-agent",
    "gemini-3-pro-high": "gemini-pro-agent",
    "gemini-3-pro-low": "gemini-3.1-pro-low",
    "claude-sonnet-5-5-high": "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-medium": "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-low": "claude-sonnet-5-5-low",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5.5": "claude-sonnet-5-5",
    "claude-sonnet-5.5-high": "claude-sonnet-5-5-high",
    "claude-sonnet-5.5-medium": "claude-sonnet-5-5-medium",
    "claude-sonnet-5.5-low": "claude-sonnet-5-5-low",
    "claude-sonnet-5-5-thinking": "claude-sonnet-5-5",
    "claude-sonnet-5.5-thinking": "claude-sonnet-5-5",
    "claude-opus-5-5-high": "claude-opus-5-5-high",
    "claude-opus-5-5-medium": "claude-opus-5-5-medium",
    "claude-opus-5-5-low": "claude-opus-5-5-low",
    "claude-opus-5-5": "claude-opus-5-5",
    "claude-opus-5.5": "claude-opus-5-5",
    "claude-opus-5.5-high": "claude-opus-5-5-high",
    "claude-opus-5.5-medium": "claude-opus-5-5-medium",
    "claude-opus-5.5-low": "claude-opus-5-5-low",
    "claude-opus-5-5-thinking": "claude-opus-5-5",
    "claude-opus-5.5-thinking": "claude-opus-5-5",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-opus-4.6": "claude-opus-4-6-thinking",
    "claude-opus-4.6-thinking": "claude-opus-4-6-thinking",
  },
};

// Pattern fallback: rawModel regex → canonical alias key (when exact + prefix match fail)
// Order matters: more specific patterns first. Catches AG renamed variants (e.g. gemini-pro-agent)
const MODEL_PATTERNS = {
  kiro: [
    // Catch any Qwen coder variant the IDE invents (version suffixes, provider prefixes,
    // "models/" prefixes) and route it to the qwen3-coder-next slot.
    { match: /qwen.*coder/i, alias: "qwen3-coder-next" },
    // Background sub-task turns: git commit messages, summarization, simple-task jobs.
    { match: /simple.*task/i, alias: "simple-task" },
  ],
  antigravity: [
    { match: /flash.*extra.*low|extra.*low.*flash|flash.*low|low.*flash/i, alias: "gemini-3.8-flash-low" },
    { match: /flash.*medium|medium.*flash/i,                       alias: "gemini-3.8-flash-medium" },
    { match: /flash.*agent|agent.*flash|flash/i,                   alias: "gemini-3.8-flash-high" },
    { match: /pro.*low|low.*pro/i,                                 alias: "gemini-3.1-pro-low" },
    { match: /gemini.*pro|pro.*gemini/i,                           alias: "gemini-pro-agent" },
    { match: /opus.*5[.-]5.*high|5[.-]5.*opus.*high/i,             alias: "claude-opus-5-5-high" },
    { match: /opus.*5[.-]5.*medium|5[.-]5.*opus.*medium/i,         alias: "claude-opus-5-5-medium" },
    { match: /opus.*5[.-]5.*low|5[.-]5.*opus.*low/i,               alias: "claude-opus-5-5-low" },
    { match: /sonnet.*5[.-]5.*high|5[.-]5.*sonnet.*high/i,         alias: "claude-sonnet-5-5-high" },
    { match: /sonnet.*5[.-]5.*medium|5[.-]5.*sonnet.*medium/i,     alias: "claude-sonnet-5-5-medium" },
    { match: /sonnet.*5[.-]5.*low|5[.-]5.*sonnet.*low/i,           alias: "claude-sonnet-5-5-low" },
    { match: /opus.*5[.-]5|5[.-]5.*opus/i,                         alias: "claude-opus-5-5" },
    { match: /sonnet.*5[.-]5|5[.-]5.*sonnet/i,                     alias: "claude-sonnet-5-5" },
    { match: /opus/i,                                              alias: "claude-opus-4-6-thinking" },
    { match: /sonnet|claude/i,                                     alias: "claude-sonnet-4-6" },
    { match: /gpt.*oss|oss/i,                                      alias: "gpt-oss-120b-medium" },
  ],
};

// Models that must NEVER be re-routed — always passthrough to the real upstream, even when
// the tool's other models are mapped. Antigravity's tab-autocomplete (`tab_jump_flash_lite_preview`,
// `tab_flash_lite_preview`, requestType tab/tab_jump) is latency-critical inline completion; routing
// it through 9Router to an external chat model makes typing laggy and burns provider quota per
// keystroke. Without this guard the broad `flash` pattern in MODEL_PATTERNS hijacks them onto the
// flash-agent slot. Verified via MITM dump capture of streamGenerateContent (see AI_JOURNAL).
const MODEL_NO_MAP = {
  antigravity: [/^tab[_-]/i],
};

// URL substrings whose request/response should NOT be dumped to file (telemetry, polling, empty)
const LOG_BLACKLIST_URL_PARTS = [
  "recordCodeAssistMetrics",
  "recordTrajectoryAnalytics",
  "fetchAdminControls",
  "listExperiments",
  "fetchUserInfo",
];

function getToolForHost(host) {
  const h = (host || "").split(":")[0];
  if (h === "api.individual.githubcopilot.com") return "copilot";
  if (h === "daily-cloudcode-pa.googleapis.com" || h === "cloudcode-pa.googleapis.com") return "antigravity";
  if (h === "q.us-east-1.amazonaws.com" || h === "codewhisperer.us-east-1.amazonaws.com" || h === "runtime.us-east-1.kiro.dev") return "kiro";
  if (h === "api2.cursor.sh") return "cursor";
  // RECON: Grok Bot candidate hosts → "grok" (handled as passthrough+dump in server.js)
  if (h === "grok.com" || h === "chat.x.com" || h === "x.ai") return "grok";
  return null;
}

function isBinaryData(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.slice(0, Math.min(100, buffer.length));
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
      nonPrintable++;
    }
    if (byte > 0x7E) nonPrintable++;
  }
  return (nonPrintable / sample.length) > 0.3;
}

// Extract model from URL path (Gemini), body (OpenAI/Anthropic), or Kiro conversationState.
function extractModel(url, body) {
  const urlMatch = url.match(/\/models\/([^/:]+)/);
  const urlModel = urlMatch?.[1] || null;

  if (isBinaryData(body)) return urlModel;

  try {
    const parsed = JSON.parse(body.toString());
    if (parsed.conversationState) {
      return parsed.conversationState.currentMessage?.userInputMessage?.modelId || null;
    }
    const model = urlModel || parsed.model || null;
    const cleanModelName = String(model).replace(/^models\//, "");
    if (cleanModelName === "gemini-3.6-flash-tiered" || cleanModelName === "gemini-3.7-flash-tiered" || cleanModelName === "gemini-3.8-flash-tiered") {
      const ver = cleanModelName.includes("3.8") ? "3.8" : cleanModelName.includes("3.7") ? "3.7" : "3.6";
      const rawLevel = parsed.request?.generationConfig?.thinkingConfig?.thinkingLevel
        || parsed.generationConfig?.thinkingConfig?.thinkingLevel;
      const level = ["high", "medium", "low"].includes(String(rawLevel).toLowerCase())
        ? String(rawLevel).toLowerCase()
        : "medium";
      return `gemini-${ver}-flash-${level}`;
    }
    return model;
  } catch {
    return urlModel;
  }
}

module.exports = { IS_DEV, LSOF_BIN, TARGET_HOSTS, URL_PATTERNS, MODEL_SYNONYMS, MODEL_PATTERNS, MODEL_NO_MAP, LOG_BLACKLIST_URL_PARTS, getToolForHost, isChatRequest, extractModel };
