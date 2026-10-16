"use client";

import { useEffect, useRef, useState } from "react";import { motion, useInView, useReducedMotion, useMotionValue, useSpring } from "motion/react";

/**
 * Primitif animasi bersama untuk seluruh dashboard.
 *
 * ── Mengapa primitif, bukan animasi per-komponen ────────────────────────────
 *
 * Dashboard ini punya 24 halaman. Menempelkan animasi ke tiap elemen satu per
 * satu berarti 24 tempat yang bisa salah, dan tidak ada satu pun yang konsisten
 * dengan yang lain — setiap halaman akan punya durasi, easing, dan jarak
 * geser sendiri-sendiri.
 *
 * Berkas ini menyediakan LAPISAN yang dipakai berulang: satu definisi gerak,
 * dipakai di mana-mana. Halaman baru otomatis mendapat tata bahasa yang sama
 * tanpa menulis animasi apa pun.
 *
 * ── Tata bahasa gerak yang dipegang seluruh berkas ini ──────────────────────
 *
 *   · Masuk: 240ms, geser 12px, opacity 0 → 1, easing (0.2, 0.8, 0.2, 1)
 *   · Stagger: 40ms antar-item, DIBATASI 12 item pertama
 *   · Hover: pegas ringan, tidak pernah mengubah tata letak
 *
 * Angka-angka itu dipilih untuk dashboard kerja, bukan landing page: cepat,
 * kecil, dan tidak pernah menghalangi pembacaan. Animasi yang membuat operator
 * menunggu 1 detik untuk melihat data adalah cacat, bukan kemewahan.
 *
 * ── `prefers-reduced-motion` dihormati di SETIAP primitif ───────────────────
 *
 * Bukan di satu tempat saja. Operator yang mematikan animasi di sistemnya tidak
 * boleh tetap mendapat gerakan dari komponen yang lupa memeriksanya.
 */

/** Easing yang dipakai seluruh dashboard. Satu kurva, bukan lima. */
export const EASE = [0.2, 0.8, 0.2, 1];

/** Durasi baku. */
export const DUR = { fast: 0.16, base: 0.24, slow: 0.36 };

/**
 * Batas jumlah item yang distagger.
 *
 * Terukur: dengan 40ms antar-item, 600 baris berarti baris terakhir muncul
 * setelah 24 detik. Yang terjadi bukan "kaya animasi" melainkan halaman yang
 * rusak. Di atas batas ini, sisanya muncul bersamaan — mata tidak lagi bisa
 * membedakan stagger setelah belasan item.
 */
export const STAGGER_CAP = 12;

/**
 * ── Mengapa TIDAK ada stagger otomatis se-halaman ─────────────────────────
 *
 * Sebelumnya `PageTransition` menjadi sumber `staggerChildren` (sehingga `Card`
 * menyusul satu per satu) dan berkas ini menyediakan `pageVariants`,
 * `CARD_VARIANTS`, serta `StaggerInheritContext` untuk itu. Semuanya DILEPAS
 * karena satu alasan yang tidak bisa ditawar:
 *
 * `staggerChildren` milik Motion TIDAK PUNYA BATAS ATAS. Ia memberi tiap anak
 * delay `index × staggerChildren`, dan halaman Providers merender ratusan
 * kartu. Dengan 45ms antar-kartu, kartu terakhir baru muncul setelah beberapa
 * DETIK — dalam arti harfiah terlihat kosong, sehingga halaman tampak "tidak
 * sampai bawah" padahal ruangnya ada.
 *
 * `STAGGER_CAP` di atas hanya berlaku untuk primitif `Stagger`, karena di sana
 * delay dihitung sendiri dari `index` yang sudah dijepit. Untuk daftar yang
 * memang terbatas, `Stagger` tetap cara yang benar. Untuk kisi yang jumlahnya
 * tidak diketahui (Providers), kartu hanya boleh beranimasi sendiri — serentak,
 * tanpa antrean yang panjangnya tidak terbatas.
 */

/**
 * Muncul saat masuk viewport.
 *
 * `once: true` bawaan: elemen yang sudah pernah dilihat tidak beranimasi lagi
 * saat digulir naik-turun. Animasi yang berulang setiap kali digulir terasa
 * seperti halaman yang berkedip, dan pada dashboard yang digulir terus-menerus
 * itu melelahkan.
 */
export function Reveal({
  children,
  delay = 0,
  y = 12,
  className = "",
  as = "div",
  once = true,
  amount = 0.15,
}) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const inView = useInView(ref, { once, amount });
  const Tag = motion[as] || motion.div;

  if (reduce) {
    return (
      <div ref={ref} className={className}>
        {children}
      </div>
    );
  }

  return (
    <Tag
      ref={ref}
      initial={{ opacity: 0, y }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y }}
      transition={{ duration: DUR.base, delay, ease: EASE }}
      className={className}
    >
      {children}
    </Tag>
  );
}

/**
 * Daftar yang itemnya muncul berurutan.
 *
 * ── Mengapa memakai `children` array, bukan render-prop ─────────────────────
 *
 * Pemanggil sudah punya array-nya. Meminta mereka memanggil fungsi render di
 * dalam berarti setiap daftar di dashboard harus ditulis ulang. Di sini cukup
 * `items.map(...)` seperti biasa, lalu hasilnya dibungkus — dan yang dibungkus
 * adalah ANAK yang sudah jadi, jadi tidak ada API baru yang perlu dipelajari.
 *
 * Batas `STAGGER_CAP` berlaku di sini, dan itu yang membuatnya aman dipakai
 * pada tabel besar.
 */
export function Stagger({
  children,
  className = "",
  delay = 0,
  step = 0.04,
  y = 10,
}) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.1 });
  const items = Array.isArray(children) ? children : [children];

  if (reduce) {
    return (
      <div ref={ref} className={className}>
        {children}
      </div>
    );
  }

  return (
    <div ref={ref} className={className}>
      {items.map((child, i) => (
        <motion.div
          key={child?.key ?? i}
          initial={{ opacity: 0, y }}
          animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y }}
          transition={{
            duration: DUR.base,
            // Di atas batas, sisanya tidak lagi menunggu — jadi daftar panjang
            // selesai dalam waktu yang sama dengan daftar pendek.
            delay: delay + Math.min(i, STAGGER_CAP) * step,
            ease: EASE,
          }}
        >
          {child}
        </motion.div>
      ))}
    </div>
  );
}

/**
 * Kartu yang mengangkat saat disorot.
 *
 * Memakai pegas, bukan durasi: pegas terasa hidup dan, yang lebih penting,
 * TIDAK mengubah tata letak — yang bergerak hanya transform dan bayangan.
 * Kartu yang mengubah ukuran saat hover akan menggeser tetangganya, dan itu
 * membuat daftar terasa bergetar saat kursor melintas.
 */
export function HoverLift({ children, className = "", y = -3, scale = 1.01 }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      whileHover={{ y, scale }}
      transition={{ type: "spring", stiffness: 380, damping: 26, mass: 0.6 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/**
 * Tekan yang terasa: mengecil sedikit saat ditekan.
 *
 * Ditempelkan pada elemen yang SUDAH ada, bukan membungkusnya — supaya tidak
 * ada lapisan DOM tambahan di antara grid dan isinya.
 */
export function usePressable() {
  const reduce = useReducedMotion();
  if (reduce) return {};
  return {
    whileTap: { scale: 0.97 },
    transition: { type: "spring", stiffness: 500, damping: 30 },
  };
}

/**
 * Tombol yang sedikit mengikuti kursor.
 *
 * Dijalankan lewat pegas pada nilai gerak, jadi tidak ada render React per
 * frame — inilah bedanya dengan state: `useMotionValue` menulis langsung ke
 * style, dan React tidak pernah ikut bangun.
 *
 * Perpindahannya kecil (maks 6px). Efek magnet yang besar terasa seperti
 * kursor yang tidak bisa dipercaya.
 */
export function Magnetic({ children, className = "", strength = 6 }) {
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 300, damping: 20, mass: 0.5 });
  const sy = useSpring(y, { stiffness: 300, damping: 20, mass: 0.5 });

  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      style={{ x: sx, y: sy }}
      className={className}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        x.set(Math.max(-1, Math.min(1, dx)) * strength);
        y.set(Math.max(-1, Math.min(1, dy)) * strength);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Garis kemajuan gulir di atas konten — GSAP ScrollTrigger.
 *
 * Memakai ScrollTrigger, bukan perhitungan manual, karena kontainernya BUKAN
 * dokumen: `scroller` harus disebutkan, dan itu satu baris di sini dibanding
 * menghitung sendiri posisi gulir tiap frame.
 *
 * GSAP dimuat dinamis: paketnya 6,4MB, dan halaman yang tidak menggulir panjang
 * tidak perlu memuatnya sama sekali.
 */
export function ScrollProgress({ scrollerRef }) {
  const reduce = useReducedMotion();
  const barRef = useRef(null);
  const [siap, setSiap] = useState(false);

  useEffect(() => {
    if (reduce) return;
    const scroller = scrollerRef?.current;
    const bar = barRef.current;
    if (!scroller || !bar) return;

    let killed = false;
    let ctx = null;

    Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(
      ([{ gsap }, { ScrollTrigger }]) => {
        if (killed) return;
        gsap.registerPlugin(ScrollTrigger);
        ctx = gsap.context(() => {
          gsap.fromTo(
            bar,
            { scaleX: 0 },
            {
              scaleX: 1,
              ease: "none",
              transformOrigin: "left center",
              scrollTrigger: {
                scroller,
                trigger: scroller,
                start: "top top",
                end: "bottom bottom",
                scrub: 0.3,
              },
            },
          );
        });
        setSiap(true);
      },
    );

    return () => {
      killed = true;
      ctx?.revert();
      setSiap(false);
    };
  }, [scrollerRef, reduce]);

  if (reduce) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] bg-transparent"
      aria-hidden="true"
    >
      <div
        ref={barRef}
        className="h-full origin-left bg-primary/70"
        style={{ transform: "scaleX(0)", opacity: siap ? 1 : 0 }}
      />
    </div>
  );
}

/**
 * Angka yang menghitung naik saat pertama terlihat — GSAP.
 *
 * Dipakai untuk angka ringkasan di halaman yang datanya besar. Berbeda dari
 * `useAnimatedNumber` (yang menganimasikan PERUBAHAN nilai), yang ini
 * menganimasikan PEMUNCULAN: dari 0 ke nilai saat elemennya masuk layar.
 *
 * `from 0` aman di sini justru karena ia muncul bersama elemennya — tidak ada
 * momen di mana angka salah terbaca sebagai nilai sungguhan, karena seluruh
 * bloknya memang baru muncul.
 */
export function CountUpOnView({ value, format, className = "", duration = 0.9 }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const doneRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = Number(value);
    if (!Number.isFinite(target)) return;

    const tulis = (v) => {
      el.textContent = format ? format(v) : String(Math.round(v));
    };

    if (reduce || doneRef.current) {
      tulis(target);
      return;
    }
    if (!inView) return;

    doneRef.current = true;
    let killed = false;
    import("gsap").then(({ gsap }) => {
      if (killed) return;
      const o = { v: 0 };
      gsap.to(o, {
        v: target,
        duration,
        ease: "power2.out",
        onUpdate: () => tulis(o.v),
        onComplete: () => tulis(target),
      });
    });
    return () => {
      killed = true;
    };
  }, [inView, value, format, duration, reduce]);

  return <span ref={ref} className={className}>{format ? format(0) : "0"}</span>;
}
