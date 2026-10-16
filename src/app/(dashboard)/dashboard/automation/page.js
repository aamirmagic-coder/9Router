"use client";

import { useState, useEffect } from "react";
import AutomationGate from "./components/AutomationGate";
import AutomationPanel from "./components/AutomationPanel";

/**
 * /dashboard/automation — kelola akun provider dari web.
 *
 * Halaman ini punya DUA lapis, dan keduanya beda peran:
 *
 *   1. Sesi dashboard — sudah berlaku sebelum halaman ini bisa dibuka sama
 *      sekali. Dijaga oleh sisa aplikasi, bukan di sini.
 *   2. Gerbang password (AUTOMATION_PASSWORD) — dijaga halaman ini, karena
 *      halaman ini bisa membuka dan memindahkan kredensial SEMUA akun.
 *
 * ── Mengapa status gerbang DIPERIKSA, bukan diasumsikan ─────────────────────
 *
 * Versi pertama selalu mulai dengan `unlocked = false` dan tidak pernah
 * memeriksa cookie yang sudah sah. Akibatnya password diminta lagi setiap kali
 * halaman dimuat — dan karena setiap perpindahan tab di dashboard ini adalah
 * navigasi sungguhan, itu berarti password diminta lagi setiap kali operator
 * pindah menu lalu kembali. Cookie gerbangnya masih berlaku; yang salah adalah
 * halamannya, yang menebak keadaan alih-alih menanyakannya.
 *
 * Selama pemeriksaan berlangsung, yang tampil adalah kerangka — bukan gerbang
 * yang berkedip muncul lalu hilang saat jawabannya tiba.
 */
export default function AutomationPage() {
  // null = belum diperiksa, true/false = hasil pemeriksaan.
  const [unlocked, setUnlocked] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/automation/gate", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { unlocked: false }))
      .then((d) => {
        if (!cancelled) setUnlocked(!!d.unlocked);
      })
      .catch(() => {
        if (!cancelled) setUnlocked(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unlocked === null) {
    return (
      <div className="flex flex-col gap-3 py-10" aria-busy="true">
        <div className="h-6 w-40 animate-pulse rounded-lg bg-border-subtle/60" />
        <div className="h-24 w-full max-w-md animate-pulse rounded-[14px] bg-border-subtle/60" />
      </div>
    );
  }

  if (!unlocked) {
    return <AutomationGate onUnlock={() => setUnlocked(true)} />;
  }

  // Mengunci hanya menutup tampilan; cookienya dihapus server lewat DELETE.
  return <AutomationPanel onLock={() => setUnlocked(false)} />;
}
