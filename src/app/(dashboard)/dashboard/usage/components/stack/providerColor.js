/**
 * Warna identitas per provider.
 *
 * ── Masalah yang dipecahkan ─────────────────────────────────────────────────
 *
 * Sebelum ini, seluruh halaman memakai SATU hue oranye dengan opasitas
 * berbeda-beda. Akibatnya provider ke-4 dan seterusnya semuanya jatuh ke
 * `--color-border` — abu-abu. Dengan 40+ provider di database nyata, sebagian
 * besar dari mereka tidak bisa dibedakan sama sekali; legenda proporsi berisi
 * sederet titik kelabu yang tidak berarti apa-apa.
 *
 * ── Cara kerjanya ───────────────────────────────────────────────────────────
 *
 * Nama provider di-hash menjadi sebuah HUE. Hash yang sama selalu menghasilkan
 * warna yang sama, jadi "b.ai" tetap biru besok dan lusa — tidak ada warna yang
 * berubah saat halaman dimuat ulang, karena itu akan membuat warna tidak lagi
 * berguna sebagai penanda ("yang hijau itu apa tadi?").
 *
 * Hash saja TIDAK cukup: 40 provider di 360 derajat ruang hue akan bertabrakan
 * hampir pasti (paradoks ulang tahun: peluangnya ~89%). Karena itu warna
 * dihitung untuk SELURUH himpunan provider sekaligus, dan tabrakan diselesaikan
 * dengan memutar hue ke depan sampai jarak minimum terpenuhi.
 *
 * Urutannya: provider diurutkan berdasarkan nama, lalu tiap kandidat hue
 * didorong maju kalau terlalu dekat dengan yang SUDAH ditempatkan. Yang
 * ditempatkan lebih dulu (nama lebih awal secara alfabetis) mempertahankan
 * warna hash-nya; yang belakangan menyesuaikan. Konsekuensinya: menambah
 * provider baru hanya menggeser warna tetangga terdekatnya, bukan seluruh
 * papan.
 *
 * ── Kenapa OKLCH ────────────────────────────────────────────────────────────
 *
 * `hsl()` menghasilkan terang yang tidak seragam: kuning 60° dan biru 240° di
 * lightness yang sama terlihat sangat berbeda terangnya. OKLCH seragam secara
 * persepsi, jadi satu nilai lightness untuk semua hue menghasilkan bobot visual
 * yang setara — penting karena warna-warna ini dipakai sebagai penanda kecil
 * yang harus terbaca pada ukuran 6-10 piksel.
 *
 * ── Warna hanya untuk PENANDA, tidak pernah untuk TEKS ──────────────────────
 *
 * Yang diwarnai adalah titik, batang, dan segmen chart — bukan tulisan. Nama
 * provider tetap memakai `--color-text-main`. Alasannya bukan kehati-hatian
 * berlebihan: 20+ warna yang semuanya harus lulus kontras teks 4,5:1 terhadap
 * dua tema sekaligus tidak mungkin dicapai tanpa membuat semuanya jadi gelap
 * dan kusam, yang justru menghapus gunanya membedakan warna. Sebagai penanda
 * grafis, ambangnya 3:1 dan itu terpenuhi.
 */

/**
 * Hash FNV-1a 32-bit.
 *
 * Dipilih karena sebarannya merata untuk string pendek dan implementasinya
 * beberapa baris — tidak perlu menarik dependensi hashing hanya untuk memilih
 * warna. `djb2` juga cukup, tapi FNV-1a lebih baik pada string mirip
 * ("openai-compatible-chat-aaa" vs "...-aab") yang justru banyak di sini.
 */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Jarak minimum antar-hue, dalam derajat. */
function minSeparation(count) {
  // Dengan sedikit provider, jaraknya lega; makin banyak, makin rapat — tapi
  // tidak pernah lebih rapat dari 14°, di bawah itu dua warna mulai terbaca
  // sama pada titik 6px.
  return Math.max(14, Math.min(48, 360 / Math.max(1, count)));
}

/**
 * Hitung peta warna untuk sekumpulan provider.
 *
 * Mengembalikan `Map<providerId, {hue, light, dark, ...}>`. Dipanggil sekali
 * per render dengan daftar provider yang SEDANG TAMPIL, sehingga yang dijamin
 * unik adalah yang benar-benar terlihat berdampingan.
 */
/** Jarak terdekat sebuah hue ke himpunan hue yang sudah ditempatkan. */
function nearestGap(hue, placed) {
  let min = 360;
  for (const p of placed) {
    const d = Math.abs(p - hue);
    min = Math.min(min, Math.min(d, 360 - d));
  }
  return min;
}

export function buildProviderColors(providerIds) {
  const ids = [...new Set(providerIds.filter(Boolean))].sort();
  const sep = minSeparation(ids.length);
  const placed = [];
  const map = new Map();

  for (const id of ids) {
    const base = (hashString(id) % 3600) / 10; // 0–360 dengan satu desimal
    let hue = base;

    // Dorong maju lewat sudut emas sampai cukup jauh dari semua yang sudah
    // ditempatkan.
    //
    // Dua hal yang TIDAK boleh terjadi, dan keduanya pernah terjadi di versi
    // pertama berkas ini:
    //
    // 1. **Menerima hue yang terlalu dekat.** Batas percobaan yang habis lalu
    //    memakai hue apa pun menghasilkan dua provider berjarak 0,1° — praktis
    //    identik, dan lebih buruk daripada tidak ada warna sama sekali karena
    //    tampak seperti ada hubungan yang sebenarnya tidak ada.
    //
    // 2. **Berhenti di lompatan pertama.** Sudut emas mengunjungi posisi yang
    //    tersebar, jadi lompatan ke-1 sudah sering cukup jauh — tapi tidak
    //    selalu. Yang dicari adalah yang TERJAUH dalam sejumlah lompatan, bukan
    //    yang pertama kali memenuhi syarat: dengan begitu tidak ada provider
    //    yang mendapat warna mepet hanya karena kebetulan ditempatkan lebih
    //    dulu.
    let best = hue;
    let bestGap = nearestGap(hue, placed);
    let probe = hue;

    for (let step = 1; step <= 40; step++) {
      probe = (probe + 137.508) % 360;
      const gap = nearestGap(probe, placed);
      if (gap > bestGap) {
        bestGap = gap;
        best = probe;
      }
      if (bestGap >= sep) break;
    }

    placed.push(best);
    map.set(id, { hue: Math.round(best * 10) / 10, saturation: 1 });
  }

  return map;
}

/**
 * Warna siap pakai untuk sebuah provider, dalam bentuk CSS.
 *
 * `tone` menentukan bobotnya:
 *   · `solid`  — penanda utama (titik, batang padat)
 *   · `soft`   — isian latar (chip, area chart) pada alfa rendah
 *   · `line`   — garis (stroke chart)
 *
 * Nilai lightness dipilih terpisah untuk tema terang dan gelap. Di tema gelap,
 * warna dengan lightness terang-mode (≈0.6) tenggelam ke latar #1a1a1a; karena
 * itu lightness dinaikkan dan chroma sedikit diturunkan supaya tidak menyala.
 */
export function providerCss(hue, { tone = "solid", dark = false } = {}) {
  if (hue == null) return "var(--color-border)";

  const L = dark ? 0.74 : 0.62;
  const C = tone === "soft" ? 0.13 : 0.17;
  const alpha = tone === "soft" ? 0.22 : 1;

  if (alpha === 1) return `oklch(${L} ${C} ${hue})`;
  return `oklch(${L} ${C} ${hue} / ${alpha})`;
}

/**
 * Warna untuk latar chip/label dengan teks di atasnya.
 *
 * Selalu dipasangkan dengan teks `--color-text-main`, dan alfa rendah (14%)
 * memastikan kontras teks terjaga di kedua tema: latar yang nyaris netral
 * dengan sedikit rona.
 */
export function providerChipBg(hue, dark = false) {
  if (hue == null) return "var(--color-bg-subtle)";
  const L = dark ? 0.74 : 0.62;
  return `oklch(${L} 0.17 ${hue} / 0.14)`;
}

/**
 * Jalur kuota yang AMAN kalau dipakai di luar komponen React (mis. di dalam
 * `style` yang butuh tiga nilai sekaligus).
 */
export function makeColorResolver(providerIds) {
  const map = buildProviderColors(providerIds);
  return {
    map,
    hueOf: (id) => map.get(id)?.hue ?? null,
    solid: (id, opts) => providerCss(map.get(id)?.hue, opts),
    chip: (id, dark) => providerChipBg(map.get(id)?.hue, dark),
  };
}
