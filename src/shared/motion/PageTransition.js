"use client";

import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { useSmoothScroll } from "./usePageTransition";
import { ScrollProgress } from "./primitives";

/**
 * Transisi antar-halaman + smooth scroll, dipasang SEKALI di layout.
 *
 * ── Mengapa di layout, bukan di 24 halaman ──────────────────────────────────
 *
 * Menambahkan entrance animation ke tiap halaman berarti menyentuh 24 berkas,
 * dan setiap berkas menambah risikonya sendiri. Yang dibutuhkan operator saat
 * berpindah menu cuma "halaman baru muncul dengan halus, bukan berkedip" — dan
 * itu satu tempat: pembungkus di sekitar `{children}`.
 *
 * Efeknya berlaku untuk SEMUA halaman di bawahnya, termasuk halaman yang
 * ditambahkan nanti tanpa perlu diubah.
 *
 * ── Durasi yang sengaja pendek ──────────────────────────────────────────────
 *
 * 220ms masuk, 140ms keluar. Animasi halaman yang terasa "mewah" (500ms+)
 * menjadi siksaan saat operator berpindah menu puluhan kali sehari — dan
 * dashboard ini memang dipakai begitu. Yang diinginkan di sini bukan kesan
 * mewah, melainkan tidak adanya kedipan.
 *
 * ── Yang TIDAK dianimasikan ────────────────────────────────────────────────
 *
 * Hanya opasitas dan geser 8px. Tidak ada skala, tidak ada blur: keduanya
 * memaksa repaint seluruh area dan pada tabel besar terasa tersendat.
 *
 * ── Stagger: TIDAK lagi otomatis di sini ──────────────────────────────────
 *
 * Pembungkus ini dulu menjadi sumber `staggerChildren` sehingga setiap `Card`
 * di halaman menyusul berurutan. Itu DILEPAS: `staggerChildren` tidak punya
 * batas atas, dan halaman dengan ratusan kartu (Providers) membuat kartu
 * terakhir baru muncul setelah beberapa detik — terlihat kosong, sehingga
 * halaman tampak "tidak sampai bawah". Stagger yang terbatas tetap tersedia
 * lewat primitif `Stagger` untuk daftar yang jumlahnya diketahui.
 *
 * `prefers-reduced-motion` dihormati lewat `useReducedMotion` — durasinya jadi
 * nol, bukan animasinya dihapus, sehingga tidak ada yang bergantung pada
 * selesainya sebuah transisi.
 */
export function PageTransition({ children }) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const scrollRef = useRef(null);
  // Elemen isi yang STABIL lintas navigasi — lihat catatan di
  // `useSmoothScroll` soal kenapa `firstElementChild` tidak boleh dipakai
  // langsung (limit gulir bisa beku di tinggi halaman sebelumnya).
  const contentRef = useRef(null);

  useSmoothScroll(scrollRef, { contentRef });

  const dur = reduce ? 0 : 0.22;
  const durOut = reduce ? 0 : 0.14;

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {/* Garis kemajuan gulir — GSAP ScrollTrigger.
          Ditaruh di LUAR wadah yang menggulir, bukan di dalamnya: elemen di
          dalam wadah yang menggulir akan ikut tergulir naik dan menghilang
          justru saat paling dibutuhkan. */}
      <ScrollProgress scrollerRef={scrollRef} />
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto custom-scrollbar"
        data-smooth-scroll=""
      >
        {/* Pembungkus STABIL. Lenis butuh satu elemen `content` yang tidak
            berganti antar-navigasi; kalau yang dipakai adalah anak pertama
            wadah gulir, elemen itu diganti setiap pindah halaman dan
            ResizeObserver Lenis menempel pada elemen yang sudah lepas dari DOM. */}
        <div ref={contentRef} className="min-h-full">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={pathname}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduce ? 0 : -8 }}
              transition={{ duration: dur, exit: { duration: durOut }, ease: [0.2, 0.8, 0.2, 1] }}
              className="min-h-full"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
