/**
 * Usage dashboard: mengganti period HARUS mengubah angka.
 *
 * Laporan (24 Sep 2026): pilih Today / 24h / All tidak ada perubahan.
 *
 * Data & backend TERBUKTI benar — dihitung langsung dari SQLite:
 *   today :  211 baris,    42.109.097 token
 *   24h   : 1596 baris,   483.731.444 token
 *   7d    : 9342 request, 2.505.433.893 token
 *   all   : 53997 request, 15.079.769.084 token
 *
 * Jadi bug-nya di jalur data FRONTEND/SSE. Dua sebab:
 *
 * 1. SSE mengirim `cachedStats` milik period LAMA tapi melabelinya dengan
 *    `period` yang BARU. Klien memeriksa `data.period === period` → cocok →
 *    data lama diterima. Angka di layar tidak berubah.
 *
 * 2. REST memakai `{...prev, ...data}` (merge), sehingga key yang tidak ada di
 *    respons baru tetap tertinggal.
 *
 * ── Mengapa berkas ini menunjuk ke `stack/index.js` ──────────────────────────
 *
 * Sampai 26 Sep 2026 berkas ini membaca `src/shared/components/UsageStats.js`.
 * Komponen itu digantikan `stack/index.js` (lihat `page.js`), lalu DIHAPUS
 * bersama empat komponen lain yang hanya ia pakai. Selama tes ini menunjuk ke
 * sana, ia mengawal kode yang tidak pernah jalan: siapa pun bisa merusak
 * penanganan periode di komponen yang benar-benar dirender, dan tes ini tetap
 * hijau. Penjaga regresi yang menjaga kode mati lebih buruk daripada tidak ada
 * penjaga — ia memberi rasa aman yang salah.
 *
 * Assertion-nya TIDAK dilonggarkan, hanya dipindahkan ke jalur yang dipakai
 * produksi. Urutan empat sebab di bawah mengikuti alasan yang sama persis:
 * komponen baru memang menyalin pola ini dari yang lama justru karena setiap
 * barisnya lahir dari bug nyata.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");
const STREAM = readFileSync(resolve(REPO, "src/app/api/usage/stream/route.js"), "utf8");
const STACK = readFileSync(
  resolve(REPO, "src/app/(dashboard)/dashboard/usage/components/stack/index.js"),
  "utf8",
);

describe("usage — pergantian period", () => {
  it("komponen yang diuji adalah yang benar-benar dirender halaman", () => {
    // Penjaga untuk penjaga: kalau suatu saat halaman berpindah lagi ke
    // komponen lain, tes ini harus gagal supaya targetnya ikut dipindahkan —
    // bukan diam-diam kembali mengawal kode mati.
    const PAGE = readFileSync(resolve(REPO, "src/app/(dashboard)/dashboard/usage/page.js"), "utf8");
    expect(PAGE).toContain('from "./components/stack"');
  });

  it("SSE mencatat period milik cache", () => {
    // Tanpa ini, cache period lama bisa dilabeli period baru.
    expect(STREAM).toContain("cachedStatsPeriod");
    expect(STREAM).toMatch(/cachedStatsPeriod\s*=\s*period/);
  });

  it("push cepat SSE dilewati bila cache bukan milik period ini", () => {
    // Pola lama: `if (state.cachedStats)` saja — selalu lolos.
    expect(STREAM).not.toMatch(/if \(state\.cachedStats\) \{/);
    expect(STREAM).toMatch(/state\.cachedStatsPeriod === period/);
  });

  it("sendPending juga memeriksa period cache", () => {
    const pending = STREAM.slice(STREAM.indexOf("state.sendPending = async"));
    const head = pending.slice(0, 400);
    expect(head).toContain("cachedStatsPeriod !== period");
  });

  it("REST mengganti key turunan, bukan sekadar merge", () => {
    // Merge saja menyisakan byModel/byProvider dari period sebelumnya.
    expect(STACK).toMatch(/byProvider:\s*data\.byProvider \?\? \{\}/);
    expect(STACK).toMatch(/byModel:\s*data\.byModel \?\? \{\}/);
    expect(STACK).toMatch(/byAccount:\s*data\.byAccount \?\? \{\}/);
    expect(STACK).toMatch(/last10Minutes:\s*data\.last10Minutes \?\? \[\]/);
  });

  it("REST membatalkan fetch lama saat period berganti", () => {
    // Tanpa AbortController, respons period lama bisa menimpa yang baru.
    expect(STACK).toContain("AbortController");
    expect(STACK).toMatch(/return \(\) => ac\.abort\(\)/);
  });

  it("SSE hanya menerima stats penuh bila period-nya cocok", () => {
    // Ini sebab pertama bug, dan ia harus dijaga di sisi klien juga:
    // membandingkan `data.period` dengan period yang sedang dipakai adalah
    // satu-satunya yang membedakan "data period ini" dari "cache period lama
    // berlabel baru".
    //
    // Pembandingnya adalah nilai yang berlaku SEKARANG (`periodRef.current`),
    // bukan `period` yang tertangkap saat effect dibuat. SSE hidup lebih lama
    // dari satu nilai period: dengan pembanding yang basi, pesan dari stream
    // lama bisa dinilai cocok untuk period yang baru saja dipilih.
    expect(STACK).toMatch(/data\.period === current/);
    expect(STACK).toMatch(/const current = periodRef\.current/);
  });

  it("kedua endpoint tetap menerima period yang sama", () => {
    // Kontrak API tidak boleh berubah — bug-nya di pemakaian, bukan di API.
    expect(STACK).toContain("/api/usage/stats?period=");
    expect(STACK).toContain("/api/usage/stream?period=");
    expect(STREAM).toMatch(/getUsageStats\(period\)/);
  });
});
