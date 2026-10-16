import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_BASE_URLS, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_OAUTH_CLIENT } from "../shared.js";

export default {
  id: "antigravity",
  priority: 20,
  alias: "ag",
  uiAlias: "ag",
  display: {
    name: "Antigravity",
    icon: "rocket_launch",
    color: "#F59E0B",
    website: "https://antigravity.google",
    notice: {
      signupUrl: "https://antigravity.google",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  serviceKinds: ["llm", "image", "webSearch"],
  transport: {
    // Host inference berurutan: `daily` resmi dulu, lalu pool sandbox saat
    // `daily` kehabisan kapasitas (503 "No capacity available for model …").
    // Pool kapasitas Google TERPISAH per host — lihat ANTIGRAVITY_IDE_BASE_URLS.
    baseUrls: ANTIGRAVITY_IDE_BASE_URLS,
    format: "antigravity",
    headers: {
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    },
    retry: {
      "429": {
        // Retry di host yang sama, karena 429 burst Cloud Code pulih dalam
        // MILIDETIK — terukur 2026-09-20: `quotaResetDelay: 162.322081ms`.
        // Delay diambil dari error.details[] oleh computeRetryDelay, jadi
        // tidak ada backoff buta. attempts: 2 memberi ruang ~0,2-0,5 detik,
        // jauh lebih murah daripada membuang request ke akun lain yang juga
        // sedang burst (dan lebih cepat daripada rotasi host ~3-4 detik).
        //
        // 429 yang benar-benar kehabisan kuota tetap ditangani: computeRetryDelay
        // mengembalikan `false` (veto) bila resetAt > MAX_RETRY_AFTER_MS,
        // sehingga chatCore langsung merotasi akun.
        attempts: 2,
      },
      "500": {
        // 0 attempts = JANGAN retry host yang sama; langsung maju ke host
        // berikutnya di `baseUrls` (lihat AntigravityExecutor.shouldRetry).
        // Host kapasitas-habis tidak sembuh dalam hitungan detik, jadi retry
        // di host yang sama hanya membuang waktu sebelum pindah host.
        attempts: 0,
      },
      "503": {
        // Idem untuk 503 "No capacity available for model …": pool kapasitas
        // Google per-host, bukan per-akun. Rotasi host, bukan retry.
        attempts: 0,
      },
    },
    usage: {
      quotaApiUrl: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:fetchAvailableModels`,
      quotaSummaryApiUrl: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:retrieveUserQuotaSummary`,
      loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
  },
  models: [
    // Upstream v0.5.99/v0.5.104 membuang id `-tiered` dan kembali ke id polos
    // per-tier (`gemini-3.8-flash-high` dst). Catatan fork sebelumnya
    // ("`gemini-3.8-flash-high` 404s, hanya `-tiered` yang 200") diukur 10 Sep
    // 2026; Google menggantinya lagi setelah itu, jadi id upstream dipakai.
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", upstreamModelId: "gemini-4-argon-high(high)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", upstreamModelId: "gemini-3.8-flash-high(high)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", upstreamModelId: "gemini-3.8-flash-medium(medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", upstreamModelId: "gemini-3.8-flash-low(low)" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", upstreamModelId: "gemini-3.8-flash-medium(medium)" },
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", upstreamModelId: "gemini-3.7-flash-tiered(high)" },
    { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", upstreamModelId: "gemini-3.7-flash-tiered(medium)" },
    { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", upstreamModelId: "gemini-3.7-flash-tiered(low)" },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", upstreamModelId: "gemini-3.6-flash-tiered(high)" },
    { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", upstreamModelId: "gemini-3.6-flash-tiered(medium)" },
    { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", upstreamModelId: "gemini-3.6-flash-tiered(low)" },
    // Upstream v0.5.99 menghapus 3.5/3-flash (model sudah ditarik Google) dan
    // menggantinya dengan 3.1 pro-high. Entri tanpa upstreamModelId berarti
    // id-nya dipakai apa adanya.
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", upstreamModelId: "gemini-pro-agent" },
    { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", upstreamModelId: "gemini-pro-agent" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", upstreamModelId: "gemini-3.1-pro-low(low)" },
    // Claude 5.5 — upstream exposes exactly 4 tiers per family (base + low/medium/high).
    // The `(level)` suffix on upstreamModelId is a 9router thinking override: it is
    // resolved into the request and stripped again before the Google Cloud Code call.
    { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", upstreamModelId: "claude-sonnet-5-5-high(high)" },
    { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", upstreamModelId: "claude-sonnet-5-5-medium(medium)" },
    { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", upstreamModelId: "claude-sonnet-5-5-low(low)" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Thinking)", upstreamModelId: "claude-sonnet-5-5-high(high)" },
    { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", upstreamModelId: "claude-opus-5-5-high(high)" },
    { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", upstreamModelId: "claude-opus-5-5-medium(medium)" },
    { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", upstreamModelId: "claude-opus-5-5-low(low)" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5 (Thinking)", upstreamModelId: "claude-opus-5-5-high(high)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    // Image generation models
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash (Image)", kind: "image", imageGen: true, capabilities: ["textToImage"] },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    apiEndpoint: "https://daily-cloudcode-pa.googleapis.com",
    apiVersion: "v1internal",
    loadCodeAssistEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    onboardUserEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
    loadCodeAssistUserAgent: ANTIGRAVITY_IDE_USER_AGENT,
    refreshLeadMs: 300000,
  },
  searchViaChat: {
    defaultModel: "gemini-2.5-flash",
    endpoint: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:generateContent`,
    freeTier: "Free — Google Search grounding through an Antigravity OAuth account.",
  },
  features: {
    usage: true,
  },
};
