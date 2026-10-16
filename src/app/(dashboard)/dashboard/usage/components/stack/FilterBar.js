"use client";

import { useEffect, useRef } from "react";

/**
 * Baris saring — satu input pencarian + penanda saringan aktif.
 *
 * Pencarian mencakup SEMUA lapis sekaligus (provider, model, akun, endpoint):
 * operator yang mencari "antigravity" biasanya tidak peduli di lapis mana
 * namanya muncul, ia hanya ingin melihat yang cocok. Karena itu lapis yang
 * punya hasil dibuka paksa saat pencarian aktif.
 *
 * Tombol pintas "/" memfokuskan input — kebiasaan yang sudah ada di banyak
 * alat, dan menghemat satu perjalanan ke tetikus.
 */

export default function FilterBar({
  query,
  onQueryChange,
  activeFilter,
  onClearFilter,
  resultCount,
  totalCount,
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      // Jangan rampas tombol saat operator sedang menulis di kolom lain.
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        onQueryChange("");
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onQueryChange]);

  const searching = query.trim().length > 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <span
          className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-text-subtle"
          aria-hidden="true"
        >
          search
        </span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search provider, model, account…"
          aria-label="Search usage across all dimensions"
          className={[
            "w-full rounded-lg border border-border bg-surface py-1.5 pl-8 pr-8 text-sm text-text-main",
            "placeholder:text-text-subtle",
            "transition-colors duration-150",
            "hover:border-text-subtle/40",
            "focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/25",
          ].join(" ")}
        />
        {searching ? (
          <button
            type="button"
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center rounded p-0.5 text-text-subtle transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              close
            </span>
          </button>
        ) : (
          // Petunjuk tombol pintas — hanya tampil di layar lebar, karena di
          // sentuh tidak ada papan ketik yang perlu dijelaskan.
          <kbd
            className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 text-[10px] font-medium text-text-subtle sm:block"
            aria-hidden="true"
          >
            /
          </kbd>
        )}
      </div>

      {/* Saringan aktif sebagai chip yang bisa dilepas — bukan state tersembunyi
          yang harus dicari operator ke mana perginya. */}
      {activeFilter ? (
        <button
          type="button"
          onClick={onClearFilter}
          className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/8 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          title="Remove provider filter"
        >
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            filter_alt
          </span>
          <span className="max-w-[10rem] truncate">{activeFilter}</span>
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            close
          </span>
        </button>
      ) : null}

      {/* Jumlah hasil — hanya saat ada yang menyaring, supaya saat normal baris
          ini tidak menambah suara. */}
      {searching || activeFilter ? (
        <span className="text-xs tabular-nums text-text-muted" role="status" aria-live="polite">
          {resultCount} of {totalCount}
        </span>
      ) : null}
    </div>
  );
}
