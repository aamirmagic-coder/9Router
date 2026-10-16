import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { isAutomationProvider } from "@/lib/automation/providers";
import { startDeviceCode, buildExtraData } from "@/lib/automation/deviceFlow";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Mulai alur device-code.
 *
 * Mengembalikan `device_code` ke klien karena poll berikutnya HARUS membawa
 * kode yang sama — ia tidak disimpan di sisi server. Menyimpannya di server
 * berarti menambah state yang harus kedaluwarsa, sementara device code itu
 * sendiri sudah membawa masa berlakunya (`expires_in`).
 *
 * `codeVerifier` dan `extraData` juga ikut ke klien karena alasan yang sama.
 * Semuanya sensitif tapi berumur pendek, dan hanya sampai ke pemanggil yang
 * sudah melewati gerbang password.
 */
export const POST = requireGate(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const { provider, startUrl, region } = body || {};
  if (!provider || !isAutomationProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400, headers: NO_STORE });
  }

  try {
    // Kiro IDC butuh startUrl/region; provider lain mengabaikannya.
    const options =
      provider === "kiro"
        ? {
            ...(startUrl ? { startUrl } : {}),
            ...(region ? { region } : {}),
            authMethod: "idc",
          }
        : undefined;

    const data = await startDeviceCode(provider, options);

    return NextResponse.json(
      {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        verificationUriComplete: data.verification_uri_complete,
        expiresIn: data.expires_in,
        interval: data.interval || 5,
        codeVerifier: data.codeVerifier,
        extraData: buildExtraData(provider, data),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to start device flow" },
      { status: 500, headers: NO_STORE },
    );
  }
});
