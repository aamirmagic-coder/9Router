"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button, Input } from "@/shared/components";
import JobRunner, { useJob } from "./JobRunner";
import TestPrompt from "./TestPrompt";
import ProviderOps from "./ProviderOps";

/**
 * Menu fitur untuk SATU provider.
 *
 * Isinya mengikuti apa yang benar-benar dimiliki skrip provider itu, dan yang
 * tidak dimiliki tidak ditawarkan. Perbedaan antar provider bukan kelalaian —
 * `quota` misalnya hanya muncul untuk provider yang benar-benar punya handler
 * kuota di 9Router (`antigravity`, `grok-cli`, `freebuff`); menawarkannya untuk
 * `b.ai` akan menghasilkan tombol yang selalu menjawab "belum ada".
 *
 * Satu hal yang sengaja TIDAK ada di menu mana pun: "Tambah akun" dengan
 * format `email:password`. Di skrip aslinya itu berarti membuka browser dan
 * login ke Google memakai kredensial tadi — mesin yang sama dengan credential
 * stuffing, dan tidak dibangun di sini. Yang tersedia: impor kredensial yang
 * sudah dimiliki, dan login device (khusus freebuff).
 */
const FILTERS = [
  { value: "all", label: "Semua" },
  { value: "active", label: "Aktif" },
  { value: "problem", label: "Bermasalah" },
];

export default function ProviderPanel({ providerId, onBack }) {
  const [info, setInfo] = useState(null);
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(() => new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [promptFor, setPromptFor] = useState(null);
  const job = useJob();

  const load = useCallback(async () => {
    const [ovRes, connRes] = await Promise.all([
      fetch("/api/automation/overview", { cache: "no-store" }),
      fetch(`/api/automation/connections?provider=${encodeURIComponent(providerId)}&catalogueId=${encodeURIComponent(providerId)}`, { cache: "no-store" }),
    ]);
    if (!ovRes.ok) throw new Error(`HTTP ${ovRes.status}`);
    if (!connRes.ok) throw new Error(`HTTP ${connRes.status}`);
    const ov = await ovRes.json();
    const conn = await connRes.json();
    setInfo(ov.providers?.find((p) => p.id === providerId) || null);
    setRows(conn.connections || []);
  }, [providerId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(async () => {
      if (cancelled) return;
      setError("");
      try {
        await load();
      } catch (e) {
        if (!cancelled) setError(e.message || "Gagal memuat akun");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load, reloadKey]);

  /** Hasil pemindaian terakhir, dibaca dari job — bukan disalin ke state. */
  const scan = useMemo(() => {
    const map = {};
    for (const r of job.results || []) if (r?.id) map[r.id] = r;
    return map;
  }, [job.results]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((c) => {
      if (q && ![c.email, c.name, c.id].some((v) => String(v || "").toLowerCase().includes(q))) {
        return false;
      }
      const s = scan[c.id];
      if (filter === "active") return c.status === "active";
      if (filter === "problem") {
        const badQuota = s && ["depleted", "critical", "low"].includes(s.state);
        return badQuota || c.errorState === "invalid" || c.errorState === "depleted" || c.status === "cooling";
      }
      return true;
    });
  }, [rows, query, filter, scan]);

  const runOp = async (op, payload = {}) => {
    setError("");
    setNotice("");
    const res = await fetch("/api/automation/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, provider: providerId, ...payload }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d?.error || `HTTP ${res.status}`);
      return null;
    }
    if (d.jobId) job.watch(d.jobId, { total: d.total, kind: op });
    return d;
  };

  const doDelete = async (ids) => {
    if (!ids.length) return;
    const d = await runOp("delete", { ids, reason: "manual" });
    if (d) {
      setSelected(new Set());
      setReloadKey((n) => n + 1);
    }
  };

  const kandidat = useMemo(() => {
    if (!rows) return [];
    return rows
      .map((c) => ({ ...c, ...(scan[c.id] || {}) }))
      .filter((c) => c.state === "depleted" || c.errorState === "invalid" || c.errorState === "depleted");
  }, [rows, scan]);

  const running = job.status === "running";

  if (error && !rows) {
    return (
      <div className="flex flex-col gap-3">
        <Button size="sm" variant="ghost" icon="arrow_back" onClick={onBack}>
          Kembali
        </Button>
        <p role="alert" className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs font-medium text-error">
          {error}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Kepala */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label="Kembali ke daftar provider"
            className="mt-0.5 rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              arrow_back
            </span>
          </button>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-main">
              {info?.label || providerId}
              <span className="ml-2 font-normal tabular-nums text-text-muted">
                {rows?.length ?? 0} akun
              </span>
            </h2>
            {info?.note ? <p className="mt-0.5 text-xs text-text-muted">{info.note}</p> : null}
          </div>
        </div>
      </div>

      {notice ? (
        <p className="rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-xs font-medium text-success">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs font-medium text-error">
          {error}
        </p>
      ) : null}

      {/* Aksi provider */}
      <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          {info?.kinds.quota ? (
            <Button size="sm" variant="secondary" icon="data_usage" disabled={running || !rows?.length} onClick={() => runOp("quota")}>
              Cek kuota
            </Button>
          ) : null}
          {info?.kinds.test ? (
            <Button size="sm" variant="secondary" icon="network_check" disabled={running || !rows?.length} onClick={() => runOp("test")}>
              Tes koneksi
            </Button>
          ) : null}
          {info?.kinds.prompt ? (
            <Button
              size="sm"
              variant="secondary"
              icon="chat"
              disabled={!rows?.length}
              onClick={() => setPromptFor(visible[0] || rows[0])}
            >
              Tes prompt
            </Button>
          ) : null}
          {info?.kinds.calls === "device" ? (
            <Button size="sm" variant="secondary" icon="login" onClick={() => { onBack(); }} title="Login device ada di tab Tambah via OAuth">
              Login device
            </Button>
          ) : null}

          <a
            href={`/api/automation/generate-txt?provider=${encodeURIComponent(providerId)}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-border px-3 text-xs font-semibold text-text-main transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
              description
            </span>
            Generate TXT
          </a>

          {selected.size > 0 ? (
            <>
              <span className="text-xs text-text-muted">{selected.size} dipilih</span>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Batal
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="delete"
                disabled={running}
                onClick={() => {
                  if (!confirm(`Hapus permanen ${selected.size} akun? Tidak bisa dibatalkan.`)) return;
                  doDelete([...selected]);
                }}
              >
                Hapus
              </Button>
            </>
          ) : null}
        </div>

        {/* Unggah berkas kredensial — bentuknya sesuai provider, dan itulah
            yang dibaca skrip aslinya. */}
        <ImportRow providerId={providerId} info={info} onDone={(msg) => { setNotice(msg); setReloadKey((n) => n + 1); }} />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input label="Cari" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="email, nama, atau id" />
          </div>
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                aria-pressed={filter === f.value}
                className={`h-9 shrink-0 rounded-[10px] px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                  filter === f.value ? "bg-primary-strong text-white" : "bg-surface-2 text-text-muted hover:text-text-main"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Operasi khas provider ala skrip terminalnya (kuota selektif, hapus
          per grup/kategori, refresh, expiry, nonaktif, generator TXT). */}
      <ProviderOps
        providerId={providerId}
        info={info}
        rows={rows || []}
        visible={visible}
        scanResults={job.results || []}
        running={running}
        runOp={runOp}
        onDelete={doDelete}
        onChanged={() => setReloadKey((n) => n + 1)}
      />

      {job.status !== "idle" ? <JobRunner job={job} /> : null}

      {!running && kandidat.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-[14px] border border-warning/30 bg-warning/10 p-4">
          <p className="text-sm font-medium text-text-main">
            {kandidat.length} akun layak dipertimbangkan untuk dihapus
          </p>
          <p className="text-xs text-text-muted">
            Kuota habis atau kredensial ditolak provider. Kesalahan jaringan, laju, dan prompt
            kepanjangan sengaja TIDAK masuk daftar ini.
          </p>
          <div>
            <Button
              size="sm"
              variant="danger"
              icon="delete_sweep"
              onClick={() => {
                if (!confirm(`Hapus permanen ${kandidat.length} akun?`)) return;
                doDelete(kandidat.map((c) => c.id));
              }}
            >
              Hapus {kandidat.length} akun
            </Button>
          </div>
        </div>
      ) : null}

      {/* Tabel akun */}
      <div className="overflow-x-auto rounded-[14px] border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Akun {info?.label || providerId}</caption>
          <thead className="bg-bg-subtle text-[10px] uppercase tracking-wide text-text-muted">
            <tr>
              <th scope="col" className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Pilih semua yang terlihat"
                  checked={visible.length > 0 && selected.size >= visible.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((c) => c.id)) : new Set())}
                  className="size-3.5 accent-[var(--color-primary)]"
                />
              </th>
              <th scope="col" className="px-3 py-2 font-medium">Akun</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Kuota</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows === null ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-text-muted">Memuat…</td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-text-muted">
                  {rows.length ? "Tidak ada akun yang cocok." : "Belum ada akun."}
                </td>
              </tr>
            ) : (
              visible.map((c) => {
                const s = scan[c.id];
                return (
                  <tr key={c.id} className="transition-colors hover:bg-bg-hover">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Pilih ${c.email || c.name || c.id}`}
                        checked={selected.has(c.id)}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                        className="size-3.5 accent-[var(--color-primary)]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-text-main">
                        {c.email || c.name || `${c.id.slice(0, 8)}…`}
                      </div>
                      <div className="font-mono text-[10px] text-text-subtle">
                        {c.keyPreview || c.model || "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={
                        c.status === "active" ? "text-success"
                        : c.status === "cooling" ? "text-warning"
                        : "text-text-muted"
                      }>
                        {c.status === "active" ? "aktif" : c.status === "cooling" ? "cooldown" : "nonaktif"}
                      </span>
                      {c.errorReasonCode && c.errorState !== "request_too_large" ? (
                        <div className="max-w-[14rem] truncate text-[10px] text-text-subtle" title={String(c.lastError || "")}>
                          {c.errorReasonCode}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {s?.remaining != null ? (
                        <span className={s.state === "depleted" ? "text-error" : s.state === "low" ? "text-warning" : "text-success"}>
                          {s.remaining}%
                        </span>
                      ) : s?.state ? (
                        <span className="text-text-muted">{stateLabel(s.state)}</span>
                      ) : (
                        <span className="text-text-subtle">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setPromptFor(c)}
                        aria-label={`Tes prompt pada ${c.email || c.name || c.id}`}
                        className="rounded-md p-1 text-text-subtle transition-colors hover:bg-bg-hover hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
                      >
                        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">chat</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!confirm(`Hapus ${c.email || c.name || c.id}?`)) return;
                          doDelete([c.id]);
                        }}
                        aria-label={`Hapus ${c.email || c.name || c.id}`}
                        className="rounded-md p-1 text-text-subtle transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
                      >
                        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">delete</span>
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-text-muted">
        Menampilkan {visible.length} dari {rows?.length ?? 0} akun.
      </p>

      {promptFor ? (
        <TestPrompt
          connection={promptFor}
          onClose={() => setPromptFor(null)}
        />
      ) : null}
    </div>
  );
}

function stateLabel(state) {
  return {
    healthy: "Sehat",
    low: "Menipis",
    critical: "Kritis",
    depleted: "Habis",
    unlimited: "Tanpa batas",
    unsupported: "Tidak ada cek",
    unknown: "Tidak terbaca",
  }[state] || state;
}

/**
 * Impor kredensial dari berkas teks.
 *
 * Bentuk yang diterima mengikuti skrip providernya, dan ditampilkan di layar
 * supaya operator tidak perlu menebak. Parser di sini permisif dengan sengaja:
 * berkas yang beredar antar mesin datang dalam beberapa bentuk, dan menolak
 * salah satunya berarti operator harus mengeditnya dengan tangan dulu.
 */
function ImportRow({ providerId, info, onDone }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const shape = {
    antigravity: "email:refreshToken",
    "grok-cli": "email:refreshToken",
    cline: "email:accessToken:refreshToken",
    freebuff: "email:accessToken",
    bai: "email:sk-...",
    tokenharbour: "email:thk_...",
    kiro: "email:refreshToken",
  }[providerId] || "email:token";

  const submit = async () => {
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (!lines.length) return;

    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/automation/import-lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, lines }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d?.error || `HTTP ${res.status}`);
        return;
      }
      setText("");
      onDone(
        `${d.success} akun diimpor${d.skipped ? `, ${d.skipped} dilewati (sudah ada)` : ""}` +
          `${d.failed ? `, ${d.failed} gagal` : ""}`,
      );
    } catch (e) {
      setError(e.message || "Impor gagal");
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setText(await f.text());
    e.target.value = "";
  };

  return (
    <details className="rounded-[10px] border border-border-subtle bg-bg-subtle/50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-main">
        Impor kredensial — bentuk <code className="font-mono">{shape}</code>
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          spellCheck={false}
          aria-label="Baris kredensial"
          placeholder={shape}
          className="min-h-[90px] w-full resize-y rounded-lg border border-border bg-surface p-2 font-mono text-xs text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-50"
        />
        {error ? <p role="alert" className="text-xs font-medium text-error">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={submit} disabled={busy || !text.trim()} loading={busy}>
            Impor
          </Button>
          <label className="flex h-7 cursor-pointer items-center gap-1 rounded-[8px] border border-border px-3 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">upload_file</span>
            Pilih berkas
            <input type="file" accept=".txt,.json,text/plain" onChange={onFile} className="hidden" />
          </label>
        </div>
      </div>
    </details>
  );
}
