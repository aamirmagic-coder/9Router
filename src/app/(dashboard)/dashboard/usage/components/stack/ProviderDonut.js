"use client";

import { useMemo, useState, useId } from "react";
import { fmtCost, fmtTokenCount, fmtPercent, share } from "./format";

/**
 * Donut komposisi provider.
 *
 * ── Apa yang digambar, dan apa yang TIDAK ───────────────────────────────────
 *
 * Yang digambar adalah KOMPOSISI SEKARANG: berapa bagian tiap provider dari
 * total periode ini. Yang TIDAK digambar adalah tren — dan itu bukan
 * keterbatasan tampilan, melainkan keterbatasan data: provider yang mendominasi
 * hari ini bukan yang mendominasi minggu lalu, jadi menumpuknya dalam satu
 * gambar akan berbohong soal waktu. Kalau tren yang dibutuhkan, FlowChart yang
 * menjawabnya.
 *
 * ── Mengapa SVG, bukan pustaka chart ────────────────────────────────────────
 *
 * Recharts dipakai FlowChart karena ia butuh sumbu, brush, dan tooltip yang
 * mengikuti kursor. Di sini yang dibutuhkan satu lingkaran dengan potongan —
 * sekitar 40 baris SVG terhadap ~15KB bundel untuk fitur yang tidak dipakai.
 * Berkas ini sengaja tidak menambah dependensi.
 *
 * ── Sisa yang tidak masuk potongan ──────────────────────────────────────────
 *
 * Dengan 40+ provider, menggambar semuanya menghasilkan potongan berukuran
 * sebagian derajat yang tidak bisa diklik dan tidak bisa dibedakan. Yang
 * digambar adalah N terbesar; sisanya digabung menjadi satu potongan netral
 * berlabel "N lainnya". Itu jujur soal apa yang disembunyikan, dan operator
 * bisa menaikkan N.
 */
const DEFAULT_TOP = 8;

export default function ProviderDonut({
  rows,
  mode = "costs",
  colorOf,
  onPick = null,
  top = DEFAULT_TOP,
}) {
  const [hovered, setHovered] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const titleId = useId();

  const value = (r) => (mode === "tokens" ? r.tokens : r.cost);

  const data = useMemo(() => {
    const sorted = [...(rows || [])].sort((a, b) => value(b) - value(a));
    const limit = showAll ? sorted.length : top;
    const shown = sorted.slice(0, limit);
    const rest = sorted.slice(limit);

    const total = sorted.reduce((s, r) => s + (value(r) || 0), 0);
    const shownTotal = shown.reduce((s, r) => s + (value(r) || 0), 0);

    return {
      total,
      shown,
      restCount: rest.length,
      restValue: total - shownTotal,
      restPct: share(total - shownTotal, total),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, mode, top, showAll]);

  if (!data.total) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs font-medium text-text-main">Provider</p>
        <p className="text-xs text-text-muted">
          Belum ada pemakaian pada periode ini, jadi tidak ada yang bisa
          dibandingkan.
        </p>
      </div>
    );
  }

  // ── Geometri busur ────────────────────────────────────────────────────────
  const SIZE = 168;
  const R_OUT = 74;
  const R_IN = 50;
  const C = SIZE / 2;
  // Mulai dari jam 12, bukan jam 3: potongan pertama yang dibaca mata ada di
  // atas, dan itu yang seharusnya menjadi provider terbesar.
  const START = -90;

  const arcs = [];
  let cursor = START;
  for (const r of data.shown) {
    const pct = ((value(r) || 0) / data.total) * 360;
    if (pct <= 0) continue;
    arcs.push({ id: r.id, row: r, from: cursor, to: cursor + pct, pct: pct / 3.6 });
    cursor += pct;
  }
  if (data.restValue > 0) {
    const pct = (data.restValue / data.total) * 360;
    arcs.push({ id: "__rest", rest: true, from: cursor, to: cursor + pct, pct: pct / 3.6 });
  }

  const polar = (deg, radius) => {
    const rad = (deg * Math.PI) / 180;
    return [C + radius * Math.cos(rad), C + radius * Math.sin(rad)];
  };

  /** Satu segmen donut sebagai path dengan dua busur + dua garis radial. */
  const arcPath = (from, to) => {
    // Celah kecil antar-segmen supaya batasnya terbaca tanpa garis pemisah.
    const pad = Math.min(1.2, (to - from) / 6);
    const a0 = from + pad;
    const a1 = to - pad;
    if (a1 <= a0) return null;

    const large = a1 - a0 > 180 ? 1 : 0;
    const [x0, y0] = polar(a0, R_OUT);
    const [x1, y1] = polar(a1, R_OUT);
    const [x2, y2] = polar(a1, R_IN);
    const [x3, y3] = polar(a0, R_IN);

    return [
      `M ${x0.toFixed(2)} ${y0.toFixed(2)}`,
      `A ${R_OUT} ${R_OUT} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `L ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `A ${R_IN} ${R_IN} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}`,
      "Z",
    ].join(" ");
  };

  const fmtVal = mode === "tokens" ? fmtTokenCount : fmtCost;
  const active = hovered ? arcs.find((a) => a.id === hovered) : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">
          Provider
        </h3>
        <span className="text-[10px] text-text-subtle">
          {data.shown.length}
          {data.restCount ? ` + ${data.restCount}` : ""} provider
        </span>
      </div>

      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-5">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          width={SIZE}
          height={SIZE}
          className="shrink-0"
          role="img"
          aria-labelledby={titleId}
        >
          <title id={titleId}>
            Komposisi {mode === "tokens" ? "token" : "biaya"} per provider.{" "}
            {data.shown.map((r) => `${r.id} ${fmtPercent(share(value(r), data.total))}`).join(", ")}.
          </title>

          {arcs.map((a) => {
            const d = arcPath(a.from, a.to);
            if (!d) return null;
            const isActive = hovered === a.id;
            const dimmed = hovered && !isActive;
            return (
              <path
                key={a.id}
                d={d}
                fill={a.rest ? "var(--color-border)" : colorOf(a.id, "solid")}
                opacity={dimmed ? 0.35 : 1}
                className="cursor-pointer transition-opacity duration-150"
                onMouseEnter={() => setHovered(a.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={onPick && !a.rest ? () => onPick(a.row) : undefined}
              />
            );
          })}

          {/* Pusat: nilai potongan yang sedang disorot, atau total. */}
          <text
            x={C}
            y={C - 4}
            textAnchor="middle"
            className="fill-text-main text-[15px] font-semibold tabular-nums"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {active ? fmtPercent(active.pct) : fmtVal(data.total).replace(/^\$/, "$")}
          </text>
          <text
            x={C}
            y={C + 13}
            textAnchor="middle"
            className="fill-text-muted text-[9px]"
          >
            {active
              ? active.rest
                ? `${data.restCount} lainnya`
                : String(active.id).slice(0, 16)
              : mode === "tokens"
                ? "total token"
                : "total biaya"}
          </text>
        </svg>

        {/* Legenda. Setiap baris bisa disorot untuk menyorot potongannya —
            tanpa itu, memetakan warna ke provider berarti membaca bolak-balik. */}
        <ul className="flex min-w-0 flex-1 flex-col gap-1">
          {data.shown.map((r) => {
            const pct = share(value(r), data.total);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onMouseEnter={() => setHovered(r.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(r.id)}
                  onBlur={() => setHovered(null)}
                  onClick={onPick ? () => onPick(r) : undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                    hovered === r.id ? "bg-bg-hover" : ""
                  }`}
                >
                  <span
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: colorOf(r.id, "solid") }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-text-main">
                    {r.id}
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-text-muted">
                    {fmtPercent(pct)}
                  </span>
                  <span className="w-20 shrink-0 text-right tabular-nums text-xs text-text-main">
                    {fmtVal(value(r))}
                  </span>
                </button>
              </li>
            );
          })}

          {data.restValue > 0 ? (
            <li className="flex items-center gap-2 px-1.5 py-1">
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ backgroundColor: "var(--color-border)" }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                {data.restCount} provider lainnya
              </span>
              <span className="shrink-0 tabular-nums text-xs text-text-muted">
                {fmtPercent(data.restPct)}
              </span>
              <span className="w-20 shrink-0 text-right tabular-nums text-xs text-text-muted">
                {fmtVal(data.restValue)}
              </span>
            </li>
          ) : null}
        </ul>
      </div>

      {data.restCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="self-start rounded-md px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        >
          {showAll ? "Ringkas jadi 8 teratas" : `Tampilkan semua ${data.shown.length + data.restCount} provider`}
        </button>
      ) : null}
    </div>
  );
}
