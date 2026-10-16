export default {
  id: "bai",
  priority: 120,
  alias: "bai",
  aliases: [
    "b-ai",
  ],
  uiAlias: "bai",
  display: {
    name: "B.AI",
    icon: "account_balance",
    color: "#0369A1",
    textIcon: "BA",
    website: "https://b.ai",
    notice: {
      text: "OpenAI-compatible gateway with one of the larger catalogues here. Accepts a bearer token or an x-api-key header. Model ids are fetched live from the provider.",
      apiKeyUrl: "https://b.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.b.ai/v1/chat/completions",
    validateUrl: "https://api.b.ai/v1/models",
    // Gagal cepat, lalu rotasi akun — bukan menunggu.
    //
    // Upstream ini punya dua mode lambat yang tidak bisa dibedakan dari luar:
    // rate-limit (429 seketika) dan stall acak yang menahan header respons
    // sampai lewat 60 detik. Yang kedua itu paling merugikan: dengan timeout
    // default 60 detik, satu permintaan Claude Code bisa menggantung semenit
    // penuh sebelum akhirnya menyerah.
    //
    // Diukur langsung ke api.b.ai dengan beban sebesar log asli (87K token +
    // 102 tool definitions): first-byte yang SAH hanya 2,2-4,0 detik. Jadi
    // 25 detik sudah lebih dari 6x margin di atas respons sehat, dan yang
    // melewatinya hampir pasti stall.
    //
    // Menunggu lebih lama bukan strategi yang lebih baik di sini: pool-nya
    // 600+ akun, jadi melempar akun yang macet dan mengambil akun berikutnya
    // (~2-4 detik) jauh lebih cepat daripada berharap akun yang sama sadar.
    // noRetryTimeoutMs disamakan supaya BaseExecutor melewatinya sebagai
    // "unreachable" dan langsung pindah akun; tanpa itu ia akan mengulang
    // 3x x 25 detik sebelum menyerah.
    timeoutMs: 25000,
    noRetryTimeoutMs: 25000,
  },
  // No ids hardcoded: the catalogue is large and rotates, so the live endpoint
  // is the source of truth and any id is accepted via passthroughModels.
  modelsFetcher: { url: "https://api.b.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
