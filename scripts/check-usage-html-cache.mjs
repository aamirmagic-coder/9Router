/**
 * Diagnostik: apakah HTML /dashboard/usage menunjuk chunk JS yang BENAR-BENAR
 * ada di server?
 *
 * Kalau tidak, browser akan gagal memuat — atau lebih buruk, memakai chunk
 * lama dari cache — meskipun versi baru sudah terpasang.
 *
 * ── Mengapa ini bukan tes ────────────────────────────────────────────────────
 *
 * Sebelumnya berkas ini hidup di tests/unit/ dengan NOL `expect()`. Ia tidak
 * pernah bisa gagal: kondisinya hanya mendorong baris ke array lalu menulis
 * sebuah berkas laporan, jadi ia "lulus" apa pun yang terjadi, dan cabang
 * "semua baik" dilaporkan sebagai kabar buruk dengan cara yang sama seperti
 * kegagalan sungguhan.
 *
 * Ia juga menulis ke path absolut yang di-hardcode (`C:/Users/Developer/...`)
 * dan mencari pola chunk \`5497-\` — potongan milik komponen yang sudah tidak
 * ada, sehingga hasilnya dijamin "tidak ditemukan" selamanya.
 *
 * Sebuah probe tanpa assertion adalah tes yang berpura-pura hijau. Yang benar
 * adalah ini: sebuah skrip yang harus DIJALANKAN dan hasilnya DIBACA.
 *
 * Pakai:
 *   node scripts/check-usage-html-cache.mjs [--base http://localhost:20128]
 *
 * Butuh server yang sedang berjalan dan INITIAL_PASSWORD yang benar.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:20128";
const PASSWORD = process.env.INITIAL_PASSWORD || "123456";

// Login lewat HTTP, BUKAN dengan mengimpor `src/lib/auth/dashboardSession.js`.
// Modul itu memakai alias `@/lib` yang hanya ada di lingkungan Next/vitest —
// di Node polos impornya gagal. Perilaku probe lama yang harus hidup di dalam
// tests/ berasal dari keterbatasan ini, bukan dari sifat pekerjaannya.
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
if (!loginRes.ok) {
  console.error(`Login gagal (HTTP ${loginRes.status}). Set INITIAL_PASSWORD kalau berbeda.`);
  process.exit(1);
}
const cookie = (loginRes.headers.getSetCookie?.() || [])
  .map((c) => c.split(";")[0])
  .join("; ");

const out = [];
const r = await fetch(`${BASE}/dashboard/usage`, {
  headers: { Cookie: cookie },
});
out.push(`HTTP ${r.status}`);
out.push(`cache-control: ${r.headers.get("cache-control") || "(tidak ada)"}`);
out.push(`x-nextjs-cache: ${r.headers.get("x-nextjs-cache") || "(tidak ada)"}`);
out.push(`etag: ${r.headers.get("etag") || "(tidak ada)"}`);

const html = await r.text();
out.push(`panjang HTML: ${html.length}`);

// Chunk apa pun yang direferensikan HTML — bukan pola milik satu komponen,
// karena komponennya berganti dan pola lama akan selalu kosong.
const chunks = [...new Set([...html.matchAll(/static\/chunks\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]))];
out.push(`chunk direferensikan: ${chunks.length}`);
chunks.slice(0, 8).forEach((c) => out.push(`  · ${c}`));

// Apakah chunk yang ditunjuk benar-benar ada di server?
//
// Mulai dari `true` — kalau tidak ada chunk sama sekali, "semua bisa diambil"
// memang benar secara hampa, dan cabang laporan di bawah sudah menyebutnya
// sendiri. Nilai awal `false` membuat skrip ini MUSTAHIL melaporkan kabar baik:
// ia akan mencetak ❌ meski dua puluh dua chunk-nya semua menjawab 200.
let allReachable = true;
for (const c of chunks) {
  const url = `${BASE}/_next/${c}`;
  const h = await fetch(url, { method: "HEAD" }).catch(() => null);
  const ok = h?.ok;
  if (!ok) allReachable = false;
  out.push(`  ${ok ? "OK " : "HILANG"} ${url} → ${h?.status ?? "gagal"}`);
}

out.push("");
out.push(
  chunks.length === 0
    ? "ℹ️  Tidak ada chunk statis di HTML (semuanya dimuat dinamis)."
    : allReachable
      ? "✅ Semua chunk yang direferensikan HTML bisa diambil dari server."
      : "❌ ADA chunk yang tidak bisa diambil — browser akan gagal memuat atau memakai versi cache.",
);

const txt = out.join("\n");
// Ditulis relatif terhadap repo, bukan path absolut milik satu mesin.
writeFileSync(resolve(process.cwd(), "usage-html-cache.txt"), txt);
console.log(txt);
