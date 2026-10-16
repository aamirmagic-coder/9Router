import { platform, arch } from "os";

// === OS/Arch helpers (Stainless fingerprint) ===
export function mapStainlessOs() {
  switch (platform()) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64": return "x64";
    case "arm64": return "arm64";
    case "ia32": return "x86";
    default: return `other::${arch()}`;
  }
}

// Anthropic API version (single source — reused across claude-format providers/executors)
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const CLAUDE_CLI_VERSION = "2.1.280";

// Shared Claude-compatible API headers (reused across claude-format providers)
export const CLAUDE_API_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
};

// Full Claude CLI fingerprint — required by providers that gate on client identity (e.g. agentrouter)
export const CLAUDE_CLI_SPOOF_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28",
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
  "X-App": "cli",
  "X-Stainless-Helper-Method": "stream",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime-Version": "v24.14.0",
  "X-Stainless-Package-Version": "0.80.0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Arch": mapStainlessArch(),
  "X-Stainless-Os": mapStainlessOs(),
  "X-Stainless-Timeout": "600"
};

const ANTHROPIC_BETA_BASE = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];
const ANTHROPIC_BETA_HEAVY_AGENT = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"];

// Heavy-agent beta flags are gated to opus/sonnet — cheaper models don't need them.
// `redact-thinking` asks Anthropic to return signature-only thinking blocks, which
// is right for clients that never render thinking but blanks the summaries a
// client explicitly requested with `thinking.display: "summarized"`.
const ANTHROPIC_BETA_REDACT_THINKING = "redact-thinking-2026-02-12";

export function wantsThinkingSummaries(body) {
  return body?.thinking?.display === "summarized";
}

export function selectAnthropicBeta(model = "", body = null) {
  const flags = ANTHROPIC_BETA_BASE.filter((flag) => flag !== ANTHROPIC_BETA_REDACT_THINKING || !wantsThinkingSummaries(body));
  if (/^claude-(opus|sonnet)/.test(model)) flags.push(...ANTHROPIC_BETA_HEAVY_AGENT);
  return flags.join(",");
}

export function mergeAnthropicBeta(...values) {
  const flags = values.flatMap((v) => (typeof v === "string" ? v.split(",") : [])).map((f) => f.trim()).filter(Boolean);
  return [...new Set(flags)].join(",");
}

// Shared baseUrls
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1/messages";

// Default base for dynamic compat providers (openai-compatible-* / anthropic-compatible-*) when user gives no baseUrl
export const OPENAI_COMPAT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_COMPAT_BASE = "https://api.anthropic.com/v1";

// Official Antigravity IDE Desktop 2.22.0 fingerprint captured from macOS arm64.
// Keep this static even when 9router runs on Linux: the provider profile is
// intentionally matching the IDE client, not the server host.
export const ANTIGRAVITY_IDE_VERSION = "2.22.0";
export const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

/**
 * Antigravity inference hosts, in fallback order.
 *
 * Google menjalankan beberapa pool kapasitas yang TERPISAH per host. Saat
 * `daily` kehabisan kapasitas untuk model tertentu (503 "No capacity
 * available for model …"), pool sandbox masih penuh — diukur live
 * 2026-09-13 dengan 40 akun:
 *
 *   daily-cloudcode-pa.googleapis.com              →  5% sukses (503)
 *   autopush-cloudcode-pa.sandbox.googleapis.com   → 100% sukses
 *   staging-cloudcode-pa.sandbox.googleapis.com    → 100% sukses
 *
 * Karena itu `daily` tetap ditaruh pertama (host resmi IDE, dipakai selama
 * sehat) dan sandbox jadi cadangan saat 503. Ketiga host melayani task yang
 * sama dan menerima body/header identik.
 *
 * PENTING: `preprod-cloudcode-pa.sandbox` mengembalikan 403 untuk model ini
 * dan `cloudcode-pa.googleapis.com` (prod) mengembalikan 429 — keduanya
 * SENGAJA tidak didaftarkan.
 */
export const ANTIGRAVITY_IDE_FALLBACK_BASE_URLS = [
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://staging-cloudcode-pa.sandbox.googleapis.com",
];

/** Semua host inference Antigravity, urut prioritas. */
export const ANTIGRAVITY_IDE_BASE_URLS = [
  ANTIGRAVITY_IDE_BASE_URL,
  ...ANTIGRAVITY_IDE_FALLBACK_BASE_URLS,
];

/**
 * Host presets, dipilih dari dashboard (Providers → Antigravity → Host).
 *
 * Default `all-hosts` = daily dulu, sandbox sebagai CADANGAN kapasitas.
 *
 * Kenapa bukan daily-only: 9Router upstream dan CLIProxyAPI memang memakai
 * daily saja, tapi keduanya juga tidak punya rotasi host sama sekali — saat
 * daily kehabisan kapasitas mereka langsung berganti AKUN. Diukur 2026-09-20,
 * pendekatan itu merugikan di pool ini: gemini-3.8-flash hanya 2/8 sukses di
 * daily sementara KEDUA sandbox 8/8. Tanpa cadangan, enam dari delapan akun
 * gagal pada model yang sebenarnya tersedia.
 *
 * Sandbox tetap punya risiko sendiri: ia menolak request yang membawa project
 * bukan milik akun tersebut dengan 403 SUBSCRIPTION_REQUIRED (#3501). Karena
 * itu urutannya daily DULU — sandbox hanya dicoba setelah daily benar-benar
 * menolak, bukan sebagai host utama.
 *
 * `daily-only` tetap tersedia untuk siapa pun yang lebih memilih menghindari
 * sandbox sepenuhnya dan menerima risiko kehabisan kapasitas.
 */
export const ANTIGRAVITY_HOST_PRESETS = {
  "daily-only": {
    label: "Daily only",
    hint: "Host resmi IDE saja. Paling sedikit risiko 403, tapi tidak ada cadangan saat daily kehabisan kapasitas.",
    urls: [ANTIGRAVITY_IDE_BASE_URL],
  },
  "daily-autopush": {
    label: "Daily + Autopush",
    hint: "Daily dulu, satu pool sandbox sebagai cadangan kapasitas.",
    urls: [ANTIGRAVITY_IDE_BASE_URL, "https://autopush-cloudcode-pa.sandbox.googleapis.com"],
  },
  "all-hosts": {
    label: "Semua host (default)",
    hint: "Daily dulu, lalu dua pool sandbox. Kapasitas maksimum — diukur 2026-09-20, gemini hanya 2/8 sukses di daily sementara sandbox 8/8.",
    urls: [
      ANTIGRAVITY_IDE_BASE_URL,
      "https://autopush-cloudcode-pa.sandbox.googleapis.com",
      "https://staging-cloudcode-pa.sandbox.googleapis.com",
    ],
  },
};

/** Resolve a preset key (or an explicit URL list) to the host list to use. */
export function resolveAntigravityHosts(mode) {
  if (Array.isArray(mode) && mode.length) return mode;
  const preset = ANTIGRAVITY_HOST_PRESETS[mode];
  return preset ? preset.urls : ANTIGRAVITY_HOST_PRESETS["all-hosts"].urls;
}

/**
 * Runtime host selection.
 *
 * `open-sse/` must stay standalone (it is usable without the Next.js app), so
 * the executor cannot read the dashboard settings itself. The app pushes the
 * chosen mode in here instead, and the executor reads it at request time.
 *
 * Module state, so it survives across requests in the same process. Default is
 * `all-hosts` — see ANTIGRAVITY_HOST_PRESETS for why daily-first-with-sandbox-
 * fallback beats daily-only in this pool.
 */
let _antigravityHostMode = "all-hosts";

/** Called by the app when settings load or change. */
export function setAntigravityHostMode(mode) {
  if (mode === undefined || mode === null) return;
  _antigravityHostMode = mode;
}

export function getAntigravityHostMode() {
  return _antigravityHostMode;
}

/** The host list the executor should use right now. */
export function getActiveAntigravityHosts() {
  return resolveAntigravityHosts(_antigravityHostMode);
}

export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

// Antigravity OAuth client credentials (public CLI client — duplicated in usage.js + src/lib/oauth)
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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"
};

// Gemini (Google) OAuth client credentials (public CLI client — shared by gemini, gemini-cli, src/lib/oauth)
export const GOOGLE_OAUTH_CLIENT = {
  clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  clientSecret: "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"
};

// Meta Code (Muse Spark) device-code OAuth client — public client_id of the `muse` CLI
// launcher (no secret; device grant, PKCE-less). Same class of public CLI client as
// GOOGLE_OAUTH_CLIENT above: not a secret, and widely mirrored by other gateways
// (CLIProxyAPI, pi, opencodex). Env var overrides it for forks that ship their own.
export const META_CODE_OAUTH_CLIENT = {
  clientId: process.env.META_CODE_OAUTH_CLIENT_ID?.trim() || "1031625952748946",
};
