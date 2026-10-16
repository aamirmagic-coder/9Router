"use client";

import { useEffect, useRef } from "react";
import Lenis from "lenis";

/**
 * Smooth scroll untuk kontainer konten dashboard.
 *
 * ── Mengapa di CONTAINER, bukan di dokumen ──────────────────────────────────
 *
 * Layout dashboard ini memakai `h-screen overflow-hidden` di akar dan menggulir
 * di dalam `<div className="flex-1 overflow-y-auto">`. `<html>` dan `<body>`
 * TIDAK pernah menggulir. Lenis yang dipasang pada dokumen karena itu tidak akan
 * melakukan apa pun — ia menunggu scroll yang tidak pernah terjadi.
 *
 * ── Risiko yang harus dijaga, dan cara mengujinya ───────────────────────────
 *
 * Lenis bekerja dengan mencegah scroll asli lalu memindahkan posisi secara
 * terprogram. Pada layout dengan sidebar `fixed`, itu bisa membuat sidebar
 * tampak bergeser karena transform pada leluhur membuat `fixed` mengacu ke
 * elemen itu, bukan ke viewport.
 *
 * Karena itu: sidebar dan header ada DI LUAR kontainer yang dihaluskan. Selama
 * yang dipasangi Lenis hanya `<div>` isi, tidak ada leluhur ber-transform di
 * atas elemen fixed.
 *
 * Cara memverifikasi (dilakukan setelah pemasangan):
 *   · `<html>` tetap tidak menggulir (scrollTop tetap 0)
 *   · sidebar tetap di posisinya saat konten digulir
 *   · elemen `position: sticky` di dalam masih menempel
 *   · tabel/panel dengan `overflow-y-auto` sendiri tetap bisa digulir
 *
 * Kalau salah satu gagal, Lenis dilepas dan dilaporkan — bukan dipaksa.
 */

/** Preferensi pengguna; sama seperti animasi lain di proyek ini. */
function reducedMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useSmoothScroll(ref, { enabled = true, contentRef } = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    // Menghormati preferensi sistem: operator yang meminta gerak dikurangi
    // tidak boleh mendapat scroll yang "meluncur".
    if (reducedMotion()) return;

    const lenis = new Lenis({
      wrapper: el,
      // `contentRef` = pembungkus isi yang STABIL lintas navigasi.
      //
      // Memakai `el.firstElementChild` langsung tampak benar pada muat pertama,
      // tapi elemen itu DIGANTI setiap pindah halaman (AnimatePresence melepas
      // anak lama). ResizeObserver Lenis lalu menempel pada elemen yang sudah
      // lepas dari DOM: tidak ada sinyal resize lagi, `resize()` tidak pernah
      // jalan, dan `limit` gulir beku pada tinggi halaman sebelumnya — halaman
      // panjang hanya bisa digulir sebagian, tidak sampai bawah.
      content: contentRef?.current || el.firstElementChild || el,
      // 0.1 = nilai bawaan Lenis, dan justru itu yang terasa "halus": tiap
      // frame hanya menempuh ~10% sisa jarak, sehingga roda mouse terasa
      // meluncur alih-alih menempel 1:1.
      //
      // Sebelumnya 0.9, dan itu terbalik dari yang dimaksud. Pada Lenis `lerp`
      // adalah PECAHAN jarak yang ditempuh per frame (lihat `damp` di paket
      // Lenis), jadi 0.9 menempuh ~59% sisa jarak tiap frame — sekitar enam
      // kali lebih "lari" daripada bawaan. Hasilnya nyaris tak bisa dibedakan
      // dari scroll asli, dan itulah kenapa smooth scroll-nya tidak terasa.
      lerp: 0.1,
      wheelMultiplier: 1,
      touchMultiplier: 1.2,
      // Jangan menyerobot elemen yang memang menggulir sendiri (tabel 600 baris,
      // panel drill-down, dropdown). Tanpa ini, menggulir di dalamnya akan
      // memindahkan halaman — persis scroll-jacking yang harus dihindari.
      prevent: (node) => {
        // Elemen apa pun yang punya overflow-y sendiri.
        let cur = node;
        while (cur && cur !== el) {
          const style = getComputedStyle(cur);
          const oy = style.overflowY;
          if ((oy === "auto" || oy === "scroll") && cur.scrollHeight > cur.clientHeight) {
            return true;
          }
          cur = cur.parentElement;
        }
        return false;
      },
    });

    let frame = null;
    const raf = (time) => {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    };
    frame = requestAnimationFrame(raf);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [ref, enabled, contentRef]);
}

/**
 * Animasi angka dengan GSAP, untuk daftar yang panjang.
 *
 * ── Mengapa GSAP di sini, bukan Motion ──────────────────────────────────────
 *
 * Motion menganimasikan state React: satu nilai yang bergerak = satu komponen
 * yang render ulang tiap frame. Untuk satu angka di kepala halaman itu tepat.
 *
 * Di daftar lapis jumlahnya bisa ratusan. Menjadikan tiap baris komponen Motion
 * berarti ratusan langganan animasi, dan saat SSE memperbarui beberapa kali per
 * detik, React harus merender ratusan komponen per frame — persis beban yang
 * ingin dihindari. GSAP menulis langsung ke DOM lewat ref, tanpa render React
 * sama sekali.
 *
 * Yang dianimasikan tetap NILAI MENTAH, lalu diformat oleh pemanggil.
 */
export function useGsapCountUp(ref, value, { duration = 0.5, format } = {}) {
  const stateRef = useRef({ tween: null, format });

  useEffect(() => {
    stateRef.current.format = format;
  }, [format]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const target = Number(value);
    if (!Number.isFinite(target)) return;

    // GSAP dimuat dinamis: paketnya 6,4MB, dan halaman yang tidak memakai
    // hitungan panjang tidak perlu memuatnya sama sekali.
    let killed = false;
    import("gsap").then(({ gsap }) => {
      if (killed) return;
      if (reducedMotion()) {
        el.textContent = stateRef.current.format ? stateRef.current.format(target) : String(target);
        return;
      }
      stateRef.current.tween?.kill();
      const from = { v: Number(el.dataset.v ?? target) };
      stateRef.current.tween = gsap.to(from, {
        v: target,
        duration,
        ease: "power2.out",
        onUpdate: () => {
          el.dataset.v = String(from.v);
          el.textContent = stateRef.current.format ? stateRef.current.format(from.v) : String(Math.round(from.v));
        },
      });
    });

    // Dibaca ke variabel lokal: `stateRef.current` bisa sudah menunjuk tween
    // yang BERBEDA saat cleanup berjalan (nilai baru datang sebelum yang lama
    // selesai), dan mematikan yang salah berarti animasi baru ikut terhenti.
    const state = stateRef.current;
    return () => {
      killed = true;
      state.tween?.kill();
    };
  }, [ref, value, duration]);
}
