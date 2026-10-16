/**
 * Klasifikasi akun di menu Automation.
 *
 * ── Mengapa tes ini penting ─────────────────────────────────────────────────
 *
 * Dua kesalahan klasifikasi di sini BUKAN hipotetis — keduanya terukur pada
 * instalasi nyata dan pada skrip yang jadi sumber fitur ini:
 *
 * 1. **146 dari 156 akun grok-cli punya `lastError` berisi `400
 *    input_too_large`** ("prompt is too long for this model's context window").
 *    Semuanya sehat. Kalau UI menandai "bermasalah" hanya karena `lastError`
 *    ada isinya, ia melaporkan 146 akun sehat sebagai rusak.
 *
 * 2. **Skrip `ag` memakai ambang `pct < 1` tanpa mengecualikan sentinel `-1`**
 *    ("kuota tidak terbaca"), dan `-1 < 1` bernilai benar — akun yang kuotanya
 *    gagal dibaca ikut terhapus. Versi web tidak boleh mewarisi itu.
 *
 * Tes ini memaku kedua aturan tersebut pada fungsi klasifikasinya, bukan pada
 * komponen UI, supaya keduanya tetap berlaku di jalur mana pun yang memakainya.
 */
import { describe, it, expect } from "vitest";
import {
  classifyConnectionError,
  effectiveStatus,
  classifyUsage,
  selectDeleteCandidates,
} from "../../src/lib/automation/operations.js";

describe("klasifikasi error koneksi", () => {
  it("prompt kepanjangan BUKAN masalah akun", () => {
    // Persis bentuk yang terukur di database: 146 akun.
    const c = {
      errorCode: 400,
      lastError:
        '[400]: {"code":"invalid-argument","error":"Failed to start sampling: [input_too_large] The prompt is too long for this model\'s context window (596646 tokens > 500000 tokens)"}',
    };
    const r = classifyConnectionError(c);
    expect(r.state).toBe("request_too_large");
    // Dan yang paling penting: ia tidak boleh masuk kategori yang bisa dihapus.
    expect(["invalid", "depleted"]).not.toContain(r.state);
  });

  it("variasi pesan prompt-kepanjangan lain juga dikenali", () => {
    for (const msg of [
      "context window exceeded",
      "invalid_request_error: too long",
      "prompt is too long",
    ]) {
      expect(classifyConnectionError({ errorCode: 400, lastError: msg }).state).toBe(
        "request_too_large",
      );
    }
  });

  it("401/403 adalah kredensial mati — satu-satunya yang aman diusulkan hapus", () => {
    expect(classifyConnectionError({ errorCode: 401, lastError: "Unauthorized" }).state).toBe("invalid");
    expect(classifyConnectionError({ errorCode: 403, lastError: "Forbidden" }).state).toBe("invalid");
    expect(
      classifyConnectionError({ lastError: "invalid_grant: token revoked" }).state,
    ).toBe("invalid");
  });

  it("402 dan kata kuota adalah kuota habis", () => {
    expect(classifyConnectionError({ errorCode: 402, lastError: "Payment required" }).state).toBe("depleted");
    expect(
      classifyConnectionError({ lastError: "insufficient balance: balance=0" }).state,
    ).toBe("depleted");
    expect(classifyConnectionError({ lastError: "spending-limit reached" }).state).toBe("depleted");
  });

  it("429 dan gangguan jaringan BUKAN alasan menghapus", () => {
    const rate = classifyConnectionError({ errorCode: 429, lastError: "Too Many Requests" });
    const net = classifyConnectionError({ lastError: "fetch connect timeout" });
    expect(rate.state).toBe("rate_limited");
    expect(net.state).toBe("transient");
    for (const r of [rate, net]) {
      expect(["invalid", "depleted"]).not.toContain(r.state);
    }
  });

  it("tanpa error sama sekali", () => {
    expect(classifyConnectionError({}).state).toBe("none");
    expect(classifyConnectionError(null).state).toBe("none");
  });
});

describe("status efektif koneksi", () => {
  it("unavailable dengan cooldown yang SUDAH lewat berarti aktif", () => {
    // Dashboard 9Router memakai aturan ini; tanpa itu, 146 dari 156 akun
    // tampil "rusak" padahal hanya sedang istirahat.
    const past = new Date(Date.now() - 60_000).toISOString();
    const r = effectiveStatus({ isActive: true, testStatus: "unavailable", "modelLock_x": past });
    expect(r).toBe("active");
  });

  it("unavailable dengan cooldown yang MASIH berjalan berarti cooling", () => {
    const future = new Date(Date.now() + 300_000).toISOString();
    expect(
      effectiveStatus({ isActive: true, testStatus: "unavailable", "modelLock_x": future }),
    ).toBe("cooling");
  });

  it("isActive=false selalu nonaktif, apa pun testStatus-nya", () => {
    expect(effectiveStatus({ isActive: false, testStatus: "active" })).toBe("inactive");
  });
});

describe("klasifikasi kuota", () => {
  it("remainingPercentage terendah menentukan keadaan", () => {
    const r = classifyUsage({
      plan: "Grok Code",
      quotas: [
        { modelId: "a", remainingPercentage: 80 },
        { modelId: "b", remainingPercentage: 12 },
      ],
    });
    expect(r.state).toBe("low");
    expect(r.remaining).toBe(12);
  });

  it("nol persen berarti habis", () => {
    const r = classifyUsage({
      quotas: [{ modelId: "On-demand", remainingPercentage: 0, resetAt: "2026-09-29T00:00:00.000Z" }],
    });
    expect(r.state).toBe("depleted");
    expect(r.resetAt).toBe("2026-09-29T00:00:00.000Z");
  });

  it("kuota tak terbaca TIDAK PERNAH berarti habis", () => {
    // Ini bug skrip `ag`: sentinel -1 ("N/A") bernilai < 1 sehingga akun yang
    // kuotanya gagal dibaca ikut terhapus. Di sini keadaannya "unknown".
    for (const payload of [
      { message: "Usage not available for this connection" },
      { quotas: [] },
      null,
      {},
    ]) {
      const r = classifyUsage(payload);
      expect(r.state).not.toBe("depleted");
      expect(r.remaining).toBeNull();
    }
  });

  it("unlimited tidak dihitung sebagai sisa yang menipis", () => {
    const r = classifyUsage({ quotas: [{ modelId: "x", remainingPercentage: 0, unlimited: true }] });
    expect(r.state).toBe("unlimited");
  });
});

describe("pemilihan kandidat hapus", () => {
  it("hanya depleted dan invalid yang lolos", () => {
    const results = [
      { id: "1", state: "depleted" },
      { id: "2", state: "invalid" },
      { id: "3", state: "healthy" },
      { id: "4", state: "unknown" },
      { id: "5", state: "unsupported" },
      { id: "6", error: "fetch timeout" },
    ];
    const picked = selectDeleteCandidates(results);
    expect(picked.map((p) => p.id).sort()).toEqual(["1", "2"]);
  });

  it("daftar kosong menghasilkan kosong, bukan semua", () => {
    expect(selectDeleteCandidates([])).toEqual([]);
    expect(selectDeleteCandidates(null)).toEqual([]);
  });
});
