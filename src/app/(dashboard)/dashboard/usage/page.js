"use client";

import { Suspense, useState, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";
import UsageStackConnected from "./components/stack";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupStatus, setBackupStatus] = useState({ type: "", message: "" });
  const fileInputRef = useRef(null);

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  const handleExportUsage = async () => {
    setBackupLoading(true);
    setBackupStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/usage/backup");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to export usage data");
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `9router-usage-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBackupStatus({ type: "success", message: "Usage backup downloaded successfully!" });
    } catch (e) {
      setBackupStatus({ type: "error", message: e.message || "Export failed" });
    } finally {
      setBackupLoading(false);
    }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

    setBackupLoading(true);
    setBackupStatus({ type: "", message: "" });
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await fetch("/api/usage/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, mode: "merge" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to import usage data");
      }
      setBackupStatus({ type: "success", message: "Usage backup merged successfully!" });
    } catch (err) {
      setBackupStatus({ type: "error", message: err.message || "Import failed" });
    } finally {
      setBackupLoading(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + export/import + period selector on same row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* "Logs" HARUS ada di daftar ini. `activeTab` menerima tab=logs dan
            baris 188 merender RequestLogger untuknya, tapi selama opsinya
            tidak ada di sini tidak ada satu pun tombol yang menuju ke sana —
            tampilan itu hanya terjangkau kalau operator mengetik URL-nya
            sendiri, dan saat aktif TIDAK ADA tombol yang tersorot karena
            `value` tidak cocok dengan opsi mana pun. Menambahkannya sekaligus
            memperbaiki dua hal itu. */}
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "logs", label: "Logs" },
            { value: "details", label: "Details" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab === "overview" && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Export / Import buttons */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleExportUsage}
                disabled={backupLoading}
                className="flex items-center gap-1 rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-50"
                title="Export all usage history & tokens to JSON file"
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">download</span>
                <span>Export</span>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={backupLoading}
                className="flex items-center gap-1 rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-50"
                title="Import usage backup JSON file (merge tokens)"
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">upload</span>
                <span>Import</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImportFile}
                className="hidden"
              />
            </div>
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              size="sm"
              className="w-full sm:w-auto"
            />
          </div>
        )}
      </div>

      {backupStatus.message && (
        <div
          className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium ${
            backupStatus.type === "success"
              ? "border border-success/20 bg-success/10 text-success"
              : "border border-error/20 bg-error/10 text-error"
          }`}
        >
          <span>{backupStatus.message}</span>
          {/* Ikon dari sistem yang sama dengan sisa halaman ini. Sebelumnya
              glyph `✕` — satu-satunya karakter Unicode yang berdiri sebagai
              ikon, dan bentuknya berbeda dari `close` di FilterBar. */}
          <button
            type="button"
            onClick={() => setBackupStatus({ type: "", message: "" })}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              close
            </span>
          </button>
        </div>
      )}

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStackConnected period={period} />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}
