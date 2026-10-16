"use client";

import { motion, useReducedMotion } from "motion/react";
import { EASE, DUR } from "./primitives";

/**
 * Pembungkus kepala halaman: judul, keterangan, dan aksi masuk berurutan.
 *
 * ── Mengapa ini ada, padahal sudah ada PageTransition ───────────────────────
 *
 * `PageTransition` menganimasikan SELURUH halaman sebagai satu blok. Itu cukup
 * untuk menghilangkan kedipan saat berpindah menu, tapi tidak memberi apa pun
 * pada isinya: begitu halaman muncul, semua elemen ada di tempatnya sekaligus.
 *
 * `PageShell` menambahkan satu langkah di atasnya — kepala halaman masuk
 * berurutan, jadi mata dibimbing dari judul ke aksi. Ini yang membedakan
 * "halaman muncul" dari "halaman tersusun".
 *
 * ── Kenapa pemasangannya harus mudah ───────────────────────────────────────
 *
 * Ada 24 halaman. Kalau memasangnya butuh lima baris dan satu import tambahan
 * di tiap berkas, ia akan dipasang di tiga halaman lalu ditinggalkan. Bentuknya
 * karena itu sengaja sesederhana mungkin: bungkus JSX yang sudah ada.
 *
 * ── Urutannya, dan alasannya ───────────────────────────────────────────────
 *
 *   judul → keterangan → aksi
 *
 * Aksi masuk TERAKHIR meski secara visual ada di kanan. Alasannya: tombol yang
 * sudah bisa diklik sebelum operator selesai membaca judulnya mengundang
 * klik yang salah. 60ms lebih lambat tidak terasa; klik yang keliru terasa.
 */
export function PageShell({
  title,
  subtitle,
  actions,
  children,
  className = "",
  titleAs = "h1",
  // Tipografi bisa ditimpa supaya halaman yang sudah punya gaya judul sendiri
  // tidak berubah rupa hanya karena kepalanya dipindah ke primitif ini.
  titleClassName = "text-lg font-semibold text-text-main",
  subtitleClassName = "mt-0.5 text-sm text-text-muted",
}) {
  const reduce = useReducedMotion();

  // Tingkat judul bisa diturunkan (h1 → h2) supaya `PageShell` juga bisa dipakai
  // sebagai kepala SEKSI, bukan hanya kepala halaman. Header global sudah
  // menampilkan judul halaman, jadi seksi di dalamnya memakai h2 — memakai h1
  // lagi akan membuat struktur dokumen berbohong tentang apa yang penting.
  const Heading = titleAs;
  const MotionHeading = motion[titleAs] || motion.h1;

  if (reduce) {
    return (
      <div className={className}>
        {(title || actions) && (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {title ? <Heading className={titleClassName}>{title}</Heading> : null}
              {subtitle ? <p className={subtitleClassName}>{subtitle}</p> : null}
            </div>
            <div className="w-full sm:w-auto">{actions}</div>
          </div>
        )}
        {children}
      </div>
    );
  }

  const naik = (delay) => ({
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DUR.base, delay, ease: EASE },
  });

  return (
    <div className={className}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <MotionHeading {...naik(0)} className={titleClassName}>
                {title}
              </MotionHeading>
            ) : null}
            {subtitle ? (
              <motion.p {...naik(0.05)} className={subtitleClassName}>
                {subtitle}
              </motion.p>
            ) : null}
          </div>
          {actions ? (
            // `w-full sm:w-auto` supaya aksi yang memakai `w-full` di layar kecil
            // (pola yang sudah dipakai halaman-halaman ini) tetap selebar
            // induknya, bukan menciut ke lebar isinya.
            <motion.div {...naik(0.1)} className="w-full sm:w-auto">
              {actions}
            </motion.div>
          ) : null}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Grid kartu dengan kemunculan berurutan.
 *
 * Ditempelkan ke wadah grid yang SUDAH ada, bukan menggantikannya: pemanggil
 * tetap menulis `className` grid-nya sendiri, dan yang ditambahkan hanya
 * gerak masuknya. Dengan begitu tata letak yang sudah benar tidak ikut berubah.
 *
 * Batas `STAGGER_CAP` berlaku: daftar 200 kartu tidak menunggu 8 detik.
 */
export function motionGrid(className, { delay = 0, step = 0.03 } = {}) {
  return {
    className,
    initial: "hidden",
    animate: "show",
    variants: {
      hidden: {},
      show: { transition: { staggerChildren: step, delayChildren: delay } },
    },
  };
}

/** Anak dari `motionGrid`. Pasangan tetapnya, supaya geraknya konsisten. */
export const gridItem = {
  variants: {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
  },
};
