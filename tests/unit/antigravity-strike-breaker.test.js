/**
 * Strike breaker Antigravity — perilaku saat pool 429 secara menyeluruh.
 *
 * Kejadian nyata 2026-09-20 (log produksi 19:09-19:10): gemini-3.8-flash-high
 * kena 429 di SETIAP akun, satu per satu, sampai puluhan akun terbakar dalam
 * ~2 menit. Tidak ada akun yang mencapai 3 strike karena router BERPINDAH
 * akun setiap kali — jadi strike per-akun tidak pernah memicu.
 *
 * Test ini mengunci dua hal:
 *   1. strike per-akun tetap bekerja (3x pada akun yang sama → block 15m)
 *   2. 429 beruntun pada akun BERBEDA dalam waktu singkat harus terdeteksi
 *      sebagai kondisi pool, bukan dibiarkan membakar seluruh akun
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = { quota: 0, cacheBlocks: [] };

// Quota API selalu melaporkan SISA BANYAK (optimistis) — persis kondisi nyata
// saat 429 generik muncul: upstream bilang kuota ada, tapi generate menolak.
vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: async () => {
    calls.quota++;
    return { quotas: { gemini_weekly: { remainingPercentage: 99.9, resetAt: null } } };
  },
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({}),
}));

const {
  handleAntigravityQuotaError,
  clearAntigravityStrikes,
  getAntigravityQuotaCache,
  _resetStrikeStateForTest,
} = await import("../../src/sse/services/antigravityQuota.js");

describe("Antigravity strike breaker", () => {
  beforeEach(() => {
    calls.quota = 0;
    _resetStrikeStateForTest?.();
  });

  it("3x 429 pada akun yang SAMA → block 15 menit", async () => {
    const conn = "acct-sama";
    let blocked = null;
    for (let i = 0; i < 3; i++) {
      blocked = await handleAntigravityQuotaError(conn, 429, "gemini-3.8-flash-high", "tok", {});
    }
    expect(blocked).not.toBeNull();
    const cache = getAntigravityQuotaCache();
    expect(cache.get(conn)?.["gemini-3.8-flash-high"]?.remainingPercentage).toBe(0);
  });

  it("429 pada akun BERBEDA beruntun → kondisi pool terdeteksi", async () => {
    // Inilah pola di log produksi: fpa28, fpa49, fpa6, rajwaarahmana45, fpa3,
    // fpa36, fpa12 — tujuh akun berbeda, masing-masing SEKALI. Strike per-akun
    // tidak pernah mencapai 3, jadi tanpa deteksi tingkat-pool seluruh isi
    // akun akan dicoba satu per satu.
    const accounts = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
    const results = [];
    for (const acct of accounts) {
      results.push(await handleAntigravityQuotaError(acct, 429, "gemini-3.8-flash-high", "tok", {}));
    }
    const blocked = results.filter((r) => r !== null);
    expect(
      blocked.length,
      `7+ akun berbeda kena 429 beruntun harus memicu proteksi pool; dapat ${blocked.length}`
    ).toBeGreaterThan(0);
  });

  it("sukses membersihkan strike akun tersebut", async () => {
    const conn = "acct-clear";
    await handleAntigravityQuotaError(conn, 429, "gemini-3.8-flash-high", "tok", {});
    clearAntigravityStrikes(conn, "gemini-3.8-flash-high");
    // Setelah dibersihkan, butuh 3 strike lagi dari nol.
    const r1 = await handleAntigravityQuotaError(conn, 429, "gemini-3.8-flash-high", "tok", {});
    const r2 = await handleAntigravityQuotaError(conn, 429, "gemini-3.8-flash-high", "tok", {});
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it("model berbeda dihitung terpisah", async () => {
    const conn = "acct-multi";
    await handleAntigravityQuotaError(conn, 429, "gemini-3.8-flash-high", "tok", {});
    await handleAntigravityQuotaError(conn, 429, "gemini-3.8-flash-high", "tok", {});
    // Model lain belum pernah gagal — tidak boleh ikut terblokir.
    const other = await handleAntigravityQuotaError(conn, 429, "claude-opus-4-6-thinking", "tok", {});
    expect(other).toBeNull();
  });
});
