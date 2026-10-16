/**
 * Rotasi host saat kapasitas model habis (503 "No capacity available").
 *
 * Latar: Google menjalankan pool kapasitas TERPISAH per host. Saat `daily`
 * kelelahan untuk sebuah model, host sandbox masih penuh. Diukur live
 * 2026-09-13 pada 40 akun, claude-opus-4-6-thinking:
 *
 *   daily-cloudcode-pa.googleapis.com              →  5% sukses (503)
 *   autopush-cloudcode-pa.sandbox.googleapis.com   → 100% sukses
 *   staging-cloudcode-pa.sandbox.googleapis.com    → 100% sukses
 *
 * Test ini memverifikasi lewat EXECUTOR ASLI: saat host pertama menjawab 503,
 * request harus maju ke host berikutnya dan (di sini) berhasil.
 *
 * proxyAwareFetch di-mock, jadi test ini TIDAK menyentuh jaringan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hostsTried = [];

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url) => {
    const host = new URL(typeof url === "string" ? url : url.url).host;
    hostsTried.push(host);
    // Host pertama selalu 503 kapasitas-habis; sisanya sukses.
    if (hostsTried.length === 1) {
      return new Response(
        JSON.stringify({ error: {
          code: 503,
          message: "No capacity available for model claude-opus-4-6-thinking on the server.",
          status: "UNAVAILABLE",
        } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ response: { candidates: [] } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  },
}));

const CREDS = { accessToken: "test-token", projectId: "test-project" };
const LOG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const BODY = { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }],
                          generationConfig: { maxOutputTokens: 16 } } };

describe("Antigravity — rotasi host saat kapasitas habis", () => {
  beforeEach(() => { hostsTried.length = 0; });

  it("mode sandbox: maju ke host berikutnya saat 503 dan berhasil di sana", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { setAntigravityHostMode } = await import("../../open-sse/providers/shared.js");
    // Rotasi host hanya berlaku kalau lebih dari satu host aktif. Default
    // sekarang daily-only (mengikuti upstream + CLIProxyAPI), jadi test ini
    // menyalakan mode sandbox dulu.
    setAntigravityHostMode("all-hosts");
    try {
      const ex = new AntigravityExecutor();

      const res = await ex.execute({
        model: "claude-opus-4-6-thinking",
        body: BODY, stream: false, credentials: CREDS,
        signal: AbortSignal.timeout(30000), log: LOG,
      });

      expect(hostsTried[0]).toMatch(/^daily-cloudcode-pa\./);
      expect(hostsTried.length).toBeGreaterThan(1);
      expect(hostsTried[1]).toMatch(/sandbox/);
      expect(res?.response?.status).toBe(200);
    } finally {
      setAntigravityHostMode("all-hosts");
    }
  }, 30000);

  it("mode daily-only eksplisit: 503 TIDAK memutar host (tidak ada tujuan)", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { setAntigravityHostMode } = await import("../../open-sse/providers/shared.js");
    setAntigravityHostMode("daily-only");
    const ex = new AntigravityExecutor();
    expect(ex.getBaseUrls().length).toBe(1);
    expect(ex.shouldRetry(503, 0)).toBe(false);
  }, 30000);

  it("tidak memutar host untuk error permanen (401 akun mati)", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();

    // 401 -> bukan kapasitas, biar chatCore yang ganti akun.
    expect(ex.shouldRetry(401, 0)).toBe(false);
    expect(ex.shouldRetry(403, 0)).toBe(false);
    expect(ex.shouldRetry(400, 0)).toBe(false);
  });

  it("berhenti di host terakhir (tidak ada rotasi tanpa tujuan)", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();
    const last = ex.getFallbackCount() - 1;

    expect(ex.shouldRetry(503, last)).toBe(false);
    expect(ex.shouldRetry(500, last)).toBe(false);
    expect(ex.shouldRetry(429, last)).toBe(false);
  });

  it("mode sandbox: mempertahankan 429 sebagai pemicu rotasi (perilaku lama)", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { setAntigravityHostMode } = await import("../../open-sse/providers/shared.js");
    setAntigravityHostMode("all-hosts");
    try {
      const ex = new AntigravityExecutor();
      expect(ex.shouldRetry(429, 0)).toBe(true);
    } finally {
      setAntigravityHostMode("all-hosts");
    }
  });
});
