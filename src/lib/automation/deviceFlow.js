import { getProvider, generateAuthData, requestDeviceCode, pollForToken } from "@/lib/oauth/providers";
import { createProviderConnection } from "@/models";
import { NO_PKCE_DEVICE_PROVIDERS, buildExtraData } from "./providers.js";

/**
 * Alur device-code, dipakai menu Automation.
 *
 * ── Kenapa modul terpisah, bukan panggilan ke /api/oauth/[provider] ─────────
 *
 * Endpoint OAuth yang sudah ada (`api/oauth/[provider]/[action]/route.js`)
 * menyelesaikan pekerjaan yang sama, tapi ia TIDAK digerbangi password — dan
 * memang tidak seharusnya, karena halaman Providers memakainya untuk semua
 * orang yang sudah login dashboard. Menu Automation butuh gerbang, jadi ia
 * butuh jalannya sendiri; memanggil endpoint tak-bergerbang dari balik gerbang
 * hanya akan membuat gerbangnya terlihat bekerja padahal tidak.
 *
 * Logika bercabang di bawah ini SAMA PERSIS dengan yang ada di endpoint itu.
 * Itu duplikasi yang disengaja tapi tidak boleh dibiarkan lepas:
 * `tests/unit/automation-device-flow.test.js` membandingkan kedua berkas dan
 * gagal kalau daftar provider-nya menyimpang. Tanpa penjaga itu, menambah
 * provider di satu tempat dan lupa di tempat lain menghasilkan kegagalan yang
 * hanya muncul saat operator sudah menyetujui di browser.
 */

/** Minta kode device. Mengembalikan apa adanya dari provider + codeVerifier. */
export async function startDeviceCode(provider, options = {}) {
  const providerData = getProvider(provider);
  if (!providerData) throw new Error(`Unknown provider: ${provider}`);
  if (providerData.flowType !== "device_code") {
    throw new Error(`Provider ${provider} does not support device code flow`);
  }

  const authData = await generateAuthData(provider, null);
  const deviceData = NO_PKCE_DEVICE_PROVIDERS.has(provider)
    ? await requestDeviceCode(provider, undefined, options)
    : await requestDeviceCode(provider, authData.codeChallenge, options);

  return {
    ...deviceData,
    // Sebagian provider (qoder) membuat pasangan PKCE-nya sendiri; pakai itu
    // kalau ada, karena verifier generik tidak akan cocok dengan challenge-nya.
    codeVerifier: deviceData.codeVerifier || authData.codeVerifier,
  };
}

/**
 * Satu kali polling. Tiga hasil yang mungkin, dan pemanggil HARUS membedakannya:
 *
 *   { pending: true }        → operator belum menyetujui; panggil lagi nanti
 *   { success: true, ... }   → token tersimpan, selesai
 *   { error: "..." }         → berhenti, jangan panggil lagi
 *
 * Menganggap `pending` sebagai kegagalan adalah cara paling mudah membuat
 * alur ini tampak rusak: operator butuh waktu berpuluh detik di browser, dan
 * selama itu upstream memang menjawab `authorization_pending`.
 */
export async function pollAndSave(provider, { deviceCode, codeVerifier, extraData }) {
  if (!deviceCode) throw new Error("Missing device code");

  const result = NO_PKCE_DEVICE_PROVIDERS.has(provider)
    ? await pollForToken(provider, deviceCode, null, extraData)
    : await pollForToken(provider, deviceCode, codeVerifier, extraData);

  if (result.success) {
    // kimi-coding memakai jalur dual-auth yang sama dengan kimi.
    const providerId = provider === "kimi-coding" ? "kimi" : provider;
    const connection = await createProviderConnection({
      provider: providerId,
      authType: "oauth",
      ...result.tokens,
      expiresAt: result.tokens.expiresIn
        ? new Date(Date.now() + result.tokens.expiresIn * 1000).toISOString()
        : null,
      testStatus: "active",
    });
    return {
      success: true,
      connection: { id: connection.id, provider: connection.provider },
    };
  }

  const pending =
    result.pending || result.error === "authorization_pending" || result.error === "slow_down";

  return {
    success: false,
    pending,
    error: result.error,
    errorDescription: result.errorDescription,
  };
}

export { buildExtraData };
