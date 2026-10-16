/**
 * Operasi khas provider di menu Automation.
 *
 * Memaku tiga aturan yang disalin dari skrip Python sumbernya — plus dua
 * pengecualian yang disengaja:
 *
 * 1. Kuota objek (`quotas{}` ala kiro/grok-cli/antigravity) ikut terbaca,
 *    bukan "tidak terbaca". Baris kiro tanpa `remainingPercentage` tapi punya
 *    `used`/`total` dihitung persennya.
 * 2. Grup AG (Gemini vs Claude & GPT) yang tidak ada barisnya = `null`, dan
 *    `null` TIDAK PERNAH lolos hapus 0% (bug sentinel skrip tidak ditiru).
 * 3. `selectExpiredConnections` mengabaikan gagal-parse dan `isActive=false`.
 * 4. `selectInactiveConnections` ketat: hanya `isActive === false`.
 */
import { describe, it, expect } from "vitest";
import { classifyUsage } from "../../src/lib/automation/operations.js";
import {
  selectByIndex,
  selectAgGroupDepleted,
  clineCategory,
  selectClineByCategory,
  selectExpiredConnections,
  classifyInactiveAccount,
  selectInactiveConnections,
  domainBreakdown,
} from "../../src/lib/automation/filters.js";

describe("klasifikasi kuota objek (kiro/grok/antigravity)", () => {
  it("baris objek tanpa remainingPercentage dihitung dari used/total", () => {
    const r = classifyUsage({
      plan: "Kiro",
      quotas: { AGENTIC_REQUEST: { used: 30, total: 100 } },
    });
    expect(r.state).toBe("healthy");
    expect(r.remaining).toBe(70);
    expect(r.pool).toMatchObject({ used: 30, total: 100, remaining: 70 });
  });

  it("grup AG dihitung per keluarga; yang tak ada barisnya null", () => {
    const r = classifyUsage({
      quotas: {
        "gemini-3.8-flash-high": { used: 900, total: 1000, remainingPercentage: 10 },
        "claude-sonnet-4-6": { used: 1000, total: 1000, remainingPercentage: 0 },
      },
    });
    expect(r.groups.gemini).toBe(10);
    expect(r.groups.claudeGpt).toBe(0);
    expect(r.state).toBe("depleted");
  });

  it("grup yang tidak ada barisnya null — bukan 0", () => {
    const r = classifyUsage({
      quotas: { "gemini-3.8-flash-high": { used: 100, total: 1000, remainingPercentage: 90 } },
    });
    expect(r.groups.gemini).toBe(90);
    expect(r.groups.claudeGpt).toBeNull();
  });

  it("baris mingguan ikut grupnya", () => {
    const r = classifyUsage({
      quotas: {
        "Gemini (Weekly)": { used: 1000, total: 1000, remainingPercentage: 0 },
      },
    });
    expect(r.groups.gemini).toBe(0);
    expect(r.groups.claudeGpt).toBeNull();
  });
});

describe("hapus 0% per grup AG", () => {
  const rows = [
    { id: "a", groups: { gemini: 0, claudeGpt: 50 } },
    { id: "b", groups: { gemini: 40, claudeGpt: 0 } },
    { id: "c", groups: { gemini: null, claudeGpt: null } },
    { id: "d", groups: { gemini: 0.5, claudeGpt: 0.5 } },
  ];

  it("mode claude hanya yang grup claude < 1", () => {
    expect(selectAgGroupDepleted(rows, "claude").map((r) => r.id).sort()).toEqual(["b", "d"]);
  });

  it("mode gemini hanya yang grup gemini < 1", () => {
    expect(selectAgGroupDepleted(rows, "gemini").map((r) => r.id).sort()).toEqual(["a", "d"]);
  });

  it("mode both butuh keduanya < 1; null tidak pernah lolos", () => {
    expect(selectAgGroupDepleted(rows, "both").map((r) => r.id)).toEqual(["d"]);
  });
});

describe("pilih indeks ala skrip ag menu 5", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}` }));

  it("satu nomor", () => {
    expect(selectByIndex(items, "5").map((r) => r.id)).toEqual(["c5"]);
  });

  it("koma + rentang", () => {
    expect(selectByIndex(items, "1, 5, 10-12").map((r) => r.id)).toEqual(["c1", "c5", "c10", "c11", "c12"]);
  });

  it("all dan kosong = semua", () => {
    expect(selectByIndex(items, "all")).toHaveLength(12);
    expect(selectByIndex(items, "")).toHaveLength(12);
  });

  it("di luar rentang diabaikan", () => {
    expect(selectByIndex(items, "99")).toEqual([]);
  });
});

describe("kategori cline", () => {
  const now = Date.now();
  const rows = [
    { id: "m1", errorState: "invalid" },
    { id: "m2", errorState: "rate_limited" },
    { id: "m3", errorState: "transient" },
    { id: "m4", expiresAt: new Date(now - 1000).toISOString() },
    { id: "m5", errorState: "none" },
  ];

  it("memetakan tiap baris ke kategorinya", () => {
    expect(clineCategory(rows[0], now)).toBe("mati");
    expect(clineCategory(rows[1], now)).toBe("limit");
    expect(clineCategory(rows[2], now)).toBe("error");
    expect(clineCategory(rows[3], now)).toBe("expired");
    expect(clineCategory(rows[4], now)).toBeNull();
  });

  it("seleksi per kategori hanya yang cocok", () => {
    expect(selectClineByCategory(rows, "mati", now).map((r) => r.id)).toEqual(["m1"]);
    expect(selectClineByCategory(rows, "expired", now).map((r) => r.id)).toEqual(["m4"]);
  });
});

describe("kedaluwarsa tokenharbor", () => {
  const now = Date.now();
  const rows = [
    { id: "e1", email: "a@x.com", expiresAt: new Date(now - 1000).toISOString(), isActive: true },
    { id: "e2", email: "b@x.com", expiresAt: new Date(now + 3600_000).toISOString(), isActive: true },
    { id: "e3", email: "c@x.com", expiresAt: "bukan-tanggal", isActive: true },
    { id: "e4", email: "d@x.com", expiresAt: new Date(now - 1000).toISOString(), isActive: false },
    { id: "e5", email: "e@x.com", isActive: true },
  ];

  it("hanya yang sudah lewat yang dipilih; gagal parse + nonaktif diabaikan", () => {
    expect(selectExpiredConnections(rows, { nowMs: now }).map((r) => r.id)).toEqual(["e1"]);
  });

  it("hoursAhead ikut menampilkan yang segera habis", () => {
    expect(selectExpiredConnections(rows, { hoursAhead: 2, nowMs: now }).map((r) => r.id)).toEqual([
      "e1",
      "e2",
    ]);
  });
});

describe("nonaktif ala skrip ag menu 12", () => {
  it("ketat: hanya isActive === false", () => {
    const rows = [
      { id: "n1", isActive: false, lastError: "invalid_grant: revoked" },
      { id: "n2", isActive: true },
      { id: "n3", email: "x@y.com" },
      { id: "n4", isActive: null },
    ];
    const picked = selectInactiveConnections(rows);
    expect(picked.map((r) => r.id)).toEqual(["n1"]);
    expect(picked[0].inactiveReason).toBe("invalid_grant");
  });

  it("klasifikasi alasan domain_dead membawa domainnya", () => {
    expect(classifyInactiveAccount({ isActive: false, lastError: "domain_dead:gmaoiil.com" })).toBe(
      "domain_dead:gmaoiil.com",
    );
  });

  it("sebaran domain menandai domain mati total", () => {
    const rows = [
      { email: "a@gmaoiil.com", isActive: false },
      { email: "b@gmaoiil.com", isActive: false },
      { email: "c@gmail.com", isActive: true },
    ];
    const bd = domainBreakdown(rows);
    expect(bd.find((d) => d.domain === "gmaoiil.com").dead).toBe(true);
    expect(bd.find((d) => d.domain === "gmail.com").dead).toBe(false);
  });
});
