/**
 * Warna per provider: unik, stabil, dan cukup terpisah.
 *
 * ── Kenapa ini diuji ────────────────────────────────────────────────────────
 *
 * Tiga sifat yang mudah rusak tanpa terlihat, dan ketiganya merusak gunanya:
 *
 * 1. **Stabil.** Provider yang sama harus dapat warna yang sama setiap kali.
 *    Kalau tidak, "yang biru itu apa tadi?" tidak pernah punya jawaban, dan
 *    warna berhenti jadi penanda.
 *
 * 2. **Terpisah.** Dua provider yang tampil berdampingan tidak boleh berwarna
 *    nyaris sama — itu lebih buruk daripada tidak ada warna, karena tampak
 *    seperti ada hubungan yang sebenarnya tidak ada.
 *
 * 3. **Menambah provider tidak mengocok ulang semuanya.** Kalau menambah satu
 *    provider mengubah warna 40 provider lain, legenda yang dihafal operator
 *    jadi salah. Yang boleh berubah hanya tetangga terdekatnya.
 */
import { describe, it, expect } from "vitest";
import {
  buildProviderColors,
  providerCss,
  providerChipBg,
} from "../../src/app/(dashboard)/dashboard/usage/components/stack/providerColor.js";

/** Jarak terdekat antara dua hue, dengan 360° dibungkus. */
function minHueGap(hues) {
  let min = 360;
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const d = Math.abs(hues[i] - hues[j]);
      min = Math.min(min, Math.min(d, 360 - d));
    }
  }
  return min;
}

describe("warna provider — kestabilan", () => {
  it("provider yang sama dapat warna yang sama di panggilan berbeda", () => {
    const a = buildProviderColors(["b.ai", "grok-cli", "antigravity"]);
    const b = buildProviderColors(["b.ai", "grok-cli", "antigravity"]);
    for (const id of ["b.ai", "grok-cli", "antigravity"]) {
      expect(a.get(id).hue).toBe(b.get(id).hue);
    }
  });

  it("urutan masukan tidak mengubah hasil", () => {
    const a = buildProviderColors(["b.ai", "grok-cli", "antigravity"]);
    const b = buildProviderColors(["antigravity", "b.ai", "grok-cli"]);
    for (const id of ["b.ai", "grok-cli", "antigravity"]) {
      expect(a.get(id).hue).toBe(b.get(id).hue);
    }
  });

  it("daftar kosong tidak melempar", () => {
    expect(buildProviderColors([]).size).toBe(0);
    expect(buildProviderColors([null, undefined, ""]).size).toBe(0);
  });
});

describe("warna provider — keterpisahan", () => {
  /**
   * Ambang jarak, dan cara mendapatkannya.
   *
   * Diukur 29 Sep 2026 pada 23 provider nyata (20 ber-UUID + 3 pendek):
   *
   *   jarak ideal kalau disebar merata (360/23) = 15,65°
   *   langkah maks   1 → jarak minimum  3,11°
   *   langkah maks  20 → jarak minimum  9,29°
   *   langkah maks  40 → jarak minimum  9,95°   ← yang dipakai
   *   langkah maks 360 → jarak minimum 10,14°   ← batas praktisnya
   *
   * Provider ditempatkan SATU PER SATU mulai dari hue hash-nya, bukan disebar
   * merata — jadi 10° adalah batas yang bisa dicapai algoritma ini, bukan
   * 15,65°. Menaikkan langkah ke 360 hanya menambah 0,2° dan tidak sepadan.
   *
   * Yang penting diuji bukan angka idealnya, melainkan bahwa jaraknya JAUH
   * lebih baik daripada sebelumnya: versi pertama berkas ini menghasilkan dua
   * provider berjarak 0,1° — praktis tidak bisa dibedakan.
   */
  const providerNyata = () => {
    const ids = [];
    for (let i = 0; i < 20; i++) {
      ids.push(`openai-compatible-chat-${i.toString(16).padStart(8, "0")}-aaaa`);
    }
    ids.push("b.ai", "grok-cli", "antigravity");
    return ids;
  };

  it("23 provider nyata terpisah setidaknya 9 derajat", () => {
    const ids = providerNyata();
    const map = buildProviderColors(ids);
    const hues = [...map.values()].map((v) => v.hue);
    expect(hues.length).toBe(ids.length);
    // 9° ≈ 90% dari batas praktis 10,14° — memberi ruang untuk perubahan
    // kecil tanpa membuat tesnya rapuh.
    expect(minHueGap(hues)).toBeGreaterThan(9);
  });

  it("37 provider tetap jelas berbeda satu sama lain", () => {
    // Beban lebih berat. Terukur pada himpunan ini:
    //   N = 40  → jarak ideal 9,00° → minimum terukur 5,00°
    //   N = 44  → jarak ideal 8,18° → minimum terukur 4,90°
    // Jadi algoritmanya memberi sekitar 55-60% dari jarak ideal — konsisten,
    // bukan tabrakan. Ambangnya dipasang sedikit di bawah angka terukur itu.
    const ids = [...providerNyata()];
    for (let i = 20; i < 37; i++) ids.push(`openai-compatible-chat-${i.toString(16).padStart(8, "0")}-bbbb`);

    const map = buildProviderColors(ids);
    const gap = minHueGap([...map.values()].map((v) => v.hue));
    expect(gap).toBeGreaterThan(4.5);
  });

  it("tidak ada pasangan yang nyaris identik", () => {
    // Ini inti masalahnya: dua warna berjarak <2° tidak bisa dibedakan mata,
    // dan itu lebih buruk daripada tidak ada warna sama sekali.
    const ids = [...providerNyata(), "deepsik", "openagentic", "gorouter", "bansos"];
    const hues = [...buildProviderColors(ids).values()].map((v) => v.hue);
    let terdekat = 360;
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const d = Math.abs(hues[i] - hues[j]);
        terdekat = Math.min(terdekat, Math.min(d, 360 - d));
      }
    }
    expect(terdekat).toBeGreaterThan(2);
  });

  it("tidak ada dua hue yang identik", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `provider-${i}`);
    const hues = [...buildProviderColors(ids).values()].map((v) => v.hue);
    expect(new Set(hues).size).toBe(hues.length);
  });

  it("menambah provider hanya menggeser sedikit provider lain", () => {
    const awal = Array.from({ length: 12 }, (_, i) => `p${i.toString().padStart(2, "0")}`);
    const sebelum = buildProviderColors(awal);
    const sesudah = buildProviderColors([...awal, "provider-baru"]);

    let berubah = 0;
    for (const id of awal) {
      if (sebelum.get(id).hue !== sesudah.get(id).hue) berubah++;
    }
    // Bukan syarat keras, tapi kalau SEMUA berubah berarti penempatannya tidak
    // deterministik dan legenda yang dihafal operator jadi tidak berguna.
    expect(berubah).toBeLessThan(awal.length);
  });
});

describe("warna provider — bentuk CSS", () => {
  it("menghasilkan oklch yang sah", () => {
    const css = providerCss(210);
    expect(css).toMatch(/^oklch\(/);
    expect(css).not.toContain("NaN");
    expect(css).not.toContain("undefined");
  });

  it("tema gelap lebih terang dari tema terang", () => {
    const terang = providerCss(210, { dark: false });
    const gelap = providerCss(210, { dark: true });
    const L = (s) => Number(s.match(/oklch\(([\d.]+)/)[1]);
    expect(L(gelap)).toBeGreaterThan(L(terang));
  });

  it("tone soft memakai alfa, solid tidak", () => {
    expect(providerCss(120, { tone: "soft" })).toContain("/");
    expect(providerCss(120, { tone: "solid" })).not.toContain("/");
  });

  it("hue null jatuh ke token netral, bukan warna karangan", () => {
    expect(providerCss(null)).toBe("var(--color-border)");
    expect(providerChipBg(null)).toBe("var(--color-bg-subtle)");
  });

  it("latar chip selalu beralfa rendah supaya teks di atasnya tetap terbaca", () => {
    for (const hue of [0, 90, 180, 270, 359]) {
      const bg = providerChipBg(hue);
      const alpha = Number(bg.match(/\/ ([\d.]+)\)/)[1]);
      expect(alpha).toBeLessThanOrEqual(0.2);
    }
  });
});
