"use client";

import { useEffect, useState } from "react";
import { fmtFull, fmtAgo, fmtExact, fmtWhole } from "./format";
import AnimatedNumber from "./AnimatedNumber";

/**
 * LivePanel — request yang sedang berjalan + request terakhir, realtime.
 *
 * Datanya menumpang payload stats yang sudah mengalir lewat SSE
 * (`activeRequests` / `recentRequests` di-merge ringan oleh
 * UsageStackConnected setiap ada event `pending`, throttle ±1 dtk dari
 * repo). Panel ini TIDAK fetch sendiri — menambah EventSource kedua hanya
 * menggandakan koneksi untuk data yang sama.
 *
 * Yang di-tick lokal tiap detik hanya WAKTU (elapsed + "x lalu"), dihitung
 * dari `startedAt` / `timestamp` terhadap jam browser. Angka token tetap
 * milik server: push berikutnya yang memperbaruinya. Tanpa tick lokal,
 * "12s" akan beku di antara dua push dan panel tidak terasa realtime.
 */

// Nama provider yang bisa dibaca manusia — logika yang sama dengan
// providerLabel di StackHead/UsageStack (id node kustom = UUID panjang).
// Duplikasi disengaja: helper itu lokal di tiap berkas, bukan ekspor.
function providerLabel(id, nodeNames) {
  if (!id) return "—";
  const named = nodeNames?.[id];
  if (named) return named;
  if (id.length <= 22) return id;
  return `${id.slice(0, 14)}…`;
}

/**
 * Durasi berjalan "3s" / "2m 05s" / "1h 12m". `startedAt` null (request yang
 * mulai sebelum metadata ada) → "—", bukan "0s" yang berpura-pura presisi.
 */
function fmtElapsed(startedAt, fallbackMs, now) {
  const t = startedAt ? Date.parse(startedAt) : NaN;
  const ms = Number.isFinite(t) ? Math.max(0, now - t) : fallbackMs;
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Waktu relatif pendek dengan DETIK ("5s ago", "3m ago", "2h ago").
 *
 * `fmtTime` di format.js meruntuhkan <45 dtk menjadi "now" — tepat untuk
 * daftar drill-down yang jarang berubah, tapi di panel live ini request yang
 * selesai 5 vs 40 dtk lalu harus terlihat bedanya. Tooltip memakai fmtAgo +
 * fmtExact yang panjang supaya tidak ada informasi yang hilang.
 */
function fmtRel(timestamp, now) {
  const t = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const RECENT_LIMIT = 8;

export default function LivePanel({ stats, nodeNames = {} }) {
  const active = stats?.activeRequests || [];
  const recent = (stats?.recentRequests || []).slice(0, RECENT_LIMIT);
  // Jumlah request berjalan, bukan jumlah baris: baris agregat fallback bisa
  // membawa count > 1 (request tanpa metadata).
  const activeCount = active.reduce((s, a) => s + (a.count || 0), 0);

  // Tick lokal 1 dtk untuk waktu. Interval hanya hidup saat ada yang bisa
  // berubah (ada baris live atau recent) supaya tab idle tidak bangun tiap
  // detik tanpa alasan.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (active.length === 0 && recent.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active.length, recent.length]);

  return (
    <section aria-label="Live requests" className="min-w-0 rounded-[14px] border border-border bg-surface px-4 py-3">
      {/* ── Sedang berjalan ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <span className="relative flex size-2" aria-hidden="true">
          {activeCount > 0 ? (
            <>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </>
          ) : (
            <span className="relative inline-flex size-2 rounded-full bg-border" />
          )}
        </span>
        <h3 className="text-xs font-semibold text-text-main">
          Live
        </h3>
        <span className="text-[0.6875rem] tabular-nums text-text-muted">
          {activeCount > 0 ? `${activeCount} running` : "idle"}
        </span>
      </div>

      {activeCount > 0 ? (
        <ul className="mt-2 flex min-w-0 flex-col divide-y divide-border-subtle">
          {active.map((a, i) => {
            const inEst = a.inputEstimated ? "~" : "";
            return (
              <li key={`${a.model}|${a.provider}|${a.account}|${a.startedAt || "?"}|${i}`} className="flex min-w-0 items-baseline gap-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-text-main" title={a.model}>
                    {a.model || "—"}
                  </p>
                  <p className="truncate text-[0.6875rem] text-text-muted">
                    {providerLabel(a.provider, nodeNames)}
                    {a.account ? ` · ${a.account}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {/* Angka penuh + tabular-nums, ikut aturan halaman ini:
                      tidak ada singkatan "1.2K" di kolom angka. "~" = estimasi
                      pra-TTFT dari ukuran body, diganti angka asli begitu chunk
                      pertama ber-usage tiba. */}
                  <p className="text-xs tabular-nums text-text-main" title={a.inputEstimated ? "Estimated from request size — real count arrives with the first usage chunk" : fmtAgo(a.startedAt)}>
                    <span className="text-text-muted">↓</span> {inEst}
                    <AnimatedNumber value={a.inputTokens} format={fmtWhole} />{" "}
                    <span className="text-text-muted">↑</span>{" "}
                    <AnimatedNumber value={a.outputTokens} format={fmtWhole} />
                  </p>
                  <p className="text-[0.6875rem] tabular-nums text-text-subtle">
                    {a.startedAt ? (
                      <time dateTime={a.startedAt} title={fmtExact(a.startedAt)}>
                        {fmtElapsed(a.startedAt, a.elapsedMs, now)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-text-muted">
          No running requests — new ones appear here the moment they start.
        </p>
      )}

      {/* ── Terakhir ────────────────────────────────────────────────── */}
      <div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-3">
        <h3 className="text-xs font-semibold text-text-main">
          Recent
        </h3>
        <span className="text-[0.6875rem] text-text-muted">
          latest finished requests
        </span>
      </div>

      {recent.length > 0 ? (
        <ul className="mt-1.5 flex min-w-0 flex-col divide-y divide-border-subtle">
          {recent.map((r, i) => (
            <li key={`${r.timestamp}|${r.model}|${r.provider}|${r.totalTokens}|${i}`} className="flex min-w-0 items-baseline gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-text-main" title={r.model}>
                  {r.model || "—"}
                  <span className="ml-1.5 font-normal text-text-muted">
                    {providerLabel(r.provider, nodeNames)}
                  </span>
                </p>
                {r.account ? (
                  <p className="truncate text-[0.6875rem] text-text-subtle">{r.account}</p>
                ) : null}
              </div>
              <p className="shrink-0 text-xs tabular-nums text-text-muted" title={fmtFull(r.totalTokens)}>
                <AnimatedNumber value={r.totalTokens} format={fmtWhole} /> tok
              </p>
              <p className="w-16 shrink-0 text-right text-[0.6875rem] tabular-nums text-text-subtle">
                <time dateTime={r.timestamp} title={`${fmtExact(r.timestamp)} — ${fmtAgo(r.timestamp)}`}>
                  {fmtRel(r.timestamp, now)}
                </time>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-text-muted">
          No finished requests recorded yet.
        </p>
      )}
    </section>
  );
}
