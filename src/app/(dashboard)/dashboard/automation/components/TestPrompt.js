"use client";

import { useState } from "react";
import { Button, Input } from "@/shared/components";

/**
 * Kirim prompt nyata ke SATU akun lewat gateway 9Router.
 *
 * Ini pengganti "Test Prompt (Real-time)" di skrip `ag` dan `grok`, dan
 * "Test Prompt / Chat" di `bai` dan `tokenharbor`. Perbedaan penting dari
 * versi Python: akunnya bisa DIPILIH. Skrip `bai` selalu memakai `conns[0]`,
 * dan skrip `ag` hanya bisa memilih lewat nomor indeks di terminal.
 *
 * Balasannya ditampilkan utuh. Skrip `bai` memotongnya di 50 karakter lewat
 * `check_key_quota_live` — cukup untuk uji kesehatan, tidak cukup untuk
 * membaca jawaban.
 */
export default function TestPrompt({ connection, onClose }) {
  const [prompt, setPrompt] = useState("Balas dalam satu kalimat singkat: siapa kamu dan model apa ini?");
  const [model, setModel] = useState(connection?.model || "");
  const [maxTokens, setMaxTokens] = useState(200);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const send = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/automation/test-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: connection.id,
          prompt,
          model: model || undefined,
          maxTokens: Number(maxTokens) || 200,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d?.error || `HTTP ${res.status}`);
        return;
      }
      setResult(d);
    } catch (e) {
      setError(e.message || "Permintaan gagal");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Tes prompt"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-t-[14px] bg-bg p-5 sm:rounded-[14px]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-main">Tes prompt</h3>
            <p className="mt-0.5 truncate font-mono text-xs text-text-muted">
              {connection.email || connection.name || connection.id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <Input label="Model (opsional)" value={model} onChange={(e) => setModel(e.target.value)} placeholder="kosongkan = model bawaan" />
          </div>
          <div className="sm:w-32">
            <Input label="Max token" type="number" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="tp-prompt" className="text-sm font-medium text-text-main">
            Prompt
          </label>
          <textarea
            id="tp-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
            className="min-h-[80px] w-full resize-y rounded-[10px] border border-border bg-surface-2 p-3 text-sm text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-50"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={send} disabled={busy || !prompt.trim()} loading={busy} icon="send">
            Kirim
          </Button>
          {result ? (
            <span className="tabular-nums text-xs text-text-muted">
              {result.elapsedMs} ms · {result.servedModel || "—"}
            </span>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs font-medium text-error">
            {error}
          </p>
        ) : null}

        {result && !result.ok ? (
          <div className="rounded-lg border border-error/20 bg-error/10 px-3 py-2">
            <p className="text-xs font-medium text-error">HTTP {result.status}</p>
            <p className="mt-1 break-words text-xs text-text-main">{result.error}</p>
          </div>
        ) : null}

        {result?.ok ? (
          <div className="flex flex-col gap-2">
            <div className="whitespace-pre-wrap break-words rounded-[10px] border border-border bg-surface p-3 text-sm text-text-main">
              {result.reply || "(balasan kosong)"}
            </div>
            {result.usage ? (
              <p className="tabular-nums text-xs text-text-muted">
                {[
                  result.usage.prompt_tokens != null ? `${result.usage.prompt_tokens} in` : null,
                  result.usage.completion_tokens != null ? `${result.usage.completion_tokens} out` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
