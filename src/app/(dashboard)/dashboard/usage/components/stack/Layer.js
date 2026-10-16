"use client";

import { useId, useState } from "react";
import AnimatedNumber from "./AnimatedNumber";

/**
 * Lapis — unit dasar struktur halaman Usage.
 *
 * Ini pengganti tab. Bedanya penting: tab MENGGANTI isi (pindah konteks, yang
 * lama hilang), sedangkan lapis MEMBUKA isi di tempat sementara lapis induknya
 * tetap terbaca. Itu yang membuat hierarki provider → model → request bisa
 * dilihat utuh dalam satu kolom, bukan sebagai tiga halaman terpisah.
 *
 * Bentuknya sengaja bukan <details>/<summary>: kita butuh kontrol penuh atas
 * animasi tinggi, status `aria-expanded` yang benar, dan isi yang tetap ada di
 * DOM saat tertutup untuk pencarian lintas-lapis.
 */

const EASE = "cubic-bezier(.2,.8,.2,1)";
const DURATION = 240;

export default function Layer({
  title,
  meta,              // ringkasan singkat yang tetap terlihat saat tertutup
  count,             // angka di ujung kanan — rata kanan, lebar tetap
  countValue,        // nilai mentah untuk angka itu; dipakai agar bisa beranimasi
  countFormat,       // (nilai) → string, pasangan `countValue`
  countSecondary,    // nilai pendamping di mode "Cost + Tokens"; null di mode lain
  countSecondaryValue,   // nilai mentah pendamping
  countSecondaryFormat,  // pemformat pendamping
  accent = false,    // garis lipatan oranye: menandai lapis yang punya isu
  depth = 0,         // tingkat indentasi; menambah garis lipatan di kiri
  folded = false,    // gambar garis lipatan tipis di atas kepala lapis ini
  defaultOpen = false,
  open: openProp,    // mode terkendali (opsional) — dipakai saat induk perlu tahu
  onOpenChange,
  children,
  actions,           // kontrol tambahan di kepala lapis (mis. tombol saring)
}) {
  // Terkendali kalau induk memberi `open`; kalau tidak, kelola sendiri. Ini
  // memungkinkan halaman membuka lapis secara terprogram (mis. saat pencarian
  // menemukan hasil) tanpa menyerahkan seluruh perilakunya ke induk.
  const [openSelf, setOpenSelf] = useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openSelf;
  // `toggle` selalu dihitung dari nilai SEKARANG, bukan menerima fungsi:
  // meneruskan fungsi ke `onOpenChange` akan memberi induk sebuah callback
  // padahal yang ia butuh nilai boolean.
  const toggle = () => {
    const next = !open;
    if (!controlled) setOpenSelf(next);
    onOpenChange?.(next);
  };
  const panelId = useId();

  return (
    <section
      className="min-w-0"
      style={{ marginLeft: depth > 0 ? `${depth * 14}px` : undefined }}
    >
      {/* Garis lipatan: helai kertas diletakkan di atas helai sebelumnya.
          Digambar di KEPALA tiap lapis dan ikut menjorok bersama indentasi,
          supaya panjangnya sendiri menyatakan kedalaman — bukan sekadar
          pemisah rata yang bisa berarti apa saja. */}
      {folded ? (
        <div className="mb-1 ml-3 border-t border-border-subtle" aria-hidden="true" />
      ) : null}

      <h3 className="m-0">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className={[
            "group flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left",
            "transition-colors duration-150",
            "hover:bg-bg-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
            open ? "bg-bg-subtle" : "bg-transparent",
          ].join(" ")}
        >
          {/* Chevron — berputar, bukan berganti ikon, supaya transisinya halus */}
          <span
            className="material-symbols-outlined shrink-0 text-[18px] text-text-subtle transition-transform"
            style={{
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transitionDuration: `${DURATION}ms`,
              transitionTimingFunction: EASE,
            }}
            aria-hidden="true"
          >
            chevron_right
          </span>

          <span
            className={[
              "shrink-0 text-sm font-semibold tracking-tight",
              accent ? "text-primary" : "text-text-main",
            ].join(" ")}
          >
            {title}
          </span>

          {meta ? (
            <span className="min-w-0 truncate text-xs text-text-muted">{meta}</span>
          ) : null}

          <span className="ml-auto flex shrink-0 items-center gap-2">
            {actions ? (
              // Kontrol di kepala lapis tidak boleh ikut men-toggle lapis saat
              // diklik — hentikan propagasi di sini, sekali, untuk semua.
              <span
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className="flex items-center gap-1"
              >
                {actions}
              </span>
            ) : null}

            {count !== undefined && count !== null ? (
              <span className="flex shrink-0 items-baseline gap-2 text-right">
                {/* Nilai pendamping diletakkan SEBELUM nilai utama supaya angka
                    utama — yang jadi dasar peringkat lapis ini — selalu menempati
                    kolom paling kanan, dan karena itu tidak bergeser saat mode
                    berganti. */}
                {countSecondary ? (
                  countSecondaryValue != null && countSecondaryFormat ? (
                    <AnimatedNumber
                      value={countSecondaryValue}
                      format={countSecondaryFormat}
                      className="text-xs tabular-nums text-text-subtle"
                    />
                  ) : (
                    <span className="text-xs tabular-nums text-text-subtle">{countSecondary}</span>
                  )
                ) : null}
                {countValue != null && countFormat ? (
                  <AnimatedNumber
                    value={countValue}
                    format={countFormat}
                    className="min-w-[4.5rem] text-right text-sm font-medium tabular-nums text-text-main"
                  />
                ) : (
                  <span className="min-w-[4.5rem] text-right text-sm font-medium tabular-nums text-text-main">
                    {count}
                  </span>
                )}
              </span>
            ) : null}
          </span>
        </button>
      </h3>

      {/* Panel: tinggi dianimasikan lewat grid-template-rows supaya tidak perlu
          mengukur tinggi isi di JS. `1fr` → `0fr` adalah satu-satunya cara
          menganimasikan `auto` height tanpa mengukur, dan isinya tetap di DOM
          (penting untuk pencarian lintas-lapis). */}
      <div
        id={panelId}
        className="grid min-w-0"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: `grid-template-rows ${DURATION}ms ${EASE}`,
        }}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="pb-2 pl-[42px] pr-1 pt-1">{children}</div>
        </div>
      </div>
    </section>
  );
}

/**
 * Baris di dalam lapis — satu dimensi (provider/model/akun/endpoint).
 *
 * `bar` menggambar proporsi sebagai garis tipis di bawah label. Sengaja BUKAN
 * progress bar dengan latar penuh: yang dibutuhkan hanya perbandingan panjang
 * antar baris, dan garis tipis melakukannya tanpa menambah massa visual.
 *
 * `value` selalu tercetak di ujung kanan dengan lebar kolom tetap — inilah yang
 * membedakannya dari hiasan: lebarnya boleh bervariasi, angkanya tidak pernah
 * tersembunyi.
 */
export function LayerRow({
  label,
  sublabel,
  value,
  valueRaw,          // nilai mentah; kalau ada, angkanya BERJALAN ke nilai baru
  valueFormat,       // (nilai) → string, pasangan `valueRaw`
  valueSecondary,    // angka kedua di mode "Cost + Tokens"; null di mode lain
  valueSecondaryRaw,
  valueSecondaryFormat,
  detail,            // keterangan panjang di `title` (mis. rincian input/cached/output)
  barValue,          // 0-100; null = tidak ada dasar perhitungan, garis tidak digambar
  onSelect,
  selected = false,
  status,            // "error" | "active" | undefined
  trailing,
}) {
  // Id untuk teks rincian yang hanya dibaca pembaca layar. `useId` memastikan
  // id-nya unik antar baris — dua baris tidak boleh menunjuk elemen yang sama,
  // dan halaman ini bisa punya ratusan baris.
  const detailId = useId();
  const statusColor =
    status === "error"
      ? "var(--color-danger)"
      : status === "active"
        ? "var(--color-success)"
        : null;

  const interactive = typeof onSelect === "function";

  const inner = (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        {statusColor ? (
          <span
            className="size-1.5 shrink-0 translate-y-[-2px] rounded-full"
            style={{ backgroundColor: statusColor }}
            aria-hidden="true"
          />
        ) : null}
        <span className="min-w-0 truncate text-sm text-text-main">{label}</span>
        {sublabel ? (
          <span className="min-w-0 shrink truncate text-xs text-text-subtle">{sublabel}</span>
        ) : null}
      </span>

      {/* Garis proporsi — hanya digambar kalau ada dasar perhitungan. */}
      <span className="relative mt-1.5 block h-[3px] w-full overflow-hidden rounded-full bg-border-subtle">
        {barValue !== null && barValue !== undefined ? (
          <span
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            style={{
              width: `${Math.max(barValue, barValue > 0 ? 1.5 : 0)}%`,
              backgroundColor: status === "error" ? "var(--color-danger)" : "var(--color-primary)",
              transitionTimingFunction: EASE,
            }}
          />
        ) : null}
      </span>

      <span className="ml-auto flex shrink-0 items-baseline gap-2 pl-3">
        {trailing}
        <span className="flex min-w-[4.5rem] items-baseline justify-end gap-2 text-right">
          {/* Pendamping di kiri, nilai utama di kanan — sama seperti di kepala
              lapis, sehingga kolom angka utama tidak pernah berpindah tempat. */}
          {valueSecondary ? (
            valueSecondaryRaw != null && valueSecondaryFormat ? (
              <AnimatedNumber
                value={valueSecondaryRaw}
                format={valueSecondaryFormat}
                className="text-xs tabular-nums text-text-subtle"
              />
            ) : (
              <span className="text-xs tabular-nums text-text-subtle">{valueSecondary}</span>
            )
          ) : null}
          {/* Angka ini bisa difokus KALAU punya rincian.
              Rincian yang hanya hidup di `title` tidak pernah muncul di
              perangkat sentuh dan tidak dijangkau keyboard sama sekali — jadi
              pecahan input/cached/output yang dihitung susah payah akan tidak
              terlihat oleh siapa pun yang tidak memakai mouse. Dengan bisa
              difokus, `title` tetap bekerja untuk mouse sementara pembaca layar
              membaca `aria-describedby`.

              DUA elemen, dan pembagiannya disengaja:
                · pembungkus luar — STABIL, tidak pernah di-remount, memegang
                  fokus dan atribut aksesibilitas.
                · isi dalam — di-remount lewat `key` setiap kali angkanya
                  berubah, supaya animasi fade benar-benar berjalan lagi.
              Kalau `key` dipasang di elemen yang sama dengan pemegang fokus,
              setiap pembaruan SSE akan melepas fokus operator di tengah
              membaca — dan itu justru kerusakan aksesibilitas yang perbaikan
              ini ada untuk mencegah. */}
          <span
            className={[
              "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
              detail
                ? "cursor-help underline decoration-dotted decoration-text-subtle/60 underline-offset-4"
                : "",
            ].join(" ")}
            tabIndex={detail ? 0 : undefined}
            title={detail || undefined}
            aria-describedby={detail ? detailId : undefined}
          >
            {valueRaw != null && valueFormat ? (
              // Angka beranimasi: elemen ini TIDAK di-remount saat nilainya
              // berubah. Remount akan me-reset posisi animasi ke nilai akhir,
              // sehingga justru tidak ada yang bergerak.
              <AnimatedNumber
                value={valueRaw}
                format={valueFormat}
                className="text-sm font-medium tabular-nums text-text-main"
              />
            ) : (
              <span key={String(value)} className="value-fade text-sm font-medium tabular-nums text-text-main">
                {value}
              </span>
            )}
          </span>
          {detail ? (
            <span id={detailId} className="sr-only">
              {detail}
            </span>
          ) : null}
        </span>
      </span>
    </>
  );

  if (!interactive) {
    return (
      <div className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-2">
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left",
        "transition-colors duration-150",
        "hover:bg-bg-hover",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
        selected ? "bg-primary/8 ring-1 ring-inset ring-primary/25" : "",
      ].join(" ")}
    >
      {inner}
    </button>
  );
}
