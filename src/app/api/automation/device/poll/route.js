import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { isAutomationProvider } from "@/lib/automation/providers";
import { pollAndSave } from "@/lib/automation/deviceFlow";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Satu langkah polling.
 *
 * Dijadwalkan KLIEN, bukan loop di server. Loop di server berarti satu
 * permintaan HTTP yang menggantung berjam-jam untuk setiap akun yang sedang
 * ditambahkan — dan operator yang menutup tab meninggalkan loop itu berjalan
 * sampai device code-nya kedaluwarsa. Dijadwalkan klien, menutup tab sudah
 * cukup untuk berhenti.
 *
 * `pending: true` BUKAN kegagalan; itu keadaan normal selama operator belum
 * menekan Setujui di browser.
 */
export const POST = requireGate(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const { provider, deviceCode, codeVerifier, extraData } = body || {};
  if (!provider || !isAutomationProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400, headers: NO_STORE });
  }
  if (!deviceCode) {
    return NextResponse.json({ error: "Missing deviceCode" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await pollAndSave(provider, { deviceCode, codeVerifier, extraData });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error.message || "Poll failed" },
      { status: 500, headers: NO_STORE },
    );
  }
});
