/**
 * Meta Code (Muse Spark) subscription key mint.
 *
 * The muse CLI signs in with a device-code OAuth grant, then trades the resulting
 * `dca:` token for the API key tied to the Muse Code subscription ("mint"). Only
 * that key is billed at subscription rates; any other key is pay-as-you-go.
 * Minting is idempotent (same key every call, no rotation) and the response also
 * carries current subscription usage (5h + weekly windows).
 */

import { PROVIDER_OAUTH } from "../providers/index.js";
import { fetchWithTimeout } from "./usage/shared.js";

const MINT_TIMEOUT_MS = 15000;

/**
 * Mint (or re-fetch) the subscription API key for a Meta device-code token.
 * @param {string} dcaToken - OAuth access token from auth.meta.com (`dca:…`)
 * @returns {Promise<object>} Mint payload; `api_key` is guaranteed non-empty.
 * @throws {Error} with `.status` on HTTP failure (upstream body on `.detail`, kept out
 *   of `.message` so it never reaches logs or API responses), or when Meta returns no key.
 */
export async function mintMetaCodeKey(dcaToken, proxyOptions = null) {
  if (!dcaToken) throw new Error("Meta Code: missing OAuth token");
  const res = await fetchWithTimeout(
    PROVIDER_OAUTH["meta-code"].mintUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dcaToken}`,
        "x-api-version": "1.0.0",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    },
    MINT_TIMEOUT_MS,
    proxyOptions,
  );
  if (!res.ok) {
    const err = new Error(`Meta Code key mint failed (${res.status})`);
    err.status = res.status;
    err.detail = (await res.text().catch(() => "")).slice(0, 200);
    throw err;
  }
  const data = await res.json();
  if (!data?.api_key) {
    const hint = data?.action_url ? ` Finish setup at ${data.action_url}` : "";
    throw new Error(`Meta Code: account has no Model API key yet.${hint}`);
  }
  return data;
}
