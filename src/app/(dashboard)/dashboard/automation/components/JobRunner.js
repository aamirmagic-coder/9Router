"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/shared/components";

/**
 * Pemantau pekerjaan latar.
 *
 * ── Mengapa polling, bukan SSE ──────────────────────────────────────────────
 *
 * SSE cocok untuk aliran yang bicara terus-menerus (halaman Usage memakainya
 * untuk statistik hidup). Pekerjaan di sini berbeda: hasilnya bertambah setiap
 * beberapa ratus milidetik, bukan setiap saat, dan jumlahnya bisa ratusan —
 * lebih murah menariknya berkala daripada mendorongnya satu per satu.
 *
 * Yang lebih penting: polling membuat pekerjaan ini tahan refresh. `id` job
 * disimpan di `localStorage`, sehingga memuat ulang halaman MENYAMBUNG kembali
 * ke pekerjaan yang masih berjalan alih-alih kehilangannya. Skrip terminal
 * tidak punya masalah ini karena prosesnya hidup terus; di browser, tab yang
 * ter-refresh adalah kejadian biasa.
 *
 * ── Mengapa polling-nya effect, bukan rantai setTimeout ─────────────────────
 *
 * Versi pertama menjadwalkan dirinya sendiri lewat `setTimeout` rekursif dari
 * dalam `useCallback`, dan itu salah dengan dua cara. Pertama, penjadwalnya
 * harus membawa penanda "generasi" supaya jawaban job lama tidak menimpa job
 * baru — penanda yang harus diurus manual di setiap jalur keluar. Kedua, setiap
 * `setTimeout` yang belum sempat dibersihkan tetap menembak sekali lagi.
 *
 * Dijadwalkan effect yang bergantung pada sasaran, keduanya hilang sendiri:
 * React menjamin cleanup berjalan SEBELUM efek berikutnya, jadi memantau job
 * lain otomatis membatalkan yang lama.
 */
const STORAGE_KEY = "automation:activeJob";

/** Satu tick ditunda ke microtask supaya tidak ada setState di badan effect. */
const defer = (fn) => queueMicrotask(fn);

export function useJob() {
  /**
   * Sasaran yang sedang dipantau: `{ id, seq }`.
   *
   * `seq` ada supaya memantau job yang SAMA dua kali tetap memicu effect baru —
   * tanpa itu, menekan "Cek kuota" dua kali berturut-turut akan menyambung ke
   * tampilan lama yang sudah selesai, bukan memulai yang baru.
   */
  const [target, setTarget] = useState(() => {
    if (typeof window === "undefined") return null;
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { id: saved, seq: 0 } : null;
  });

  const [state, setState] = useState({ status: "idle", results: [], done: 0, total: 0 });
  /** Jumlah hasil yang sudah dimiliki; dikirim sebagai `since`. */
  const seenRef = useRef(0);

  useEffect(() => {
    if (!target?.id) return;

    let cancelled = false;
    let timer = null;
    seenRef.current = 0;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/automation/jobs/${target.id}?since=${seenRef.current}`, {
          cache: "no-store",
        });
        if (cancelled) return;

        if (res.status === 404) {
          // Job sudah dibuang (kedaluwarsa, atau server restart). Berhenti
          // diam-diam dan bersihkan penandanya supaya tidak mencoba selamanya.
          localStorage.removeItem(STORAGE_KEY);
          setState({ status: "idle", results: [], done: 0, total: 0 });
          return;
        }

        const data = await res.json();
        if (cancelled) return;

        seenRef.current = data.nextSince ?? seenRef.current;
        setState((prev) => ({
          ...prev,
          ...data,
          // Hasil DIGABUNG, bukan diganti: server hanya mengirim yang baru.
          results: [...(prev.results || []), ...(data.results || [])],
        }));

        if (data.status === "running") {
          timer = setTimeout(tick, 700);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        // Jaringan putus sesaat: coba lagi selama job belum selesai.
        if (!cancelled) timer = setTimeout(tick, 2000);
      }
    };

    // Ditunda satu microtask: tick memanggil setState, dan memanggilnya
    // langsung di badan effect membuat React melakukan render berantai.
    defer(tick);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [target]);

  /** Mulai memantau sebuah job. Dipanggil dari event handler setelah job dibuat. */
  const watch = useCallback((id, meta = {}) => {
    localStorage.setItem(STORAGE_KEY, id);
    setState({
      id,
      status: "running",
      results: [],
      done: 0,
      total: meta.total ?? 0,
      ok: 0,
      failed: 0,
      kind: meta.kind ?? null,
      label: meta.label ?? "",
    });
    setTarget((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const cancel = useCallback(async () => {
    if (!state.id) return;
    await fetch(`/api/automation/jobs/${state.id}`, { method: "DELETE" }).catch(() => {});
  }, [state.id]);

  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setTarget(null);
    setState({ status: "idle", results: [], done: 0, total: 0 });
  }, []);

  return { ...state, watch, cancel, reset };
}

const KIND_LABEL = {
  quota: "Cek kuota",
  test: "Test koneksi",
  delete: "Hapus akun",
  refresh: "Refresh token",
  verify: "Verifikasi key",
  deactivate: "Nonaktifkan akun",
};

export default function JobRunner({ job }) {
  if (!job || job.status === "idle") return null;

  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const running = job.status === "running";

  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-text-main">
          {KIND_LABEL[job.kind] || job.label || "Memproses"}
          <span className="ml-2 tabular-nums text-text-muted">
            {job.done}/{job.total}
          </span>
        </p>
        {running ? (
          <Button size="sm" variant="ghost" onClick={job.cancel}>
            Hentikan
          </Button>
        ) : (
          <span className="text-xs text-text-muted">
            {job.status === "cancelled" ? "Dihentikan" : "Selesai"}
          </span>
        )}
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Kemajuan"
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="text-xs text-text-muted">
        <span className="text-success">{job.ok} berhasil</span>
        {job.failed > 0 ? (
          <>
            {" · "}
            <span className="text-error">{job.failed} gagal</span>
          </>
        ) : null}
        {job.error ? ` · ${job.error}` : ""}
      </p>
    </div>
  );
}
