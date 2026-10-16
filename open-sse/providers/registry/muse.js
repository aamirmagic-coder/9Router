// Muse (Meta Model API) — dual auth (same pattern as kimi):
//   oauth  = Muse Code subscription (Meta account device code, mints an LLM|… key)
//   apikey = pay-as-you-go Model API key from dev.meta.ai
// Transport is shared; oauth accounts get x-api-version via the museHeaders hook.
// Meta issues no refresh token for the subscription flow → re-login on 401.
export default {
  id: "muse",
  priority: 120,
  alias: "muse",
  aliases: [
    "muse-ai",
    "meta-model-api",
    "muse-code",
    "muse-subscription",
  ],
  uiAlias: "muse",
  display: {
    name: "Muse (Meta Model API)",
    icon: "auto_awesome",
    color: "#0866FF",
    textIcon: "MU",
    website: "https://muse.ai",
    notice: {
      text: "Sign in with your Meta account (Muse Code subscription) or paste a Model API key from dev.meta.ai. Subscription keys are minted per account; Meta may train on contributor-tier data.",
      apiKeyUrl: "https://dev.meta.ai",
      signupUrl: "https://muse.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.meta.ai/v1/responses",
    // Setiap model di sini di-pin ke Responses (lihat catatan di bawah), jadi
    // default pun harus menunjuk /responses. Kalau tidak, jalur yang TIDAK
    // melewati `transports` (mis. override koneksi) mengirim body Responses ke
    // /chat/completions dan Meta menjawab 400 `unknown parameter 'input'`.
    format: "openai-responses",
    // Responses hanya dilayani sebagai SSE — body JSON non-stream dijawab
    // event-stream juga. Semua konsumen Meta yang sudah ada (meta-code)
    // memakai forceStream karena alasan yang sama.
    forceStream: true,
    // Meta 400s on Chat-style top-level `reasoning_effort`; it must be nested
    // as `reasoning.effort` — sama seperti meta-code.
    quirks: { foldReasoningEffort: true },
    validateUrl: "https://api.meta.ai/v1/models",
    modelsUrl: "https://api.meta.ai/v1/models",
    auth: { combined: true, header: "Authorization", scheme: "bearer", hooks: ["museHeaders"] },
  },
  // Multi-endpoint: Meta accepts Chat Completions and Responses wire formats on
  // the same key (https://dev.meta.ai/docs/protocols). Muse Spark reasoning
  // (incl. encrypted_content replay) only round-trips on Responses, so models
  // pin targetFormat there.
  //
  // The transports below are the accepted grammar of this engine — the
  // sourceFormat-matched pick at chatCore.js:108-120 — but they are NOT what
  // currently routes these models. Because every model declares
  // `supportedFormats: ["openai-responses"]`, the guard at chatCore.js:113
  // rejects the match for any other client format and `modelTargetFormat`
  // wins; the URL then comes from `transport.baseUrl` above.
  //
  // Consequence to keep in mind: an OpenAI-*format* client (Claude Code,
  // dashboard probe, /v1/chat/completions) is still TRANSLATED to Responses
  // and answered from /responses. That is intended — Meta's Muse Spark
  // reasoning only round-trips on Responses. Only a client that already
  // speaks `openai-responses` takes the zero-translation lane.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.meta.ai/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer", hooks: ["museHeaders"] },
    },
    {
      format: "openai-responses",
      baseUrl: "https://api.meta.ai/v1/responses",
      auth: { combined: true, header: "Authorization", scheme: "bearer", hooks: ["museHeaders"] },
    },
  ],
  models: [
    { id: "muse-spark-1.3", name: "Muse Spark 1.3", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.2", name: "Muse Spark 1.2", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.1", name: "Muse Spark 1.1", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
  ],
  passthroughModels: true,
  oauth: {
    clientId: "1031625952748946",
    deviceCodeUrl: "https://auth.meta.com/oidc/device/authorization/",
    tokenUrl: "https://auth.meta.com/oidc/device/token/",
  },
};
