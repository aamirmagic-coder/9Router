"use client";

import { useMemo, useState } from "react";

/**
 * Kalender aktivitas: satu kotak per hari, semakin pekat semakin berat.
 *
 * ── Mengapa hanya HARI, bukan hari × jam ────────────────────────────────────
 *
 * Versi yang ideal adalah kisi hari × jam, yang menjawab "jam berapa saya
 * paling sibuk". Data itu TIDAK ADA di 9Router: `/api/usage/chart` sudah
 * menjumlahkan per jam menjadi satu angka per bucket, dan `usageDaily` menyimpan
 * agregat per hari saja. Membuatnya berarti menambah query yang memindai
 * `usageHistory` per jam — untuk "all time" itu 58.000 baris setiap kali
 * halaman dibuka.
 *
 * Jadi yang digambar adalah yang datanya benar-benar ada: aktivitas per hari.
 * Pertanyaan "hari apa paling berat" terjawab; "jam berapa" tidak, dan itu
 * dinyatakan di layar alih-alih ditebak.
 *
 * ── Skala warna ─────────────────────────────────────────────────────────────
 *
 * Intensitas dihitung dari peringkat terhadap hari TERBERAT, bukan dari
 * ambang tetap. Ambang tetap ("di atas 1 juta token = gelap") salah begitu
 * pemakaian berubah besaran: periode sepi jadi seluruhnya pucat, periode ramai
 * jadi seluruhnya gelap. Relatif terhadap puncaknya, kalendernya selalu
 * terbaca.
 */
export default function ActivityHeatmap({ points, mode = "costs", onPickDay = null }) {
  const [hovered, setHovered] = useState(null);

  const value = (p) => (mode === "tokens" ? p.tokens : p.cost);

  const { days, max, total, activeDays } = useMemo(() => {
    const list = Array.isArray(points) ? points : [];
    const vals = list.map(value);
    const mx = Math.max(0, ...vals);
    return {
      days: list,
      max: mx,
      total: vals.reduce((a, b) => a + b, 0),
      activeDays: vals.filter((v) => v > 0).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, mode]);

  if (!days.length) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Aktivitas</p>
        <p className="text-xs text-text-muted">Belum ada data harian pada periode ini.</p>
      </div>
    );
  }

  /**
   * Lima tingkat dari peringkat 0-1.
   *
   * Hari tanpa pemakaian dapat tingkat tersendiri (`kosong`), bukan tingkat
   * paling pucat — "tidak ada aktivitas" dan "aktivitas sedikit" adalah dua hal
   * berbeda, dan yang pertama tidak boleh terlihat seperti yang kedua.
   */
  const level = (v) => {
    if (!v || v <= 0) return "kosong";
    const f = max > 0 ? v / max : 0;
    if (f > 0.75) return "puncak";
    if (f > 0.5) return "tinggi";
    if (f > 0.25) return "sedang";
    return "rendah";
  };

  const LEVEL_STYLE = {
    kosong: { bg: "var(--color-border-subtle)" },
    rendah: { bg: "oklch(0.62 0.17 262 / 0.22)" },
    sedang: { bg: "oklch(0.62 0.17 262 / 0.45)" },
    tinggi: { bg: "oklch(0.62 0.17 262 / 0.70)" },
    puncak: { bg: "oklch(0.62 0.17 262 / 1)" },
  };

  const fmtVal = (v) =>
    mode === "tokens" ? v.toLocaleString("en-US") : `$${Number(v).toFixed(2)}`;

  const aktif = hovered ? days[hovered] : null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Aktivitas</h3>
        <span className="text-[10px] text-text-subtle">
          {activeDays} dari {days.length} hari terpakai
        </span>
      </div>

      <div
        className="flex flex-wrap gap-[3px]"
        onMouseLeave={() => setHovered(null)}
        role="img"
        aria-label={`Aktivitas harian selama ${days.length} hari. Hari terberat: ${fmtVal(max)}.`}
      >
        {days.map((d, i) => {
          const lv = level(value(d));
          return (
            <button
              key={`${d.label}-${i}`}
              type="button"
              onMouseEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
              onClick={onPickDay ? () => onPickDay(d) : undefined}
              className="size-3 rounded-[3px] transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
              style={{ backgroundColor: LEVEL_STYLE[lv].bg }}
              aria-label={`${d.label}: ${fmtVal(value(d))}`}
            />
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
          {aktif ? (
            <>
              <span className="text-text-main">{aktif.label}</span>
              {" · "}
              <span className="text-text-main">{fmtVal(value(aktif))}</span>
              {mode !== "tokens" && aktif.tokens ? ` · ${aktif.tokens.toLocaleString("en-US")} token` : null}
            </>
          ) : (
            <>Pekatnya warna = besarnya pemakaian hari itu</>
          )}
        </p>

        {/* Legenda skala. Tanpa ini, "seberapa pekat itu banyak?" tidak
            terjawab dan kalendernya hanya jadi hiasan. */}
        <div className="flex shrink-0 items-center gap-1" aria-hidden="true">
          <span className="text-[10px] text-text-subtle">ringan</span>
          {["rendah", "sedang", "tinggi", "puncak"].map((lv) => (
            <span
              key={lv}
              className="size-2.5 rounded-[2px]"
              style={{ backgroundColor: LEVEL_STYLE[lv].bg }}
            />
          ))}
          <span className="text-[10px] text-text-subtle">berat</span>
        </div>
      </div>
    </div>
  );
}
