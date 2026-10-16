"use client";

import { useState, useEffect } from "react";
import { Button } from "@/shared/components";

/**
 * Export kredensial ke berkas.
 *
 * Peringatannya ditaruh DI ATAS tombol, bukan sebagai catatan kaki. Berkas
 * hasilnya berisi akses penuh ke semua akun; operator yang menyadarinya setelah
 * menekan tombol sudah terlambat untuk memilih tempat menyimpannya.
 */
export default function ExportSection() {
  const [provider, setProvider] = useState("");
  const [providers, setProviders] = useState([]);
  const [downloading, setDownloading] = useState("");

  useEffect(() => {
    fetch("/api/automation/providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.providers) setProviders(d.providers);
      })
      .catch(() => {
        // Daftar provider hanya mempersempit pilihan; gagal memuatnya tidak
        // menghalangi export seluruh akun, yang adalah tujuan utamanya.
      });
  }, []);

  const download = async (format) => {
    setDownloading(format);
    try {
      const params = new URLSearchParams({ format });
      if (provider) params.set("provider", provider);
      const res = await fetch(`/api/automation/export?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Nama dari header Content-Disposition supaya format nama berkasnya
      // ditentukan server (satu tempat), bukan disusun ulang di klien.
      const cd = res.headers.get("content-disposition") || "";
      const match = /filename="([^"]+)"/.exec(cd);
      a.download = match?.[1] || `9router-accounts.${format === "txt" ? "txt" : "json"}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export gagal: ${e.message}`);
    } finally {
      setDownloading("");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="automation-export-provider" className="text-sm font-medium text-text-main">
            Provider
          </label>
          <select
            id="automation-export-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-sm text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <option value="">Semua provider</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2">
          <span className="material-symbols-outlined mt-0.5 text-[16px] text-warning" aria-hidden="true">
            warning
          </span>
          <p className="text-xs text-text-main">
            Berkasnya berisi <strong>token akses penuh</strong> ke akun-akun itu. Jangan
            di-commit ke git, dan jangan taruh di folder yang tersinkron ke cloud.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon="download"
            onClick={() => download("json")}
            loading={downloading === "json"}
            disabled={!!downloading}
          >
            Unduh JSON
          </Button>
          <Button
            variant="secondary"
            icon="description"
            onClick={() => download("txt")}
            loading={downloading === "txt"}
            disabled={!!downloading}
          >
            Unduh TXT
          </Button>
        </div>

        <p className="text-xs text-text-muted">
          JSON bisa diimpor kembali lewat tab Bulk import, di mesin ini atau di mesin lain.
          TXT berbentuk tab (provider, authType, email, nama, token, refreshToken) untuk dibaca
          atau diolah skrip.
        </p>
      </div>
    </div>
  );
}
