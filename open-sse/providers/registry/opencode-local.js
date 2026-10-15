export default {
  id: "opencode-local",
  priority: 41,
  hasFree: true,
  alias: "ocl",
  aliases: [
    "ocl",
  ],
  uiAlias: "ocl",
  display: {
    name: "OpenCode Local",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OL",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai/inference/openai/v1/chat/completions",
    headers: {
      "x-opencode-client": "desktop",
    },
    forceStream: true,
    noAuth: true,
  },
  // Endpoint verified live: UA opencode/* + x-opencode-session + tool fingerprint
  // + stream:true on /inference returns 200 where /zen 403s on the same combo.
  transports: [
    { format: "openai", baseUrl: "https://opencode.ai/inference/openai/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
  ],
  models: [
    { id: "space-bunny-free", name: "Space Bunny Free", supportedFormats: ["openai"] },
    { id: "big-pickle", name: "Big Pickle", supportedFormats: ["openai"] },
    { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free", supportedFormats: ["openai"] },
    { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free", supportedFormats: ["openai"] },
    { id: "ling-3.1-flash-free", name: "Ling 3.1 Flash Free", supportedFormats: ["openai"] },
    { id: "cat-jam-free", name: "Cat Jam Free", supportedFormats: ["openai"] },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", supportedFormats: ["openai"] },
    { id: "step-5-preview-free", name: "Step 5 Preview Free", supportedFormats: ["openai"] },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", supportedFormats: ["openai"] },
  ],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
