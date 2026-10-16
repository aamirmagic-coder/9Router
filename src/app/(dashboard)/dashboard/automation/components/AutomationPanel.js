"use client";

import { useState } from "react";
import { SegmentedControl } from "@/shared/components";
import ProviderPicker from "./ProviderPicker";
import ProviderPanel from "./ProviderPanel";
import OAuthSection from "./OAuthSection";
import ExportSection from "./ExportSection";

/**
 * Isi halaman Automation setelah gerbang terbuka.
 *
 * Alurnya dua langkah, mengikuti bentuk skrip terminal: **pilih provider, lalu
 * pilih fiturnya.** Sebelumnya halaman ini menaruh semua operasi dalam satu
 * daftar akun besar, dan itu menyembunyikan satu hal yang penting: fitur tiap
 * provider TIDAK sama. `quota` hanya ada untuk yang punya handler kuota,
 * `expiry` hanya untuk TokenHarbor — dan daftar gabungan tidak bisa
 * menunjukkan perbedaan itu tanpa berbohong tentang salah satunya.
 *
 * "Tambah via OAuth" dan "Export" tetap ada sebagai tab tersendiri karena
 * keduanya memang lintas-provider: login device tidak terikat satu provider,
 * dan export berguna untuk semua.
 */
const TABS = [
  { value: "manage", label: "Kelola akun" },
  { value: "oauth", label: "Login device" },
  { value: "export", label: "Export semua" },
];

export default function AutomationPanel({ onLock }) {
  const [tab, setTab] = useState("manage");
  const [providerId, setProviderId] = useState(null);
  const [locked, setLocked] = useState(false);

  const lockNow = async () => {
    setLocked(true);
    try {
      await fetch("/api/automation/gate", { method: "DELETE" });
    } finally {
      onLock();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-main">Automation</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Kelola akun provider: kuota, tes koneksi, tes prompt, impor, dan export.
          </p>
        </div>
        <button
          type="button"
          onClick={lockNow}
          disabled={locked}
          className="flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        >
          <span className="material-symbols-outlined text-[15px]" aria-hidden="true">lock</span>
          <span>Kunci lagi</span>
        </button>
      </div>

      <SegmentedControl options={TABS} value={tab} onChange={setTab} className="w-full sm:w-auto" />

      {tab === "manage" ? (
        providerId ? (
          <ProviderPanel providerId={providerId} onBack={() => setProviderId(null)} />
        ) : (
          <ProviderPicker onPick={setProviderId} />
        )
      ) : null}

      {tab === "oauth" ? <OAuthSection /> : null}
      {tab === "export" ? <ExportSection /> : null}
    </div>
  );
}
