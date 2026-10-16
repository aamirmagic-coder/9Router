"use client";

import { cn } from "@/shared/utils/cn";
import { motion, useReducedMotion } from "motion/react";

/**
 * Kartu — dipakai 69 berkas di seluruh dashboard.
 *
 * ── Mengapa animasinya di SINI, bukan di tiap halaman ───────────────────────
 *
 * Menambahkan entrance animation ke 24 halaman berarti 24 tempat yang bisa
 * salah, masing-masing dengan durasi dan easing sendiri. Karena hampir semua
 * halaman menyusun dirinya dari `Card`, satu perubahan di berkas ini menjangkau
 * seluruh aplikasi dengan satu tata bahasa gerak.
 *
 * ── Yang dianimasikan, dan yang TIDAK ──────────────────────────────────────
 *
 * Hanya opacity dan geser 10px, 240ms. Tidak ada skala dan tidak ada blur:
 * keduanya memaksa repaint seluruh kartu, dan pada halaman dengan belasan kartu
 * itu terasa tersendat.
 *
 * `hover` yang sudah ada (bayangan + border) TIDAK diganti — ia tetap CSS
 * transition seperti semula, karena mengubahnya menjadi animasi Motion berarti
 * mengubah perilaku yang sudah dipakai. Yang ditambahkan hanya kemunculannya.
 *
 * ── Mengapa TIDAK ikut stagger halaman ────────────────────────────────────
 *
 * Sebelumnya kartu ini bisa mewarisi `staggerChildren` dari `PageTransition`.
 * Itu dilepas: `staggerChildren` tidak punya batas atas, dan halaman dengan
 * ratusan kartu (Providers) membuat kartu terakhir baru muncul setelah beberapa
 * detik — terlihat kosong, dan halaman tampak rusak. Kartu sekarang selalu
 * beranimasi sendiri, serentak. Stagger yang TERBATAS tetap tersedia lewat
 * primitif `Stagger` untuk daftar yang jumlahnya diketahui.
 */
export default function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  elev = false,
  className,
  /** Matikan animasi masuk untuk kartu di dalam daftar besar. */
  animate = true,
  delay = 0,
  ...props
}) {
  const reduce = useReducedMotion();

  const paddings = {
    none: "",
    xs: "p-3",
    sm: "p-4",
    md: "p-6",
    lg: "p-8",
  };

  const kelas = cn(
    "bg-surface border border-border-subtle",
    elev ? "rounded-[14px] shadow-[var(--shadow-elev)]" : "rounded-[14px] shadow-[var(--shadow-soft)]",
    hover && "hover:shadow-[var(--shadow-warm)] hover:border-brand-500/30 transition-all cursor-pointer",
    paddings[padding],
    className
  );

  // Tanpa animasi (prefers-reduced-motion, atau diminta mati oleh pemanggil):
  // elemen biasa, tanpa lapisan Motion sama sekali.
  if (reduce || !animate) {
    return (
      <div className={kelas} {...props}>
        <IsiKartu title={title} subtitle={subtitle} icon={icon} action={action}>
          {children}
        </IsiKartu>
      </div>
    );
  }

  // Muncul sendiri — serentak dengan kartu lain di halaman yang sama. Untuk
  // daftar yang jumlahnya terbatas, bungkus dengan primitif `Stagger`.
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: [0.2, 0.8, 0.2, 1] }}
      className={kelas}
      {...props}
    >
      <IsiKartu title={title} subtitle={subtitle} icon={icon} action={action}>
        {children}
      </IsiKartu>
    </motion.div>
  );
}

/** Kepala kartu dipisah supaya tidak ditulis dua kali di kedua cabang di atas. */
function IsiKartu({ children, title, subtitle, icon, action }) {
  return (
    <>
      {(title || action) && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="p-2 rounded-[10px] bg-bg text-text-muted">
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">{icon}</span>
              </div>
            )}
            <div>
              {title && (
                <h3 className="text-text-main font-semibold">{title}</h3>
              )}
              {subtitle && (
                <p className="text-sm text-text-muted">{subtitle}</p>
              )}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </>
  );
}

Card.Section = function CardSection({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "p-4 rounded-[10px]",
        "bg-bg border border-border-subtle",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.Row = function CardRow({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "p-3 -mx-3 px-3 transition-colors",
        "border-b border-border-subtle last:border-b-0",
        "hover:bg-surface-2/50",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.ListItem = function CardListItem({
  children,
  actions,
  className,
  ...props
}) {
  return (
    <div
      className={cn(
        "group flex items-center justify-between p-3 -mx-3 px-3",
        "border-b border-border-subtle last:border-b-0",
        "hover:bg-surface-2/50 transition-colors",
        className
      )}
      {...props}
    >
      <div className="flex-1 min-w-0">{children}</div>
      {actions && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
};
