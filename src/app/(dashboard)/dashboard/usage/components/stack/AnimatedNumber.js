"use client";

import { useAnimatedNumber } from "./useAnimatedNumber";

/**
 * Angka yang BERJALAN ke nilai baru, bukan melompat.
 *
 * ── Mengapa komponen, bukan pemanggilan hook di tiap tempat ─────────────────
 *
 * Hook-nya (`useAnimatedNumber`) mengembalikan NILAI, dan tiap pemanggil harus
 * ingat untuk memformatnya serta menyimpan hasilnya di satu elemen yang stabil.
 * Di halaman Usage ada puluhan angka — kepala lapis, tiap baris, panel live —
 * dan mengulang pola itu di tiap tempat berarti puluhan kesempatan untuk lupa
 * memformat token dengan benar.
 *
 * Komponen ini menutup seluruh pola itu: beri nilai mentah + pemformat, dan
 * yang tampil adalah angka yang berjalan mulus ke nilai barunya.
 *
 * ── Yang dianimasikan nilai MENTAHNYA ───────────────────────────────────────
 *
 * Bukan string hasil format. "$3,69" bukan bilangan, dan mengurai ulang angka
 * berformat setiap frame jauh lebih mahal daripada menghitung nilainya sekali
 * lalu memformat tiap frame. Karena itu `format` menerima angka, dan pemanggil
 * yang memutuskan pembulatan (`fmtWhole` untuk token, `fmtCost` untuk biaya).
 *
 * ── Nilai awal TIDAK pernah 0 ───────────────────────────────────────────────
 *
 * Hook di bawahnya sudah menjamin ini: render pertama memakai nilai akhir apa
 * adanya, dan animasi hanya berjalan saat nilainya BERUBAH. Halaman ini dipakai
 * untuk memercayai angka pengeluaran; angka yang sedang berjalan naik dari nol
 * adalah angka yang berbohong selama setengah detik pertama.
 */
export default function AnimatedNumber({ value, format, duration = 520, className = "" }) {
  const shown = useAnimatedNumber(value, { duration });
  return (
    <span className={className} data-animated-number="">
      {format ? format(shown) : String(Math.round(shown))}
    </span>
  );
}
