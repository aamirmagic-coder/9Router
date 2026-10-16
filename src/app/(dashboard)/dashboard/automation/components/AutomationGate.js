"use client";

import { useState } from "react";
import { Button, Input } from "@/shared/components";

/**
 * Gerbang password halaman Automation.
 *
 * Dirancang untuk satu hal yang mudah salah: memberi tahu operator APA yang
 * sedang dilindungi. Password yang diminta tanpa penjelasan terbaca seperti
 * gangguan; password yang diminta dengan alasan terbaca seperti pengamanan.
 *
 * Pesan galat sengaja tidak membedakan "password salah" dari kegagalan lain —
 * dan tidak pernah menyebut password yang benar dalam bentuk apa pun.
 */
export default function AutomationGate({ onUnlock }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Dinaikkan setiap kali percobaan gagal. Dipakai sebagai `key` input supaya
   * React me-remount-nya — itu mengosongkan isinya dan memicu `autoFocus`
   * kembali, tanpa perlu ref. `Input` bersama tidak meneruskan `ref` ke
   * `<input>` (tidak ada forwardRef), jadi mengandalkan ref di sini akan
   * diam-diam tidak melakukan apa-apa: fokus tidak pernah kembali setelah
   * percobaan gagal, dan operator harus mengklik kotaknya lagi.
   */
  const [attempt, setAttempt] = useState(0);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;

    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/automation/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `Gagal membuka (HTTP ${res.status})`);
        setPassword("");
        setAttempt((n) => n + 1);
        return;
      }
      onUnlock();
    } catch (err) {
      setError(err.message || "Tidak bisa menghubungi server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 py-10">
      <div className="flex items-start gap-3">
        <span
          className="material-symbols-outlined mt-0.5 text-[22px] text-primary"
          aria-hidden="true"
        >
          lock
        </span>
        <div>
          <h1 className="text-lg font-semibold text-text-main">Automation</h1>
          <p className="mt-1 text-sm text-text-muted">
            Halaman ini bisa menambah akun provider dan mengekspor kredensialnya ke berkas.
            Masukkan password automation untuk melanjutkan.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        {/* `label` dipakai lewat prop Input, bukan <label> terpisah: label
            terpisah tanpa htmlFor yang menunjuk id input tidak terasosiasi,
            sehingga pembaca layar tidak menyebut "Password" saat kotaknya
            difokus. */}
        <Input
          key={attempt}
          label="Password"
          id="automation-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete="off"
          disabled={busy}
          autoFocus
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "automation-password-error" : undefined}
        />

        {error ? (
          <p id="automation-password-error" role="alert" className="text-xs font-medium text-error">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy || !password}>
          {busy ? "Memeriksa…" : "Buka"}
        </Button>
      </form>
    </div>
  );
}
