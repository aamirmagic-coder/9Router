"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Angka yang bergerak ke nilai baru, bukan melompat.
 *
 * ── Mengapa ada, padahal sudah ada fade ─────────────────────────────────────
 *
 * `value-fade` yang lama hanya menganimasikan OPASITAS: angkanya tetap melompat
 * dari 3,69 ke 3,75, yang terlihat cuma kedipan. Yang membuat angka terasa
 * hidup adalah nilainya benar-benar berjalan — dan itu yang dilakukan di sini.
 *
 * ── Tiga jebakan yang menentukan bentuk hook ini ────────────────────────────
 *
 * 1. **Jangan pernah menganimasikan dari 0 pada render pertama.**
 *    Kalau nilai awal dihitung dari 0 lalu berjalan naik, membuka halaman
 *    menampilkan "$0.00 → $3,69" — dan selama ~600ms pertama angkanya BERBOHONG.
 *    Halaman ini ada untuk dipercaya; angka yang sedang berjalan ke nilai yang
 *    benar adalah angka yang salah. Karena itu render pertama memakai nilai
 *    akhirnya apa adanya, dan animasi hanya dijalankan saat nilai BERUBAH.
 *
 * 2. **Animasi untuk angka yang sedang live harus lebih pendek.**
 *    SSE memperbarui beberapa kali per detik. Kalau tiap perubahan dianimasikan
 *    600ms, animasinya tidak pernah selesai sebelum nilai berikutnya datang, dan
 *    angkanya tertinggal dari kenyataan selamanya. Yang dipakai di sini: durasi
 *    tetap 420ms dengan easing yang cepat di awal, sehingga nilai baru tiba
 *    saat animasi sudah ~95% selesai.
 *
 * 3. **`prefers-reduced-motion` bukan hiasan.** Operator yang sudah mematikan
 *    animasi di sistemnya berarti tidak ingin angka bergerak. Hook ini
 *    menghormatinya dengan melompat langsung ke nilai akhir.
 *
 * Nilai yang dikembalikan adalah ANGKA, bukan string. Pemformatnya tetap milik
 * pemanggil (`fmtCost`, `fmtFull`, `fmtTokenCount`), sehingga aturan halaman ini
 * — tidak ada singkatan, pemisah ribuan, presisi biaya — tidak bisa dilanggar
 * oleh animasinya.
 */

/** Apakah pengguna meminta animasi dikurangi. Reaktif terhadap perubahan. */
export function usePrefersReducedMotion() {
  // Nilai awal `false` di server dan klien supaya hidrasi cocok; nilai
  // sebenarnya dibaca di effect, bukan saat render.
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Ditunda satu microtask: membaca keadaan sistem di badan effect memicu
    // render berantai. Kegagalan pembacaan tidak apa-apa — nilai bawaannya
    // `false` (animasi jalan), yang berarti perilaku paling umum.
    queueMicrotask(() => setReduced(mq.matches));
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}

/**
 * ── Bagian MURNI, dipisah supaya bisa diuji tanpa DOM ───────────────────────
 *
 * Hook React butuh DOM untuk dijalankan, dan repo ini tidak punya jsdom maupun
 * @testing-library/react. Menambahkan keduanya demi satu hook kecil bukan
 * pertukaran yang baik.
 *
 * Yang benar adalah memisahkan matematikanya: bagian yang bisa salah — easing,
 * interpolasi, penjagaan "jangan animasikan dari nol", batas waktu — semuanya
 * fungsi murni di bawah ini, dan itulah yang diuji. Sisa hook-nya hanya
 * perkabelan `requestAnimationFrame`, yang diverifikasi di browser tempat ia
 * benar-benar berjalan.
 */

/** Easing: cepat di awal, melambat di akhir. Tidak pernah melewati target. */
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Nilai antara `from` dan `to` pada kemajuan `t` (0–1), dengan easing. */
export function interpolate(from, to, t) {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return from + (to - from) * easeOutCubic(clamped);
}

/** Sama, untuk daftar sepanjang sama. Panjang berbeda → pakai nilai tujuan. */
export function interpolateList(from, to, t) {
  if (!Array.isArray(to)) return [];
  if (!Array.isArray(from) || from.length !== to.length) return to;
  return to.map((target, i) => interpolate(from[i], target, t));
}

/**
 * Apakah sebuah perubahan perlu dianimasikan.
 *
 * Nilai yang sama TIDAK dianimasikan: SSE mengirim angka yang sama beberapa kali
 * per detik, dan menganimasikannya membuat angka berkedip tanpa pernah berubah.
 */
export function shouldAnimate(prev, next) {
  if (!Number.isFinite(next)) return false;
  return prev !== next;
}

/** Angka apa pun yang tidak sah dibaca sebagai 0, bukan NaN yang merambat. */
export function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {number} target  Nilai yang dituju.
 * @param {object} opts
 *   · `duration` — milidetik. Default 420.
 */
export function useAnimatedNumber(target, { duration = 420 } = {}) {
  const reduced = usePrefersReducedMotion();
  const num = safeNumber(target);
  const valid = Number.isFinite(Number(target));

  // Nilai yang DITAMPILKAN. Diinisialisasi dengan target, bukan 0 — lihat
  // jebakan (1) di atas.
  const [shown, setShown] = useState(valid ? num : 0);

  /** Nilai yang sedang ditampilkan, dibaca oleh animasi tanpa memicu render. */
  const fromRef = useRef(valid ? num : 0);
  /** Nilai tujuan terakhir yang sudah diproses, untuk mendeteksi perubahan. */
  const targetRef = useRef(valid ? num : 0);
  const frameRef = useRef(null);

  useEffect(() => {
    if (!valid) return;

    // Nilai tidak berubah: tidak ada yang perlu dianimasikan. Ini yang membuat
    // SSE yang mengirim angka sama berulang kali tidak memicu animasi sia-sia.
    if (!shouldAnimate(targetRef.current, num)) return;

    const from = fromRef.current;
    targetRef.current = num;

    if (reduced) {
      fromRef.current = num;
      // Lompat langsung, tapi lewat microtask supaya tidak ada setState di
      // badan effect. Hasilnya sama: nilainya sudah benar sebelum frame
      // berikutnya digambar.
      queueMicrotask(() => setShown(num));
      return;
    }

    if (frameRef.current) cancelAnimationFrame(frameRef.current);

    // Waktu mulai diambil di frame pertama, BUKAN di sini: `requestAnimationFrame`
    // tidak dijamin berjalan pada waktu yang diminta, dan memakai cap waktu
    // sebelum penjadwalan membuat animasinya meleset di frame pertama.
    let startTime = null;

    const step = (now) => {
      if (startTime === null) startTime = now;
      const t = Math.min(1, (now - startTime) / duration);
      const value = interpolate(from, num, t);

      fromRef.current = value;
      setShown(value);

      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        // Pastikan mendarat TEPAT di target: pembulatan floating-point bisa
        // menyisakan selisih yang terlihat pada angka berdesimal.
        fromRef.current = num;
        setShown(num);
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [num, valid, duration, reduced]);

  return valid ? shown : 0;
}

/**
 * Versi untuk daftar nilai yang berubah bersama-sama (mis. semua provider di
 * satu strip). Satu animasi untuk seluruh daftar, bukan satu per nilai — dengan
 * 40 provider, 40 loop `requestAnimationFrame` sendiri-sendiri akan saling
 * berebut frame yang sama.
 *
 * Mengembalikan array dengan panjang yang sama, dalam urutan yang sama.
 */
export function useAnimatedNumbers(targets, { duration = 420 } = {}) {
  const reduced = usePrefersReducedMotion();
  const list = Array.isArray(targets) ? targets.map(safeNumber) : [];
  const [shown, setShown] = useState(() => list);

  const targetRef = useRef(list);
  const currentRef = useRef(list);
  const frameRef = useRef(null);

  // Panjang berubah (provider baru muncul) → tidak ada pasangan lama untuk
  // dianimasikan. Nilai barunya langsung dipakai.
  const lenKey = list.length;

  useEffect(() => {
    const same =
      targetRef.current.length === list.length &&
      list.every((v, i) => v === targetRef.current[i]);
    if (same) return;

    const from = currentRef.current.length === list.length ? currentRef.current : list;
    targetRef.current = list;

    if (reduced) {
      currentRef.current = list;
      queueMicrotask(() => setShown(list));
      return;
    }

    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    let startTime = null;

    const step = (now) => {
      if (startTime === null) startTime = now;
      const t = Math.min(1, (now - startTime) / duration);
      const next = interpolateList(from, list, t);

      currentRef.current = next;
      setShown(next);

      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        currentRef.current = list;
        setShown(list);
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lenKey, list.join("|"), duration, reduced]);

  return shown;
}
