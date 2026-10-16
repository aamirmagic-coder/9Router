/**
 * Matematika animasi angka — dipisah dari hook supaya bisa diuji tanpa DOM.
 *
 * ── Yang diuji, dan mengapa justru ini ──────────────────────────────────────
 *
 * Yang bisa salah pada animasi angka bukan `requestAnimationFrame`-nya — itu
 * perkabelan yang diverifikasi di browser. Yang bisa salah adalah:
 *
 * 1. **Easing yang melewati target.** Kurva yang salah membuat angka menyentuh
 *    $3,80 sebelum mendarat di $3,69. Untuk angka uang, itu bukan cacat visual.
 * 2. **Nilai antara yang salah saat `from > to`.** Angka yang turun harus
 *    berjalan turun, bukan melompat.
 * 3. **Nilai tak sah yang merambat.** `NaN` sekali masuk ke interpolasi akan
 *    membuat seluruh angka di halaman itu `NaN` selamanya.
 * 4. **Animasi untuk nilai yang tidak berubah.** SSE mengirim angka sama
 *    beberapa kali per detik; tanpa penjagaan, angkanya berkedip tanpa berubah.
 * 5. **Daftar yang panjangnya berubah.** Provider muncul/hilang saat disaring;
 *    interpolasi antar-daftar berbeda panjang harus jatuh ke nilai tujuan,
 *    bukan menghasilkan `undefined` yang merambat ke tata letak.
 *
 * Hook-nya sendiri diuji di browser (`capture` + probe), karena di sanalah
 * `requestAnimationFrame` dan `matchMedia` benar-benar ada.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = resolve(
  HERE,
  "../../src/app/(dashboard)/dashboard/usage/components/stack/useAnimatedNumber.js",
);

const { easeOutCubic, interpolate, interpolateList, shouldAnimate, safeNumber } =
  await import(MOD);

const FORMAT = resolve(
  HERE,
  "../../src/app/(dashboard)/dashboard/usage/components/stack/format.js",
);
const { fmtWhole, fmtFull } = await import(FORMAT);

describe("easing", () => {
  it("mulai di 0 dan berakhir di 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("tidak pernah melewati 1 — angka uang tidak boleh menyentuh nilai lebih", () => {
    // Kurva yang melewati target membuat $3,69 sempat terbaca $3,80.
    for (let t = 0; t <= 1.0001; t += 0.01) {
      expect(easeOutCubic(t)).toBeLessThanOrEqual(1);
    }
  });

  it("monoton naik", () => {
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.02) {
      const v = easeOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("cepat di awal, melambat di akhir", () => {
    // Setengah waktu → sudah lebih dari setengah jarak.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe("interpolasi", () => {
  it("nilai di ujung adalah ujungnya", () => {
    expect(interpolate(0, 100, 0)).toBe(0);
    expect(interpolate(0, 100, 1)).toBe(100);
  });

  it("bergerak ke ATAS dengan benar", () => {
    expect(interpolate(0, 100, 0.5)).toBeGreaterThan(0);
    expect(interpolate(0, 100, 0.5)).toBeLessThan(100);
  });

  it("bergerak ke BAWAH juga benar — bukan melompat", () => {
    const mid = interpolate(100, 0, 0.5);
    expect(mid).toBeLessThan(100);
    expect(mid).toBeGreaterThan(0);
  });

  it("t negatif atau lebih dari 1 dijepit, tidak melewati target", () => {
    expect(interpolate(0, 100, -5)).toBe(0);
    expect(interpolate(0, 100, 5)).toBe(100);
  });

  it("mendarat TEPAT di nilai berdesimal", () => {
    // Selisih floating-point terlihat di kolom angka yang rata kanan.
    expect(interpolate(0, 3.69, 1)).toBe(3.69);
  });
});

describe("interpolasi daftar", () => {
  it("menginterpolasi tiap posisi secara terpisah", () => {
    const mid = interpolateList([0, 0], [100, 200], 0.5);
    expect(mid[0]).toBeGreaterThan(0);
    expect(mid[0]).toBeLessThan(100);
    expect(mid[1]).toBeGreaterThan(mid[0]);
  });

  it("panjang berbeda → langsung nilai tujuan, bukan undefined", () => {
    // Provider muncul/hilang saat halaman disaring.
    expect(interpolateList([1, 2], [10, 20, 30], 0.5)).toEqual([10, 20, 30]);
    expect(interpolateList([1, 2, 3], [10, 20], 0.5)).toEqual([10, 20]);
  });

  it("daftar kosong aman", () => {
    expect(interpolateList([], [], 0.5)).toEqual([]);
    expect(interpolateList(null, [], 0.5)).toEqual([]);
    expect(interpolateList([1], null, 0.5)).toEqual([]);
  });
});

describe("kapan animasi dijalankan", () => {
  it("nilai yang sama TIDAK dianimasikan", () => {
    // SSE mengirim angka sama beberapa kali per detik.
    expect(shouldAnimate(42, 42)).toBe(false);
  });

  it("nilai yang berubah dianimasikan", () => {
    expect(shouldAnimate(42, 43)).toBe(true);
    expect(shouldAnimate(0, 0.0001)).toBe(true);
  });

  it("nilai tujuan tidak sah tidak dianimasikan", () => {
    expect(shouldAnimate(42, NaN)).toBe(false);
    expect(shouldAnimate(42, Infinity)).toBe(false);
  });
});

describe("nilai tak sah", () => {
  it("NaN, undefined, null, dan string aneh jadi 0", () => {
    // Sekali NaN masuk ke interpolasi, seluruh angka di halaman itu NaN
    // selamanya — dan tidak ada yang tahu kenapa.
    expect(safeNumber(NaN)).toBe(0);
    expect(safeNumber(undefined)).toBe(0);
    expect(safeNumber(null)).toBe(0);
    expect(safeNumber("bukan angka")).toBe(0);
    expect(safeNumber(Infinity)).toBe(0);
  });

  it("angka yang sah lewat apa adanya", () => {
    expect(safeNumber(0)).toBe(0);
    expect(safeNumber(3.69)).toBe(3.69);
    expect(safeNumber(-5)).toBe(-5);
    expect(safeNumber("42")).toBe(42);
  });
});

describe("pemformatan token yang sedang beranimasi", () => {
  it("fmtFull mencetak desimal di tengah animasi — itu sebabnya fmtWhole ada", () => {
    // Bukan bug di fmtFull: ia memang untuk nilai final. Yang salah adalah
    // memakainya untuk nilai antara.
    expect(fmtFull(1234.567)).toBe("1,234.567");
  });

  it("fmtWhole selalu bulat, jadi token tidak pernah tampil setengah", () => {
    expect(fmtWhole(1234.567)).toBe("1,235");
    expect(fmtWhole(1234.4)).toBe("1,234");
    expect(fmtWhole(0.9)).toBe("1");
    expect(fmtWhole(0)).toBe("0");
  });

  it("fmtWhole memakai pemisah ribuan yang sama dengan fmtFull", () => {
    expect(fmtWhole(16042831.295)).toBe(fmtFull(16042831));
  });

  it("nilai tak sah tidak pernah menjadi NaN di layar", () => {
    expect(fmtWhole(NaN)).toBe("0");
    expect(fmtWhole(undefined)).toBe("0");
    expect(fmtWhole(Infinity)).toBe("0");
    expect(fmtWhole("bukan angka")).toBe("0");
  });
});
