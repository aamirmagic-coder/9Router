/**
 * Antigravity project isolation — regresi 403 SUBSCRIPTION_REQUIRED (#3501).
 *
 * Kejadian nyata (2026-09-20): burst 403 "You do not have a valid license of
 * this product" melanda akun-akun sehat. Direproduksi deterministik:
 *
 *   host                            | project milik akun | project asing
 *   daily-cloudcode-pa              |        200         |     200
 *   autopush-cloudcode-pa.sandbox   |        200         |   403 #3501
 *   staging-cloudcode-pa.sandbox    |        200         |   403 #3501
 *
 * (own 21/21 -> 200, foreign 28/28 -> 403, urutan arm diacak.)
 *
 * Penyebabnya: AntigravityExecutor adalah SINGLETON (executors/index.js) dan
 * transformRequest menyimpan project pertama yang pernah dilihat ke
 * `this.projectId`, lalu memakainya untuk SEMUA akun berikutnya. Begitu satu
 * akun dengan project berbeda lewat, request berikutnya mengirim project milik
 * akun lain -> 403 di host sandbox.
 *
 * Test ini mengunci: project yang dikirim harus SELALU milik akun yang sedang
 * dilayani, bukan milik akun yang kebetulan lewat lebih dulu.
 */
import { describe, it, expect } from "vitest";

const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");

// Body minimal yang cukup untuk melewati transformRequest tanpa menyentuh
// jalur image/tool yang tidak relevan di sini.
function minimalBody() {
  return {
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 16 },
      sessionId: "s",
    },
  };
}

const MODEL = "claude-opus-4-6-thinking";

describe("Antigravity project isolation", () => {
  it("mengirim project milik akun yang sedang dilayani", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(MODEL, minimalBody(), true, {
      projectId: "project-akun-A", email: "a@contoh.com",
    });
    expect(out.project).toBe("project-akun-A");
  });

  it("TIDAK membocorkan project akun sebelumnya (regresi singleton)", () => {
    // Ini inti bug-nya: dulu akun B menerima project milik akun A.
    const ex = new AntigravityExecutor();

    const a = ex.transformRequest(MODEL, minimalBody(), true, {
      projectId: "project-akun-A", email: "a@contoh.com",
    });
    const b = ex.transformRequest(MODEL, minimalBody(), true, {
      projectId: "project-akun-B", email: "b@contoh.com",
    });
    const c = ex.transformRequest(MODEL, minimalBody(), true, {
      projectId: "project-akun-C", email: "c@contoh.com",
    });

    expect(a.project).toBe("project-akun-A");
    expect(b.project).toBe("project-akun-B");
    expect(c.project).toBe("project-akun-C");
  });

  it("instance berbeda tidak saling mencemari", () => {
    // Bahkan lintas instance: tiap executor harus memakai project requestnya.
    const ex1 = new AntigravityExecutor();
    const ex2 = new AntigravityExecutor();

    const out1 = ex1.transformRequest(MODEL, minimalBody(), true, { projectId: "p-satu" });
    const out2 = ex2.transformRequest(MODEL, minimalBody(), true, { projectId: "p-dua" });

    expect(out1.project).toBe("p-satu");
    expect(out2.project).toBe("p-dua");
  });

  it("akun tanpa projectId TIDAK mengarang project dan tidak mewarisi project lain", () => {
    // Dua kesalahan yang harus dihindari sekaligus:
    //   1. mewarisi project akun sebelumnya (bug singleton)
    //   2. mengarang project acak (generateProjectId) — diukur live: project
    //      acak "bright-wave-ngqrb" dan string kosong SAMA-SAMA 403 #3501 di
    //      autopush, sementara project asli akun 200. Mengarang project tidak
    //      pernah menyelamatkan request; ia hanya menukar satu kegagalan dengan
    //      kegagalan lain sambil menyembunyikan sebabnya.
    const ex = new AntigravityExecutor();

    ex.transformRequest(MODEL, minimalBody(), true, { projectId: "p-punya-seseorang" });
    const orphan = ex.transformRequest(MODEL, minimalBody(), true, { email: "tanpa-project@contoh.com" });

    expect(orphan.project).toBe("");
    expect(orphan.project).not.toBe("p-punya-seseorang");
  });

  it("tidak pernah menghasilkan project bergaya fabrikasi (adj-noun-xxxxx)", () => {
    const ex = new AntigravityExecutor();
    const FABRICATED = /^(useful|bright|swift|calm|bold)-(fuze|wave|spark|flow|core)-[a-z0-9]{5}$/;
    for (const cred of [{ projectId: "aicode-consumers" }, {}, { projectId: "" }]) {
      const out = ex.transformRequest(MODEL, minimalBody(), true, cred);
      expect(FABRICATED.test(String(out.project || ""))).toBe(false);
    }
  });

  it("project yang sama dipakai berulang untuk akun yang sama", () => {
    // Stabilitas: akun yang sama harus mengirim project yang sama tiap kali,
    // supaya tidak ada flip-flop yang memicu 403 sporadis.
    const ex = new AntigravityExecutor();
    const cred = { projectId: "p-stabil", email: "s@contoh.com" };
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push(ex.transformRequest(MODEL, minimalBody(), true, cred).project);
    }
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe("p-stabil");
  });
});

/**
 * Regresi 2026-09-20 (lanjutan): 403 entitlement BUKAN masalah token, dan
 * rotasi yang benar adalah HOST, bukan akun.
 *
 * Log produksi menunjukkan tiap akun memakan 13-15 detik: refresh token
 * (~1s, sia-sia — token-nya valid) lalu request ulang ke HOST YANG SAMA dan
 * 403 lagi (~13s). Enam puluh akun × 30 detik = setengah jam untuk penolakan
 * yang identik.
 */
describe("Antigravity entitlement 403 — retry harus ke host lain, bukan akun lain", () => {
  it("getHostForEntitlementRetry memajukan ke host berikutnya (URL PENUH, bukan base)", async () => {
    // Regresi: versi pertama memakai urls.indexOf(currentUrl) dan selalu gagal
    // karena currentUrl yang dikirim executor adalah URL PENUH
    // (host + /v1internal:streamGenerateContent?alt=sse). Akibatnya retry
    // selalu jatuh ke urls[0] (daily) alih-alih host berikutnya — terlihat di
    // log produksi sebagai "retrying on daily" berulang.
    const { setAntigravityHostMode } = await import("../../open-sse/providers/shared.js");
    setAntigravityHostMode("all-hosts");
    try {
      const ex = new AntigravityExecutor();
      const urls = ex.getBaseUrls();
      expect(urls.length).toBeGreaterThan(1);

      // Bangun URL persis seperti executor melakukannya
      const fullUrl = ex.buildUrl(MODEL, true, 1, { projectId: "p" });
      expect(fullUrl).toContain("/v1internal:");
      expect(fullUrl).not.toBe(urls[1]); // memang URL penuh, bukan base

      const next = ex.getHostForEntitlementRetry(fullUrl);
      expect(next).toBe(urls[2]);      // host KETIGA, bukan host pertama
      expect(next).not.toBe(urls[0]);
    } finally {
      setAntigravityHostMode("all-hosts");
    }
  });

  it("dari host terakhir -> null (tidak ada rotasi tanpa tujuan)", async () => {
    const { setAntigravityHostMode } = await import("../../open-sse/providers/shared.js");
    setAntigravityHostMode("all-hosts");
    try {
      const ex = new AntigravityExecutor();
      const urls = ex.getBaseUrls();
      const fullUrl = ex.buildUrl(MODEL, true, urls.length - 1, { projectId: "p" });
      expect(ex.getHostForEntitlementRetry(fullUrl)).toBeNull();
    } finally {
      setAntigravityHostMode("all-hosts");
    }
  });

  it("default all-hosts: daily DULU, lalu sandbox sebagai cadangan", () => {
    // Diukur 2026-09-20: gemini-3.8-flash hanya 2/8 sukses di daily sementara
    // kedua sandbox 8/8. Default tanpa cadangan akan menggagalkan enam dari
    // delapan akun pada model yang sebenarnya tersedia.
    const ex = new AntigravityExecutor();
    const urls = ex.getBaseUrls();
    expect(urls.length).toBe(3);
    // daily WAJIB pertama — sandbox hanya dicoba setelah daily menolak.
    expect(urls[0]).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(urls[1]).toContain("sandbox");
    expect(urls[2]).toContain("sandbox");
  });

  it("mode daily-only: satu host, tidak ada rotasi sama sekali", async () => {
    const { setAntigravityHostMode } = await import("../../open-sse/providers/shared.js");
    setAntigravityHostMode("daily-only");
    try {
      const ex = new AntigravityExecutor();
      expect(ex.getBaseUrls().length).toBe(1);
      expect(ex.getBaseUrls()[0]).toContain("daily-cloudcode-pa.googleapis.com");
      expect(ex.getHostForEntitlementRetry(ex.getBaseUrls()[0])).toBeNull();
    } finally {
      setAntigravityHostMode("all-hosts");
    }
  });

  it("host tak dikenal jatuh ke host pertama, bukan crash", () => {
    const ex = new AntigravityExecutor();
    expect(ex.getHostForEntitlementRetry("https://contoh-tidak-dikenal.invalid")).toBe(ex.getBaseUrls()[0]);
  });

  it("403 TIDAK memicu rotasi host di loop internal executor (perilaku lama dipertahankan)", () => {
    // Rotasi entitlement ditangani chatCore, bukan shouldRetry. 403 auth biasa
    // (token mati) tetap tidak merotasi host — itu sudah benar.
    const ex = new AntigravityExecutor();
    expect(ex.shouldRetry(403, 0)).toBe(false);
    expect(ex.shouldRetry(401, 0)).toBe(false);
  });
});
