"use client";

import { useState, useEffect } from "react";

/**
 * Layar pemilihan provider.
 *
 * Bentuknya mengikuti dashboard di atas menu pada skrip terminal: operator
 * melihat KEADAAN sebelum memilih, bukan setelah. Angka di kartu dihitung dari
 * database lokal saja — tidak ada permintaan keluar, jadi halaman ini terbuka
 * seketika meski ada ratusan akun.
 *
 * Setiap kartu menyebut berkas skrip asalnya. Itu bukan hiasan: operator yang
 * sudah memakai skripnya perlu tahu kartu mana yang menggantikan berkas mana,
 * dan penyebutan itu juga yang membuat cakupan menu ini bisa diperiksa.
 */
export default function ProviderPicker({ onPick }) {
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/automation/overview", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) setProviders(d.providers || []);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || "Gagal memuat provider");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs font-medium text-error">
        {error}
      </p>
    );
  }

  if (!providers) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-32 animate-pulse rounded-[14px] bg-border-subtle/60" />
        ))}
      </div>
    );
  }

  const total = providers.reduce((n, p) => n + p.counts.total, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-text-main">Pilih provider</h2>
        <p className="text-xs text-text-muted">
          {total} akun di {providers.length} provider. Membuka salah satu akan menampilkan fitur yang
          tersedia untuknya.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p.id)}
            className="group flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4 text-left transition-colors hover:border-primary/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-text-main">{p.label}</div>
                <div className="truncate font-mono text-[10px] text-text-subtle">{p.source}</div>
              </div>
              <span
                className="material-symbols-outlined shrink-0 text-[18px] text-text-subtle transition-colors group-hover:text-primary"
                aria-hidden="true"
              >
                chevron_right
              </span>
            </div>

            <div className="flex items-baseline gap-3">
              <span className="tabular-nums text-2xl font-semibold text-text-main">
                {p.counts.total}
              </span>
              <span className="text-xs text-text-muted">akun</span>
            </div>

            {/* Angka masalah hanya muncul kalau ada — baris "0 bermasalah" di
                setiap kartu hanya menambah kebisingan tanpa memberi kabar. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="text-success">{p.counts.active} aktif</span>
              {p.counts.problem > 0 ? (
                <span className="text-error">{p.counts.problem} bermasalah</span>
              ) : null}
              {p.counts.unknown > 0 ? (
                <span className="text-text-subtle">{p.counts.unknown} perlu ditinjau</span>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-1">
              {p.kinds.quota ? <Chip>Cek kuota</Chip> : null}
              {p.kinds.test ? <Chip>Tes koneksi</Chip> : null}
              {p.kinds.prompt ? <Chip>Tes prompt</Chip> : null}
              {p.kinds.calls === "device" ? <Chip>Login device</Chip> : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Chip({ children }) {
  return (
    <span className="rounded-md bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
      {children}
    </span>
  );
}
