"use client";

import { useState, useEffect } from "react";
import { Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * Tambah akun lewat alur device-code.
 *
 * Alurnya sama dengan yang dilakukan skrip terminal, tapi dipandu di satu
 * layar: pilih provider → minta kode → salin kode → setujui di browser →
 * tunggu sampai token tersimpan.
 *
 * ── Mengapa polling-nya effect, bukan rantai setTimeout ─────────────────────
 *
 * Versi pertama menjadwalkan dirinya sendiri lewat `setTimeout` rekursif, dan
 * itu salah dengan dua cara. Yang pertama, penjadwalnya harus membawa penanda
 * "generasi" supaya jawaban alur lama tidak menimpa alur baru — penanda yang
 * harus diurus manual di setiap jalur keluar. Yang kedua, lebih halus: setiap
 * `setTimeout` yang belum sempat dibersihkan tetap menembak satu kali lagi.
 *
 * Dijadwalkan `useEffect` yang bergantung pada sesi, keduanya hilang dengan
 * sendirinya: React menjamin cleanup berjalan SEBELUM efek berikutnya, jadi
 * memulai alur baru otomatis membatalkan yang lama, dan tidak ada penanda yang
 * perlu diingat-ingat. Sesi disimpan di state, dan efeknya berhenti begitu
 * sesinya dikosongkan.
 *
 * Setiap langkah tetap satu permintaan HTTP pendek, jadi menutup tab (atau
 * berganti tab) benar-benar menghentikan alur.
 */
export default function OAuthSection() {
  const [providers, setProviders] = useState(null);
  const [providerId, setProviderId] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | starting | waiting | done | error
  const [flow, setFlow] = useState(null);
  /** Sesi polling yang sedang berjalan. `null` = tidak ada. */
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/automation/providers")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        setProviders(d.providers || []);
        setProviderId((cur) => cur || d.providers?.[0]?.id || "");
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Satu loop polling untuk satu sesi. Berhenti sendiri saat:
   *   · token tersimpan,
   *   · upstream menjawab galat sungguhan (bukan `pending`),
   *   · batas waktu provider terlewat,
   *   · komponen dilepas / sesi diganti.
   */
  useEffect(() => {
    if (!session) return;

    let cancelled = false;
    let timer = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/automation/device/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: session.provider,
            deviceCode: session.deviceCode,
            codeVerifier: session.codeVerifier,
            extraData: session.extraData,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (data.success) {
          setPhase("done");
          setResult(data.connection);
          setSession(null);
          return;
        }

        if (data.pending) {
          if (Date.now() > session.deadline) {
            setPhase("error");
            setError("Waktu habis sebelum kamu menyetujui di browser. Coba mulai lagi.");
            setSession(null);
            return;
          }
          timer = setTimeout(tick, (session.interval || 5) * 1000);
          return;
        }

        setPhase("error");
        setError(data.errorDescription || data.error || "Gagal menukar token");
        setSession(null);
      } catch (e) {
        if (cancelled) return;
        setPhase("error");
        setError(e.message || "Polling gagal");
        setSession(null);
      }
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [session]);

  const selected = providers?.find((p) => p.id === providerId) || null;

  const start = async () => {
    if (!providerId) return;

    setPhase("starting");
    setError("");
    setResult(null);
    setFlow(null);
    setSession(null);

    try {
      const res = await fetch("/api/automation/device/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, startUrl: startUrl || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase("error");
        setError(data?.error || `HTTP ${res.status}`);
        return;
      }

      setFlow(data);
      setPhase("waiting");

      // Boleh gagal (popup blocker) — kode dan tautannya tetap tampil di layar.
      const url = data.verificationUriComplete || data.verificationUri;
      if (url) window.open(url, "_blank", "noopener,noreferrer");

      setSession({
        provider: providerId,
        deviceCode: data.deviceCode,
        codeVerifier: data.codeVerifier,
        extraData: data.extraData,
        interval: data.interval || 5,
        // Batas waktu dari provider, bukan angka tetapan: qoder memberi 300
        // detik, dan memakai tetapan yang lebih panjang membuat halaman
        // menunggu kode yang sudah mati.
        deadline: Date.now() + (data.expiresIn ? data.expiresIn * 1000 : 15 * 60 * 1000),
      });
    } catch (e) {
      setPhase("error");
      setError(e.message || "Tidak bisa memulai alur");
    }
  };

  const busy = phase === "starting" || phase === "waiting";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="automation-provider" className="text-sm font-medium text-text-main">
            Provider
          </label>
          <select
            id="automation-provider"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={busy}
            className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-sm text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-50"
          >
            {(providers || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {selected?.hint ? <p className="text-xs text-text-muted">{selected.hint}</p> : null}

        {selected?.needsStartUrl ? (
          <Input
            label="Start URL (IDC)"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
            placeholder="https://d-xxxxxxxxxx.awsapps.com/start"
            hint="Kosongkan kalau memakai AWS Builder ID biasa."
            disabled={busy}
          />
        ) : null}

        <div>
          <Button onClick={start} disabled={!providerId || busy} loading={phase === "starting"}>
            {phase === "waiting" ? "Menunggu persetujuan…" : "Mulai"}
          </Button>
        </div>
      </div>

      {error && phase === "error" ? (
        <p
          role="alert"
          className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs font-medium text-error"
        >
          {error}
        </p>
      ) : null}

      {flow && phase !== "done" ? (
        <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-main">Kode verifikasi</span>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-lg bg-bg-subtle px-3 py-1.5 font-mono text-base font-semibold tracking-wider text-text-main">
                {flow.userCode || "—"}
              </code>
              {/* `copied` dari useCopyToClipboard berisi ID, bukan boolean —
                  memeriksanya sebagai boolean akan menampilkan "Tersalin"
                  sejak render pertama, sebelum apa pun pernah disalin. */}
              <button
                type="button"
                onClick={() => copy(flow.userCode || "", "userCode")}
                className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
                  {copied === "userCode" ? "check" : "content_copy"}
                </span>
                {copied === "userCode" ? "Tersalin" : "Salin"}
              </button>
            </div>
          </div>

          {flow.verificationUri ? (
            <p className="text-xs text-text-muted">
              Buka{" "}
              <a
                href={flow.verificationUriComplete || flow.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-primary underline decoration-dotted underline-offset-2"
              >
                {flow.verificationUri}
              </a>{" "}
              lalu masukkan kode di atas.
            </p>
          ) : null}

          {phase === "waiting" ? (
            <p className="flex items-center gap-2 text-xs text-text-muted">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
              Menunggu kamu menyetujui di browser. Halaman ini lanjut sendiri.
            </p>
          ) : null}
        </div>
      ) : null}

      {phase === "done" && result ? (
        <p className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm font-medium text-success">
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            check_circle
          </span>
          Akun {result.provider} tersimpan. Tambah lagi kapan saja, atau lihat di halaman
          Providers.
        </p>
      ) : null}
    </div>
  );
}
