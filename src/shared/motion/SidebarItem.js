"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/utils/cn";

/**
 * Satu baris menu sidebar, dengan indikator aktif yang BERGESER.
 *
 * ── Apa yang membuat ini terasa hidup, bukan sekadar beranimasi ─────────────
 *
 * Dua hal, dan yang kedua jauh lebih penting dari yang pertama:
 *
 * 1. **Masuk dengan stagger.** Menu muncul berurutan dari atas, 22ms jarak.
 *    Sekali per muat halaman; setelah itu diam.
 *
 * 2. **Sorotan aktif yang berpindah, bukan berkedip.** Inilah yang membedakan
 *    "ada animasi" dari "terasa hidup": waktu berpindah menu, latar sorotannya
 *    BERGESER dari menu lama ke menu baru lewat `layoutId`. Dua latar yang
 *    saling memudar akan terlihat sebagai kedipan; satu latar yang bergerak
 *    terbaca sebagai satu benda yang pindah tempat.
 *
 *    Motion menangani ini tanpa mengukur apa pun secara manual: `layoutId` yang
 *    sama di dua elemen membuatnya dianimasikan sebagai SATU elemen yang
 *    berpindah, berapa pun jaraknya.
 *
 * ── Yang tidak dianimasikan ────────────────────────────────────────────────
 *
 * Ikon tidak ikut bergerak, tidak berputar, tidak membesar. Menu sidebar
 * diklik puluhan kali sehari; hiasan yang lucu di situ menjadi gangguan pada
 * pemakaian kesepuluh. Yang bergerak hanya latar sorotan dan opasitas.
 */
export function SidebarItem({ item, active, index = 0, onNavigate }) {
  const reduce = useReducedMotion();
  const delay = reduce ? 0 : Math.min(index * 0.022, 0.28);

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.24, delay, ease: [0.2, 0.8, 0.2, 1] }}
      className="relative"
    >
      <Link
        href={item.href}
        onClick={onNavigate}
        data-active={active ? "" : undefined}
        className={cn(
          "relative flex items-center gap-3 px-3 py-1 rounded-lg transition-colors group",
          active ? "text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text-main"
        )}
      >
        {/* Latar sorotan. Dirender HANYA pada item yang aktif, dan `layoutId`
            membuat Motion memindahkannya saat item aktif berpindah. */}
        {active ? (
          <motion.span
            layoutId="sidebar-active"
            className="absolute inset-0 rounded-lg bg-primary/10"
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 520, damping: 42, mass: 0.7 }
            }
            aria-hidden="true"
          />
        ) : null}

        <span
          className={cn(
            "material-symbols-outlined relative text-[18px]",
            active ? "fill-1" : "group-hover:text-primary transition-colors"
          )}
          aria-hidden="true"
        >
          {item.icon}
        </span>
        <span className="relative text-[13px] font-medium">{item.label}</span>
      </Link>
    </motion.div>
  );
}
