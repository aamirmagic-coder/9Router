"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  selectByIndex,
  selectAgGroupDepleted,
  CLINE_CATEGORY_LABEL,
  selectClineByCategory,
  selectExpiredConnections,
  selectInactiveConnections,
  domainBreakdown,
} from "@/lib/automation/filters";

/**
 * Operasi khas per provider — kelanjutan menu skrip terminalnya.
 *
 * ProviderPanel menangani operasi UMUM (cek kuota, tes koneksi, tes prompt,
 * hapus manual, impor, generate TXT). Berkas ini menangani yang KHAS:
 *
 *   antigravity → kuota selektif per nomor (menu 5), hapus 0% per grup
 *                  (menu 7: claude/gemini/both), refresh token,
 *                  hapus nonaktif per domain + dry-run (menu 12)
 *   grok-cli    → kuota selektif, refresh, hapus BLOCKED, hapus by-pattern
 *   cline       → refresh token (menu 6), bersih per kategori
 *                  MATI/LIMIT/ERROR/EXPIRED (menu 5)
 *   bai         → verifikasi key via inferensi (check_key_quota_live)
 *   tokenharbour→ verifikasi key, lihat kedaluwarsa, nonaktifkan/hapus expired
 *   kiro        → refresh token, ringkasan TOTAL POOL KUOTA dari hasil pindaian
 *   semua       → generator TXT pembuat (paste email + 1 password → file)
 *
 * Bagian mana yang tampil diatur `kinds` di katalog — yang tidak didukung
 * providernya tidak dirender sama sekali.
 *
 * Dua hal yang SENGAJA tidak ada di sini (lihat ProviderPanel): login browser
 * pakai `email:password`, dan hapus otomatis saat pemindaian. Setiap hapus di
 * sini memakai daftar pratinjau yang terlihat dulu + konfirmasi.
 *
 * Yang ADA: panel "Tambah akun baru via script" — panduan salin perintah +
 * file email:password. Script-nya jalan di terminal sendiri (bukan di server),
 * dan akun yang dipanen langsung muncul di menu ini karena DB-nya sama.
 */
export default function ProviderOps({
  providerId,
  info,
  rows = [],
  visible = [],
  scanResults = [],
  running,
  runOp,
  onDelete,
  onChanged,
}) {
  const kinds = info?.kinds || {};
  const hasOps =
    kinds.selective || kinds.refresh || kinds.verify || kinds.cleanup ||
    kinds.patternDelete || kinds.blocked || kinds.expiryOps || kinds.inactive ||
    kinds.deviceBulk || info?.script ||
    providerId === "antigravity" || providerId === "kiro";

  if (!hasOps) return null;

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
        Operasi {info?.label || providerId}
      </h3>

      {info?.script ? <ScriptGuide info={info} /> : null}

      {kinds.deviceBulk ? (
        <DeviceBulk providerId={providerId} onChanged={onChanged} />
      ) : null}

      {kinds.selective ? (
        <SelectiveOps rows={visible.length ? visible : rows} running={running} runOp={runOp} />
      ) : null}

      {providerId === "antigravity" ? (
        <AgGroupDelete scanResults={scanResults} running={running} onDelete={onDelete} />
      ) : null}

      {providerId === "kiro" ? <KiroPool scanResults={scanResults} /> : null}

      {kinds.refresh ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="autorenew"
            disabled={running || !rows?.length}
            onClick={() => runOp("refresh").then((d) => d && onChanged?.())}
            title="Perbarui access token semua akun provider ini tanpa login ulang (menu 6 skrip cline)"
          >
            Refresh token
          </Button>
          <span className="text-[11px] text-text-subtle">Tanpa login ulang; token mati dilaporkan per akun.</span>
        </div>
      ) : null}

      {kinds.verify ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="verified"
            disabled={running || !rows?.length}
            onClick={() => runOp("verify")}
            title="Uji setiap key dengan inferensi nyata — 401/402/429 dibedakan (check_key_quota_live)"
          >
            Verifikasi key
          </Button>
          <span className="text-[11px] text-text-subtle">Inferensi nyata per key: valid / ditolak / habis / laju.</span>
        </div>
      ) : null}

      {kinds.cleanup ? <ClineCleanup rows={rows} running={running} onDelete={onDelete} /> : null}

      {kinds.blocked ? <BlockedRow rows={rows} running={running} onDelete={onDelete} /> : null}

      {kinds.patternDelete ? (
        <PatternDelete rows={visible.length ? visible : rows} running={running} onDelete={onDelete} />
      ) : null}

      {kinds.expiryOps ? (
        <ExpiryOps rows={rows} running={running} runOp={runOp} onDelete={onDelete} onChanged={onChanged} />
      ) : null}

      {kinds.inactive ? <InactiveOps rows={rows} running={running} onDelete={onDelete} /> : null}

      <TxtBuilder providerId={providerId} accountsFile={info?.script?.accountsFile} />
    </div>
  );
}

/**
 * Panduan "tambah akun baru via script".
 *
 * Cara kerjanya SAMA di semua provider: salin perintah + siapkan berkas
 * `email:password` → jalankan script Python di terminal sendiri → script
 * membuka browser dan login otomatis → token masuk DB 9Router yang sama →
 * akun langsung muncul di menu ini setelah tekan "Muat ulang".
 *
 * Password TIDAK PERNAH menyentuh server: berkas dibuat oleh TxtBuilder di
 * browser, dan script jalan di mesin operator. Yang ditampilkan di sini hanya
 * perintah siap-salin dari katalog (ditulis dari argparse tiap script).
 */
function ScriptGuide({ info }) {
  const s = info?.script;
  const [reloaded, setReloaded] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  if (!s) return null;

  return (
    <details className="rounded-[10px] border border-border-subtle bg-bg-subtle/50" open>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-main">
        Tambah akun baru via script — salin perintah, jalan lokal
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[11px] text-text-muted">
          <li>
            Buat berkas <code className="font-mono text-text-main">{s.accountsFile}</code> di bawah
            (paste email + 1 password → Unduh) — bentuk <code className="font-mono text-text-main">{s.format}</code>.
          </li>
          <li>
            Jalankan di terminal, di folder scriptnya
            (<code className="font-mono text-text-main">C:\Users\Developer\cliproxyapi</code>):
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5">
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-main">{s.command}</code>
          <button
            type="button"
            onClick={() => copy(s.command, "script-cmd")}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
              {copied === "script-cmd" ? "check" : "content_copy"}
            </span>
            {copied === "script-cmd" ? "Tersalin" : "Salin"}
          </button>
        </div>
        {s.extra ? (
          <p className="text-[11px] text-text-subtle">Flag berguna: <code className="font-mono">{s.extra}</code></p>
        ) : null}
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[11px] text-text-muted" start={3}>
          <li>
            Script membuka browser dan login otomatis per akun. Setelah selesai, tekan Muat ulang —
            akun yang dipanen langsung muncul di tabel bawah (DB-nya sama, tanpa impor ulang).
          </li>
        </ol>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => {
              window.location.reload();
              setReloaded(true);
            }}
          >
            {reloaded ? "Memuat…" : "Muat ulang"}
          </Button>
        </div>
      </div>
    </details>
  );
}

/**
 * Antrean device-flow bulk (grok-cli, kilocode, kiro).
 *
 * Sepenuhnya via web, tanpa password: minta kode → operator menyetujui di
 * browser sendiri → token tersimpan → otomatis lanjut ke akun berikutnya.
 * Memakai endpoint yang sama dengan tab "Login device" (`device/start` +
 * `device/poll`), dibungkus antrean sekuensial. Sekuensial itu disengaja:
 * upstream device-code membatasi permintaan pending paralel (kilo menjawab
 * 429 + "Too many pending"), dan dua kode di layar bersamaan membuat
 * operator menyetujui yang salah.
 *
 * Menutup tab/berganti tab menghentikan antrean di titik terakhir — yang
 * sudah tersimpan tidak hilang, yang belum tinggal dimulai lagi.
 */
function DeviceBulk({ providerId, onChanged }) {
  const [total, setTotal] = useState(3);
  const [phase, setPhase] = useState("idle"); // idle | waiting | done
  const [flow, setFlow] = useState(null);
  const [done, setDone] = useState([]);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // Generasi sesi: "Lewati" menaikkan generasi sehingga polling lama
  // diabaikan saat jawabannya tiba — tanpa ini, jawaban sesi yang dilewati
  // bisa tercatat sebagai akun yang tersimpan.
  const genRef = useRef(0);
  const stopRef = useRef(false);
  const pollTimer = useRef(null);
  const { copied, copy } = useCopyToClipboard();

  const current = done.length + skipped + 1;

  useEffect(() => () => {
    stopRef.current = true;
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  useEffect(() => {
    if (phase !== "waiting") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const requestCode = async () => {
    const res = await fetch("/api/automation/device/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    const url = data.verificationUriComplete || data.verificationUri;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    return {
      deviceCode: data.deviceCode,
      codeVerifier: data.codeVerifier,
      extraData: data.extraData,
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      interval: data.interval || 5,
      deadline: Date.now() + (data.expiresIn ? data.expiresIn * 1000 : 15 * 60 * 1000),
    };
  };

  // Satu langkah antrean: minta kode generasi ini, tampilkan, poll sampai
  // sukses dilewati/dihentikan. Mengembalikan "ok" | "skipped" | "stopped".
  const runStep = (gen, target) =>
    new Promise((resolve) => {
      let session = null;
      const finish = (v) => {
        if (pollTimer.current) clearTimeout(pollTimer.current);
        resolve(v);
      };
      const tick = async () => {
        if (stopRef.current || genRef.current !== gen) return finish("stopped");
        // Langkah "Lewati" ditandai lewat generasi juga — polling ini milik
        // generasi lama, jadi berhenti sendiri.
        if (!session) {
          try {
            session = await requestCode();
          } catch (e) {
            if (genRef.current !== gen || stopRef.current) return finish("stopped");
            setError(e?.message || "Gagal meminta kode");
            return finish("stopped");
          }
          if (genRef.current !== gen || stopRef.current) return finish("stopped");
          setFlow({ ...session, index: target });
          setError("");
        }
        let data = {};
        try {
          const res = await fetch("/api/automation/device/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: providerId,
              deviceCode: session.deviceCode,
              codeVerifier: session.codeVerifier,
              extraData: session.extraData,
            }),
          });
          data = await res.json().catch(() => ({}));
        } catch {
          if (genRef.current !== gen || stopRef.current) return finish("stopped");
          pollTimer.current = setTimeout(tick, 5000);
          return;
        }
        if (genRef.current !== gen || stopRef.current) return finish("stopped");
        if (data.success) {
          setDone((d) => [...d, data.connection]);
          onChanged?.();
          return finish("ok");
        }
        if (data.pending) {
          if (Date.now() > session.deadline) {
            setError("Waktu habis — kode kedaluwarsa. Antrean berhenti di sini.");
            return finish("stopped");
          }
          pollTimer.current = setTimeout(tick, (session.interval || 5) * 1000);
          return;
        }
        setError(data.errorDescription || data.error || "Gagal menukar token");
        return finish("stopped");
      };
      tick();
    });

  const start = async () => {
    const n = Math.max(1, Math.min(50, Number(total) || 1));
    const gen = genRef.current + 1;
    genRef.current = gen;
    stopRef.current = false;
    setDone([]);
    setSkipped(0);
    setError("");
    setFlow(null);
    setPhase("waiting");
    for (let i = 0; i < n; i++) {
      const r = await runStep(gen, i + 1);
      if (r !== "ok") break;
    }
    setFlow(null);
    setPhase("done");
  };

  const stop = () => {
    stopRef.current = true;
    genRef.current += 1;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setFlow(null);
    setPhase("done");
  };

  const skip = () => {
    // Naikkan generasi: polling sesi ini diabaikan saat jawabannya tiba,
    // dan langkah berikutnya dimulai dengan kode baru.
    genRef.current += 1;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setSkipped((s) => s + 1);
    setFlow(null);
    setError("");
    void (async () => {
      const gen = genRef.current;
      // Sisa target dihitung dari yang sudah selesai + dilewati.
      const target = done.length + skipped + 1;
      const r = await runStep(gen, target);
      if (r !== "ok") {
        setFlow(null);
        setPhase("done");
      }
    })();
  };

  const busy = phase === "waiting";
  const remain = flow?.deadline ? Math.max(0, Math.floor((flow.deadline - now) / 1000)) : 0;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Tambah bulk via device
        <span className="ml-2 font-normal text-text-subtle">sepenuhnya via web — kamu yang menyetujui di browser</span>
      </p>

      {phase === "idle" || phase === "done" ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="w-32">
            <Input label="Jumlah akun" type="number" value={total} onChange={(e) => setTotal(e.target.value)} disabled={busy} />
          </div>
          <Button size="sm" variant="secondary" icon="login" disabled={busy} onClick={start}>
            Mulai antrean
          </Button>
          {done.length > 0 || skipped > 0 ? (
            <span className="pb-2 text-[11px] tabular-nums text-text-muted">
              Terakhir: {done.length} tersimpan{skipped ? `, ${skipped} dilewati` : ""}.
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? <p role="alert" className="text-[11px] font-medium text-error">{error}</p> : null}

      {busy && flow ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          <p className="text-[11px] tabular-nums text-text-muted">
            Akun {flow.index || current} — setujui di browser, lalu otomatis lanjut.
            {remain > 0 ? ` Kode kedaluwarsa dalam ${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}.` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-lg bg-bg-subtle px-3 py-1.5 font-mono text-base font-semibold tracking-wider text-text-main">
              {flow.userCode || "—"}
            </code>
            <button
              type="button"
              onClick={() => copy(flow.userCode || "", "bulk-code")}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                {copied === "bulk-code" ? "check" : "content_copy"}
              </span>
              {copied === "bulk-code" ? "Tersalin" : "Salin"}
            </button>
            {flow.verificationUri ? (
              <a
                href={flow.verificationUriComplete || flow.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline decoration-dotted underline-offset-2"
              >
                Buka verifikasi
              </a>
            ) : null}
          </div>
          <p className="flex items-center gap-2 text-[11px] text-text-muted">
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            Menunggu persetujuan… (tab verifikasi sudah dibuka otomatis)
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={skip}>Lewati akun ini</Button>
            <Button size="sm" variant="ghost" onClick={stop}>Hentikan antrean</Button>
          </div>
        </div>
      ) : null}

      {phase === "done" && !busy ? (
        <p className="rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-xs font-medium text-success">
          Selesai: {done.length} akun tersimpan{skipped ? `, ${skipped} dilewati` : ""}. Tabel di bawah sudah dimuat ulang.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Pilih akun per nomor ala skrip `ag` menu 5: "50", "1,5,12", "1-10", "all".
 * Urutannya = urutan baris yang terlihat di layar (1-based seperti skrip).
 */
function SelectiveOps({ rows, running, runOp }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const picked = useMemo(() => {
    if (!text.trim()) return null;
    return selectByIndex(rows, text);
  }, [rows, text]);

  const run = (op) => {
    setError("");
    if (!text.trim()) {
      setError("Isi dulu nomornya — kosong berarti semua (pakai tombol di atas).");
      return;
    }
    const ids = (picked || []).map((r) => r.id);
    if (!ids.length) {
      setError("Tidak ada nomor valid yang cocok.");
      return;
    }
    runOp(op, { ids });
  };

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Cek akun tertentu
        <span className="ml-2 font-normal text-text-subtle">menu 5 skrip: nomor, koma, rentang, atau all</span>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="mis. 50 · 1, 5, 12 · 1-10 · all" disabled={running} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={running || !rows?.length} onClick={() => run("quota")}>
            Kuota pilihan
          </Button>
          <Button size="sm" variant="secondary" disabled={running || !rows?.length} onClick={() => run("test")}>
            Tes pilihan
          </Button>
        </div>
      </div>
      {picked ? (
        <p className="text-[11px] tabular-nums text-text-muted">{picked.length} dari {rows.length} akun cocok.</p>
      ) : null}
      {error ? <p role="alert" className="text-[11px] font-medium text-error">{error}</p> : null}
    </div>
  );
}

/**
 * Hapus 0% per grup untuk Antigravity (menu 7 skrip `ag`).
 *
 * Dibaca dari HASIL pemindaian kuota terakhir (state job), bukan dari
 * pemindaian baru — operator melihat angkanya dulu, baru memutuskan.
 * Ambang `< 1` sama seperti skrip, tapi grup yang tidak terbaca (`null`)
 * tidak pernah lolos (bug sentinel skrip tidak ditiru).
 */
const AG_MODES = [
  { value: "claude", label: "Claude & GPT 0%" },
  { value: "gemini", label: "Gemini 0%" },
  { value: "both", label: "Keduanya 0%" },
];

function AgGroupDelete({ scanResults, running, onDelete }) {
  const [mode, setMode] = useState("both");
  const cands = useMemo(() => selectAgGroupDepleted(scanResults, mode), [scanResults, mode]);
  if (!scanResults?.length) return null;
  const modeLabel = AG_MODES.find((m) => m.value === mode)?.label || mode;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Hapus kuota 0% per grup
        <span className="ml-2 font-normal text-text-subtle">menu 7 skrip ag — dari hasil pindaian terakhir</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label="Kriteria grup">
          {AG_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              aria-pressed={mode === m.value}
              className={`h-7 shrink-0 rounded-[8px] px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                mode === m.value ? "bg-primary-strong text-white" : "bg-surface-2 text-text-muted hover:text-text-main"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running || !cands.length}
          onClick={() => {
            if (!confirm(`Hapus permanen ${cands.length} akun (${modeLabel})?`)) return;
            onDelete(cands.map((c) => c.id));
          }}
        >
          Hapus {cands.length} akun
        </Button>
      </div>
    </div>
  );
}

/**
 * Ringkasan TOTAL POOL KUOTA Kiro dari hasil pindaian (kolom agregat skrip).
 *
 * `pool` dihitung per akun oleh classifyUsage (jumlah used/total semua baris
 * AGENTIC_REQUEST); di sini dijumlahkan lintas akun.
 */
function KiroPool({ scanResults }) {
  const pool = useMemo(() => {
    const rows = (scanResults || []).filter((r) => r?.pool && Number.isFinite(r.pool.total) && r.pool.total > 0);
    if (!rows.length) return null;
    const used = rows.reduce((s, r) => s + r.pool.used, 0);
    const total = rows.reduce((s, r) => s + r.pool.total, 0);
    return { used, total, remaining: Math.max(0, total - used), accounts: rows.length };
  }, [scanResults]);
  if (!pool) return null;

  const pct = pool.total > 0 ? Math.round((pool.remaining / pool.total) * 100) : 0;
  return (
    <p className="rounded-[10px] border border-border-subtle bg-bg-subtle/50 px-3 py-2 text-xs tabular-nums text-text-main">
      Total pool kuota: <strong>{pool.remaining.toLocaleString("en-US")}</strong> / {pool.total.toLocaleString("en-US")} tersisa
      <span className="ml-2 text-text-muted">({pct}% · {pool.accounts} akun terbaca)</span>
    </p>
  );
}

/** Bersih per kategori ala skrip `cline` menu 5: MATI / LIMIT / ERROR / EXPIRED. */
const CLINE_CATS = ["mati", "limit", "error", "expired"];

function ClineCleanup({ rows, running, onDelete }) {
  const [cat, setCat] = useState("mati");
  const cands = useMemo(() => selectClineByCategory(rows, cat), [rows, cat]);

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Bersihkan per kategori
        <span className="ml-2 font-normal text-text-subtle">menu 5 skrip cline — dibaca dari daftar akun</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Kategori cline">
          {CLINE_CATS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              aria-pressed={cat === c}
              className={`h-7 shrink-0 rounded-[8px] px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                cat === c ? "bg-primary-strong text-white" : "bg-surface-2 text-text-muted hover:text-text-main"
              }`}
            >
              {CLINE_CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running || !cands.length}
          onClick={() => {
            if (!confirm(`Hapus permanen ${cands.length} akun kategori ${CLINE_CATEGORY_LABEL[cat]}?`)) return;
            onDelete(cands.map((c) => c.id));
          }}
        >
          Hapus {cands.length} akun
        </Button>
      </div>
    </div>
  );
}

/**
 * Hapus akun BLOCKED / tim diblokir ala skrip `grok` menu 6.
 *
 * `team_blocked` dikenali dari `lastError`: pola `spending-limit`,
 * `personal-team-blocked`, atau kata "blocked" — sumber yang sama dengan
 * yang dibaca skrip dari billing xAI. Akun 402-kuota-habis (depleted) ikut,
 * karena di Grok keduanya berarti "tidak bisa belanja".
 */
function BlockedRow({ rows, running, onDelete }) {
  const cands = useMemo(
    () =>
      (rows || []).filter((c) => {
        const raw = String(c.lastError || "").toLowerCase();
        const blocked = /spending.?limit|personal-team-blocked|team.?blocked|\bblocked\b/.test(raw);
        return blocked || c.errorState === "depleted";
      }),
    [rows],
  );
  if (!cands.length) return null;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Hapus akun BLOCKED
        <span className="ml-2 font-normal text-text-subtle">menu 6 skrip grok — tim diblokir / spending-limit / kuota habis</span>
      </p>
      <div>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running}
          onClick={() => {
            if (!confirm(`Hapus permanen ${cands.length} akun BLOCKED?`)) return;
            onDelete(cands.map((c) => c.id));
          }}
        >
          Hapus {cands.length} akun
        </Button>
      </div>
    </div>
  );
}

/**
 * Hapus massal by-pattern ala skrip `grok` menu 8: pratinjau 10 pertama +
 * konfirmasi. Polanya substring case-insensitive pada email/nama.
 */
function PatternDelete({ rows, running, onDelete }) {
  const [text, setText] = useState("");

  const matched = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return null;
    return (rows || []).filter((c) =>
      [c.email, c.name, c.id].some((v) => String(v || "").toLowerCase().includes(q)),
    );
  }, [rows, text]);

  if (!rows?.length) return null;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Hapus by-pattern
        <span className="ml-2 font-normal text-text-subtle">menu 8 skrip grok — substring email/nama</span>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="mis. @gmaoiil.com" disabled={running} />
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running || !matched?.length}
          onClick={() => {
            if (!matched?.length) return;
            if (!confirm(`Hapus permanen ${matched.length} akun yang cocok "${text.trim()}"?`)) return;
            onDelete(matched.map((c) => c.id));
            setText("");
          }}
        >
          Hapus{matched?.length ? ` ${matched.length}` : ""} akun
        </Button>
      </div>
      {matched ? (
        <div className="text-[11px] text-text-muted">
          <p className="tabular-nums">{matched.length} cocok.</p>
          {matched.slice(0, 10).map((c) => (
            <p key={c.id} className="truncate font-mono">{c.email || c.name || c.id}</p>
          ))}
          {matched.length > 10 ? <p>…dan {matched.length - 10} lainnya.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Operasi kedaluwarsa TokenHarbor (menu 5-6 skrip: `--view-expiring`,
 * `--cleanup`, `--delete-expired`).
 *
 * "Lihat" hanya menyaring (dry-run); "Nonaktifkan" mengikuti perilaku default
 * skrip (UPDATE isActive=0, baris tetap ada); "Hapus" = `--delete-expired`.
 * `hoursAhead` = `--view-expiring N` (akun yang kedaluwarsa dalam N jam ke depan
 * ikut tampil).
 */
function fmtRemaining(ms) {
  if (ms <= 0) return "kedaluwarsa";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m lagi`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}j lagi`;
  return `${Math.floor(h / 24)}h lagi`;
}

function ExpiryOps({ rows, running, runOp, onDelete, onChanged }) {
  const [hoursAhead, setHoursAhead] = useState(0);
  const expired = useMemo(
    () => selectExpiredConnections(rows, { hoursAhead: Number(hoursAhead) || 0 }),
    [rows, hoursAhead],
  );

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Kedaluwarsa
        <span className="ml-2 font-normal text-text-subtle">menu 5-6 skrip tokenharbor — gagal parse = permanen</span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-32">
          <Input label="Lihat N jam ke depan" type="number" value={hoursAhead} onChange={(e) => setHoursAhead(e.target.value)} disabled={running} />
        </div>
        <span className="pb-2 text-[11px] tabular-nums text-text-muted">
          {expired.length} akun{Number(hoursAhead) > 0 ? ` (kedaluwarsa + ${hoursAhead}j ke depan)` : " kedaluwarsa"}.
        </span>
      </div>
      {expired.length > 0 ? (
        <>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {expired.slice(0, 20).map((c) => (
              <li key={c.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate font-mono text-text-main">{c.email || c.name || c.id}</span>
                <span className="shrink-0 tabular-nums text-text-muted">{fmtRemaining(c.remainingMs)}</span>
              </li>
            ))}
            {expired.length > 20 ? (
              <li className="text-[11px] text-text-subtle">…dan {expired.length - 20} lainnya.</li>
            ) : null}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon="pause_circle"
              disabled={running}
              onClick={() =>
                runOp("deactivate", { ids: expired.map((c) => c.id) }).then((d) => d && onChanged?.())
              }
              title="UPDATE isActive=0 — perilaku default skrip; baris tetap ada dan bisa diaktifkan lagi"
            >
              Nonaktifkan {expired.length}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="delete_sweep"
              disabled={running}
              onClick={() => {
                if (!confirm(`Hapus permanen ${expired.length} akun kedaluwarsa?`)) return;
                onDelete(expired.map((c) => c.id));
              }}
              title="Hapus baris permanen — --delete-expired di skrip"
            >
              Hapus {expired.length}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Hapus akun nonaktif ala skrip `ag` menu 12: sebaran domain + dry-run.
 *
 * Dry-run = pratinjau klasifikasi tanpa menghapus (`--inactive-dry-run`).
 * Fail-safe: hanya `isActive === false` yang dianggap nonaktif.
 */
function InactiveOps({ rows, running, onDelete }) {
  const [showDomains, setShowDomains] = useState(false);
  const inactive = useMemo(() => selectInactiveConnections(rows), [rows]);
  const domains = useMemo(() => (showDomains ? domainBreakdown(rows) : []), [showDomains, rows]);

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Akun nonaktif
        <span className="ml-2 font-normal text-text-subtle">menu 12 skrip ag — dry-run dulu, hapus sesudahnya</span>
      </p>
      <p className="text-[11px] tabular-nums text-text-muted">
        {inactive.length} nonaktif dari {rows?.length || 0} akun. Alasan per akun terlihat di bawah.
      </p>
      {inactive.length > 0 ? (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {inactive.slice(0, 20).map((c) => (
            <li key={c.id} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate font-mono text-text-main">{c.email || c.name || c.id}</span>
              <span className="shrink-0 font-mono text-text-subtle">{c.inactiveReason}</span>
            </li>
          ))}
          {inactive.length > 20 ? (
            <li className="text-[11px] text-text-subtle">…dan {inactive.length - 20} lainnya.</li>
          ) : null}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setShowDomains((v) => !v)} aria-expanded={showDomains}>
          {showDomains ? "Sembunyikan" : "Sebaran domain"}
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running || !inactive.length}
          onClick={() => {
            if (!confirm(`Hapus permanen ${inactive.length} akun nonaktif?`)) return;
            onDelete(inactive.map((c) => c.id));
          }}
        >
          Hapus {inactive.length} nonaktif
        </Button>
      </div>
      {showDomains ? (
        <ul className="flex flex-col gap-1">
          {domains.map((d) => (
            <li key={d.domain} className="flex items-baseline justify-between gap-2 text-[11px] tabular-nums">
              <span className="min-w-0 truncate font-mono text-text-main">{d.domain}</span>
              <span className="shrink-0 text-text-muted">
                {d.total} akun · {d.active} aktif{d.dead ? " · domain mati total" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Generator TXT pembuat (menu 10 skrip `ag`, menu 9 `grok`, menu 8 `kiro`/`bai`):
 * paste email + satu password seragam → unduh berkas akun.
 *
 * Murni client-side: tidak ada kredensial yang dikirim ke server, tidak ada
 * login. Nama berkas + pemisah mengikuti katalog (`script.accountsFile`,
 * format tiap script) supaya berkasnya langsung bisa dipakai perintah di
 * ScriptGuide tanpa diganti nama.
 */
function TxtBuilder({ providerId, accountsFile }) {
  const [emails, setEmails] = useState("");
  const [password, setPassword] = useState("");

  // Pemisah per provider: skrip cline/kiro/bai menerima `|`, sisanya `:`.
  // Default `:` karena semua skrip memakannya.
  const sep = providerId === "cline" || providerId === "kiro" || providerId === "bai" ? "|" : ":";

  const lines = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const raw of emails.split("\n")) {
      const e = raw.trim();
      if (!e || !e.includes("@")) continue;
      const k = e.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(`${e}${sep}${password}`);
    }
    return out;
  }, [emails, password, sep]);

  const download = () => {
    if (!lines.length || !password) return;
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain; charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = accountsFile || `accounts_${providerId || "bulk"}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <details className="rounded-[10px] border border-border-subtle bg-bg-subtle/50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-main">
        Buat berkas akun — paste email + 1 password
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <p className="text-[11px] text-text-muted">
          Keluaran <code className="font-mono">email{sep}password</code> per baris →{" "}
          <code className="font-mono">{accountsFile || `accounts_${providerId || "bulk"}.txt`}</code> —
          bentuk yang dimakan skrip tambah-akun. Tidak dikirim ke mana pun; berkas dibuat di browser.
        </p>
        <textarea
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          spellCheck={false}
          aria-label="Daftar email, satu per baris"
          placeholder={"satu email per baris\nbaris tanpa @ dilewati, duplikat dibuang"}
          className="min-h-[80px] w-full resize-y rounded-lg border border-border bg-surface p-2 font-mono text-xs text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        />
        <Input label="Satu password untuk semua" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password seragam" />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon="description" disabled={!lines.length || !password} onClick={download}>
            Unduh {lines.length} baris
          </Button>
        </div>
      </div>
    </details>
  );
}
