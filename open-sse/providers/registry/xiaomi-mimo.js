import { CLAUDE_API_HEADERS } from "../shared.js";

// Dual auth (same pattern as kimi):
//   - API key (sk-...)      → cloud API on api.xiaomimimo.com
//   - Desktop account/OAuth → same cloud host, plus the dual-route v2.6 models
//     served by the account-service route (mimo-server-<cluster>.xiaomimimo.com),
//     authorized by a Xiaomi account session cookie, not the key.
// Endpoint is picked per model in the executor, same as opencode-go's /responses split.
export default {
  id: "xiaomi-mimo",
  priority: 290,
  alias: "xiaomi-mimo",
  aliases: [
    "mimo",
    "mimo-desktop",
    "xmd",
  ],
  uiAlias: "mimo",
  display: {
    name: "Xiaomi MiMo",
    icon: "smart_toy",
    color: "#FF6900",
    textIcon: "XM",
    website: "https://xiaomimimo.com",
    notice: {
      apiKeyUrl: "https://platform.xiaomimimo.com/console/api-keys",
      signupUrl: "https://mimo.xiaomimimo.com/desktop/invite/",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  // Kunci bersifat per-cluster. MiMo Desktop mendeklarasikan lima region
  // (CN/SGP/AMS/RU/IN) — host dan sid mengikuti pola mimo-server-<kode> /
  // mimo<kode>. Region tak dikenal jatuh ke sgp.
  regions: [
    { id: "cn", label: "China (中国大陆)" },
    { id: "sgp", label: "Singapore (新加坡)" },
    { id: "ams", label: "Europe · Amsterdam (欧洲)" },
    { id: "ru", label: "Russia (俄罗斯)" },
    { id: "in", label: "India (印度)" },
  ],
  defaultRegion: "sgp",
  // MiMo menjalankan DUA permukaan API yang terpisah dan TIDAK saling
  // menerima kunci satu sama lain (diukur 24 Sep 2026):
  //
  //   platform (pay-as-you-go) : api.xiaomimimo.com
  //     - kunci sk- dari console/api-keys
  //     - saldo terpisah; kunci Token Plan ditolak di sini
  //
  //   Token Plan (langganan)   : token-plan-<region>.xiaomimimo.com
  //     - kunci "Dedicated API Key" dari console/plan-manage
  //     - kuota bulanan (mis. Lite = 4,1 M credits), BUKAN saldo
  //     - kunci platform ditolak 401 "Invalid API Key"
  //
  // Karena itu permukaan dipilih PER KONEKSI lewat
  // `providerSpecificData.mimoSurface` ("platform" | "token-plan"), bukan
  // hardcode di registry. Region mengikuti `regions` di atas.
  surfaces: [
    { id: "platform", label: "Platform (pay-as-you-go)", host: "api.xiaomimimo.com" },
    { id: "token-plan", label: "Token Plan (langganan)", hostTemplate: "token-plan-{region}.xiaomimimo.com" },
  ],
  defaultSurface: "platform",
  serviceKinds: ["llm", "tts"],
  transport: {
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    validateUrl: "https://api.xiaomimimo.com/v1/models",
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    // Model dual-route v2.6: memakai kuota akun Desktop bila kredensialnya ada,
    // jika tidak jatuh ke cloud API (kunci sk-). Menggantikan id
    // mimo-x-*-preview yang sudah usang.
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", upstreamModelId: "xiaomi/mimo-v2.6-pro", supportedFormats: ["openai"] },
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", upstreamModelId: "xiaomi/mimo-v2.6-flash", supportedFormats: ["openai"] },
    { id: "mimo-v2.6-pro-ultraspeed", name: "MiMo V2.6 Pro UltraSpeed", upstreamModelId: "xiaomi/mimo-v2.6-pro-ultraspeed", supportedFormats: ["openai"] },
    // Cloud API models (api.xiaomimimo.com/v1)
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "mimo-v2.5", name: "MiMo V2.5" },
    { id: "mimo-v2-omni", name: "MiMo V2 Omni" },
    { id: "mimo-v2-flash", name: "MiMo V2 Flash" },
    { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", kind: "tts" },
  ],
  ttsConfig: {
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    authType: "apikey",
    authHeader: "bearer",
    format: "xiaomi-mimo-tts",
  },
  features: {
    usage: true,
    usageApikey: true,
  },
  // Custom OAuth — non-standard ECDH encrypted-callback flow.
  // Handled by the Xiaomi MiMo OAuth service, not the generic PKCE pipeline.
  oauth: {
    custom: true,
    authorizeUrl: "https://platform.xiaomimimo.com/authorize",
    // The callback carries ?u=<ECDH-encrypted payload> instead of ?code=.
    // Decryption yields { uid, sk, url }.
    callbackParam: "u",
    kn: "mimocode",
  },
};
