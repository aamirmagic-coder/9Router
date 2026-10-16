import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { AUTOMATION_PROVIDERS } from "@/lib/automation/providers";
import { getProvider } from "@/lib/oauth/providers";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Daftar provider yang bisa ditambah dari menu Automation.
 *
 * Difilter terhadap registry OAuth: entri katalog yang providernya tidak ada
 * (atau bukan device_code) DIBUANG, bukan ditampilkan lalu gagal saat diklik.
 * Katalog yang berbohong tentang kemampuannya lebih buruk daripada katalog
 * pendek.
 */
export const GET = requireGate(async () => {
  const available = AUTOMATION_PROVIDERS.filter((p) => {
    try {
      return getProvider(p.id)?.flowType === "device_code";
    } catch {
      return false;
    }
  });

  return NextResponse.json({ providers: available }, { headers: NO_STORE });
});
