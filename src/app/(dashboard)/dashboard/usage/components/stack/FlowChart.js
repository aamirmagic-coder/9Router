"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Brush,
  ResponsiveContainer,
} from "recharts";
import { fmtTokens, fmtTokenCount, fmtCost } from "./format";

/**
 * Chart aliran — satu seri agregat dari /api/usage/chart.
 *
 * PENTING soal kebenaran data: endpoint ini HANYA mengembalikan satu seri
 * ({label, tokens, cost}). Tidak ada breakdown per-provider sepanjang waktu, dan
 * menumpuk beberapa seri palsu dari proporsi sekarang akan berbohong soal
 * waktu — proporsi provider hari ini bukan proporsi provider minggu lalu.
 *
 * Jadi yang ditambahkan di sini bukan seri palsu, melainkan INTERAKSI yang
 * memang bisa didukung datanya:
 *   · Brush — pilih rentang waktu, dan ringkasan di bawah mengikuti rentang itu.
 *   · Puncak yang bisa diklik — lompat ke titik tertinggi.
 *   · Ringkasan terpilih yang selalu terlihat (bukan hanya di tooltip).
 *
 * Warna diambil dari token tema; tidak ada gradient text, tidak ada glow.
 */

const EASE = "cubic-bezier(.2,.8,.2,1)";

export default function FlowChart({ period, mode }) {
  const [data, setData] = useState([]);
  // Track periode mana yang datanya sudah ada. "Memuat" DITURUNKAN dari sini
  // alih-alih disimpan sebagai state terpisah — satu nilai yang bisa basi,
  // bukan dua yang bisa berbeda.
  const [loadedPeriod, setLoadedPeriod] = useState(null);
  const [range, setRange] = useState(null); // { startIndex, endIndex }
  const loading = loadedPeriod !== period;
  // Rentang menyimpan PERIODE-nya sendiri. Indeks rentang hanya bermakna untuk
  // seri yang sedang tampil, jadi rentang dari periode lain otomatis diabaikan
  // waktu dibaca — tanpa effect yang harus meresetnya saat periode berganti.
  const activeRange = range?.period === period ? range : null;

  // Pengambilan data ditulis sebagai rantai promise LANGSUNG di dalam effect,
  // mengikuti pola yang sudah dipakai di repo ini: setiap setState terjadi di
  // dalam callback async, bukan di body effect. Versi `await` di dalam
  // useCallback memicu aturan `react-hooks/set-state-in-effect` karena panggilan
  // pertamanya terlihat sinkron — dan aturan itu benar: menulis state sebelum
  // render pertama selesai adalah sumber render berantai.
  //
  // AbortController membatalkan permintaan yang sudah tidak relevan: periode
  // bisa berganti lagi sebelum request selesai, dan respons lama akan menimpa
  // yang baru kalau tidak dibatalkan.
  useEffect(() => {
    const ac = new AbortController();
    const requestedPeriod = period;

    fetch(`/api/usage/chart?period=${encodeURIComponent(requestedPeriod)}`, { signal: ac.signal })
      .then((res) => (res.ok ? res.json() : []))
      .then((json) => {
        setData(Array.isArray(json) ? json : []);
        setLoadedPeriod(requestedPeriod);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") {
          console.warn("[usage] failed to load chart:", e?.message || e);
          setData([]);
          setLoadedPeriod(requestedPeriod);
        }
      });

    return () => ac.abort();
  }, [period]);

  // Chart menggambar SATU besaran. Di mode "both" yang digambar adalah biaya —
  // sama dengan basis peringkat lapis di bawahnya, supaya sumbu-Y dan urutan
  // baris tidak membaca dua hal berbeda.
  const key = mode === "tokens" ? "tokens" : "cost";

  // Dua formatter, karena dua tempat ini punya batasan yang berbeda:
  //
  //   · Sumbu-Y hanya selebar 52px. Angka penuh di sana akan terpotong, dan
  //     label sumbu memang hanya penunjuk arah — ringkas di sini justru benar.
  //   · Tooltip dan ringkasan muncul saat operator menunjuk atau memilih, dan
  //     ruangnya cukup. Angka di sana harus angka yang sama dengan yang
  //     tertulis di tabel di bawah; ringkasan yang membulat sementara tabelnya
  //     penuh membuat keduanya tampak tidak sinkron.
  const axisFormatter = mode === "tokens" ? fmtTokens : fmtCost;
  const formatter = mode === "tokens" ? fmtTokenCount : fmtCost;

  const hasData = data.some((d) => (d?.[key] || 0) > 0);

  // Rentang terpilih (atau seluruh seri kalau brush belum disentuh). Ringkasan
  // di bawah chart membaca dari sini, sehingga angka yang tampil selalu cocok
  // dengan yang terlihat di layar.
  const visible = useMemo(() => {
    if (!activeRange) return data;
    return data.slice(activeRange.startIndex, activeRange.endIndex + 1);
  }, [data, activeRange]);

  const summary = useMemo(() => {
    if (visible.length === 0) return null;
    let sum = 0;
    let peak = { value: 0, label: null };
    for (const d of visible) {
      const v = d?.[key] || 0;
      sum += v;
      if (v > peak.value) peak = { value: v, label: d.label };
    }
    return { sum, peak, count: visible.length };
  }, [visible, key]);

  const peakIndex = useMemo(() => {
    let idx = -1;
    let best = 0;
    data.forEach((d, i) => {
      const v = d?.[key] || 0;
      if (v > best) {
        best = v;
        idx = i;
      }
    });
    return best > 0 ? idx : -1;
  }, [data, key]);

  const strokeColor = "var(--color-primary)";

  return (
    <section className="min-w-0" aria-label="Usage over time">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold tracking-tight text-text-main">Flow</h3>

        {summary ? (
          <span className="text-xs text-text-muted">
            <span className="tabular-nums text-text-main">{formatter(summary.sum)}</span>{" "}
            {mode === "tokens" ? "tokens" : "spent"}
            {activeRange ? (
              <>
                <span className="mx-1.5 text-text-subtle">·</span>
                <span>
                  {visible[0]?.label}–{visible[visible.length - 1]?.label}
                </span>
              </>
            ) : null}
            {summary.peak.value > 0 ? (
              <>
                <span className="mx-1.5 text-text-subtle">·</span>
                <span>
                  peak <span className="tabular-nums text-text-main">{summary.peak.label}</span>
                </span>
              </>
            ) : null}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {activeRange ? (
            <button
              type="button"
              onClick={() => setRange(null)}
              className="rounded-md px-2 py-0.5 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              Reset range
            </button>
          ) : null}
          {peakIndex >= 0 ? (
            <button
              type="button"
              onClick={() =>
                setRange({ period, startIndex: Math.max(0, peakIndex - 1), endIndex: Math.min(data.length - 1, peakIndex + 1) })
              }
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
              title={`Zoom to peak (${data[peakIndex]?.label})`}
            >
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                zoom_in
              </span>
              Peak
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3" style={{ height: 200 }}>
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-subtle">
            <span className="material-symbols-outlined animate-spin text-[24px]" aria-hidden="true">
              progress_activity
            </span>
          </div>
        ) : !hasData ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-text-muted">
            <span className="text-sm">No activity in this period.</span>
            <span className="text-xs text-text-subtle">
              The chart fills as requests flow through the gateway.
            </span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="flowFill" x1="0" y1="0" x2="0" y2="1">
                  {/* Satu warna dengan dua tingkat alfa — bukan gradient dua
                      hue. Ini memberi massa tanpa menambah warna baru ke
                      halaman. */}
                  <stop offset="0%" stopColor={strokeColor} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={strokeColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="2 4" strokeOpacity={0.12} vertical={false} />

              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--color-text-subtle)" }}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--color-text-subtle)" }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(v) => axisFormatter(v)}
              />

              <Tooltip
                // `isAnimationActive` + durasi pendek: tooltip Recharts muncul
                // seketika, dan pada data yang bergerak itu terasa berkedip.
                // 120ms cukup untuk terasa halus tanpa terasa lambat saat
                // kursor digerakkan cepat melintasi chart.
                isAnimationActive
                animationDuration={120}
                animationEasing="ease-out"
                cursor={{
                  stroke: "var(--color-border)",
                  strokeWidth: 1,
                  // Garis kursor ikut beranimasi, bukan melompat antar-titik.
                  style: { transition: "transform 120ms cubic-bezier(.2,.8,.2,1)" },
                }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const v = payload[0]?.value || 0;
                  return (
                    <div className="rounded-lg border border-border bg-surface px-2.5 py-1.5 shadow-[var(--shadow-elevated)]">
                      <div className="text-[11px] text-text-subtle">{label}</div>
                      <div className="text-sm font-medium tabular-nums text-text-main">
                        {formatter(v)} {mode === "tokens" ? "tokens" : ""}
                      </div>
                    </div>
                  );
                }}
              />

              <Area
                type="monotone"
                dataKey={key}
                stroke={strokeColor}
                strokeWidth={2}
                fill="url(#flowFill)"
                dot={false}
                // Titik aktif tumbuh dari kecil; tanpa transisi, ia muncul
                // seketika dan mata kehilangan jejak titik mana yang disorot.
                activeDot={{
                  r: 4,
                  strokeWidth: 0,
                  style: { transition: "r 120ms cubic-bezier(.2,.8,.2,1)" },
                }}
                isAnimationActive
                animationDuration={400}
                animationEasing="ease-out"
              />

              {/* Brush — hanya muncul kalau titiknya cukup banyak untuk berarti.
                  Di bawah 8 titik, menyaring rentang tidak berguna. */}
              {data.length >= 8 ? (
                <Brush
                  dataKey="label"
                  height={22}
                  travellerWidth={8}
                  stroke="var(--color-border)"
                  fill="var(--color-bg-subtle)"
                  onChange={(e) => {
                    if (typeof e?.startIndex === "number" && typeof e?.endIndex === "number") {
                      setRange({ period, startIndex: e.startIndex, endIndex: e.endIndex });
                    }
                  }}
                />
              ) : null}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

export { EASE };
