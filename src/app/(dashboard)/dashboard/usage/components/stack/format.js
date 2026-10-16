/**
 * Utilitas format untuk halaman Usage.
 *
 * Semua angka yang tampil di halaman ini melewati fungsi di sini supaya
 * konsisten dan — yang lebih penting — supaya kolom angka tidak bergeser saat
 * data realtime masuk. Lihat `tabular-nums` dan lebar kolom tetap di
 * components/stack/*: angka yang berubah lebar (mis. "999" → "1.2K") menggeser
 * seluruh baris kalau tidak dijaga.
 */

const NARROW_NBSP = " ";

/** Jumlah token ringkas: 1.2K, 3.4M, 5.6B. */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}K`;
  if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  return `${(v / 1_000_000_000).toFixed(1)}B`;
}

/** Jumlah request ringkas. */
export function fmtCount(n) {
  return fmtTokens(n);
}

/**
 * Biaya. Empat desimal untuk nilai kecil supaya biaya satu request tetap
 * terbaca; dua desimal untuk sisanya.
 *
 * TIDAK ADA pembulatan ke bentuk "7.1K". Halaman ini adalah satu-satunya
 * tempat operator bisa melihat pengeluaran yang tercatat; "$7.1K" menyembunyikan
 * $29,13 dan tidak ada layar lain yang bisa dipakai untuk menemukannya kembali.
 * Lebar kolom beberapa piksel lebih hemat bukan alasan yang cukup.
 */
export function fmtCost(n) {
  const v = Number(n) || 0;
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/** Angka penuh dengan pemisah ribuan — untuk nilai utama, bukan ringkasan. */
export function fmtFull(n) {
  return (Number(n) || 0).toLocaleString("en-US");
}

/**
 * `fmtFull` yang dipaksa BULAT.
 *
 * Dipakai untuk angka yang sedang dianimasikan. Di tengah animasi nilainya
 * pecahan (mis. 1.234,56), dan `fmtFull` apa adanya akan mencetaknya sebagai
 * "1,234.56" — token tidak pernah setengah, dan kolom angka yang tiba-tiba
 * berdesimal terbaca seperti kesalahan data. Membulatkan di sini menjaga
 * janji halaman ini: angka yang tampil selalu berupa token utuh.
 */
export function fmtWhole(n) {
  const v = Number(n);
  return (Number.isFinite(v) ? Math.round(v) : 0).toLocaleString("en-US");
}

/**
 * Token sebagai angka penuh: 16.042.831.295, bukan "16.0B".
 *
 * `fmtTokens` yang meringkas tetap dipakai di tempat yang lebarnya memang
 * terbatas dan angka itu hanya penunjuk arah (strip proporsi, legenda). Di
 * kepala halaman dan di tiap baris, yang dibutuhkan operator adalah angka yang
 * bisa dicocokkan dengan catatan di tempat lain — dan "16.0B" tidak bisa
 * dicocokkan dengan apa pun.
 */
export function fmtTokenCount(n) {
  return fmtFull(n);
}

/**
 * Basis peringkat dan proporsi untuk tiap mode.
 *
 * "both" memakai BIAYA. Alasannya: biaya dan token punya satuan berbeda dan
 * tidak bisa dijumlahkan menjadi satu skor — apa pun yang menjumlahkannya akan
 * mengarang kurs. Pilihannya jadi "satu basis yang eksplisit" atau "tidak ada
 * urutan sama sekali", dan urutan yang eksplisit lebih berguna.
 */
export function valueOfMode(row, mode) {
  return mode === "tokens" ? row.tokens : row.cost;
}

/** Tiga cara membaca halaman ini. Satu basis peringkat per mode. */
export const VALUE_MODES = [
  { id: "costs", label: "Cost", ranksBy: "cost" },
  { id: "tokens", label: "Tokens", ranksBy: "tokens" },
  { id: "both", label: "Cost + Tokens", ranksBy: "cost" },
];

/** Waktu relatif singkat: "now", "3m", "2h", "5d". */
export function fmtTime(timestamp) {
  if (!timestamp) return "—";
  const t = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "—";
  if (diff < 45_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** Waktu relatif panjang untuk label tooltip. */
export function fmtAgo(timestamp) {
  if (!timestamp) return "";
  const t = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "less than a minute ago";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** Tanggal + jam untuk tooltip yang perlu waktu pasti. */
export function fmtExact(timestamp) {
  if (!timestamp) return "";
  const t = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Persentase bagian terhadap total. Mengembalikan angka 0-100, atau null kalau
 * totalnya nol — pemanggil harus membedakan "0%" dari "tidak ada dasar
 * perhitungan", karena menampilkan 0% saat tidak ada data adalah kebohongan
 * kecil yang membuat operator salah membaca.
 */
export function share(part, total) {
  const p = Number(part) || 0;
  const t = Number(total) || 0;
  if (t <= 0) return null;
  return (p / t) * 100;
}

/** Format persentase dengan satu desimal; "—" kalau tidak ada dasar. */
export function fmtPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

/**
 * Rincian token untuk tooltip: input, cached, output.
 *
 * ATURAN YANG MENGIKAT: `cached` adalah BAGIAN DARI `input`, bukan tambahan.
 * Sumbernya jelas di ketiga format upstream —
 *   · OpenAI   : `prompt_tokens_details.cached_tokens`
 *   · Claude   : `cache_read_input_tokens` (di dalam `input_tokens`)
 *   · DeepSeek : `prompt_cache_hit_tokens`
 * Ketiganya field turunan dari prompt/input. Karena itu kalimat di bawah
 * menuliskan "cached" SEBAGAI BAGIAN input, dan TIDAK pernah menjumlahkannya
 * ke total — totalnya tetap `input + output`, persis seperti yang dilaporkan
 * provider. Menambahkannya akan menggelembungkan angka yang justru dipakai
 * operator untuk mencocokkan tagihan.
 */
export function fmtTokenDetail({ input = 0, output = 0, cached = 0, total = 0 }) {
  const parts = [`${fmtFull(input)} input`];
  if (cached > 0) parts.push(`of which ${fmtFull(cached)} cached`);
  parts.push(`${fmtFull(output)} output`);
  return `${fmtFull(total)} tokens — ${parts.join(", ")}`;
}

/** Label periode untuk judul bagian. */
export const PERIOD_LABELS = {
  today: "today",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "60d": "last 60 days",
  all: "all time",
};

export { NARROW_NBSP };
