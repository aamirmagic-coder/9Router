import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";

let initialized = false;

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;

  try {
    const settings = await getSettings();
    applyOutboundProxyEnv(settings);
    initialized = true;
  } catch (error) {
    console.error("[ServerInit] Error initializing outbound proxy:", error);
  }

  return initialized;
}

// Defer init so HTTP server accepts connections first
// Skip in Cloudflare Workers where setImmediate and proxy env are not applicable
const _isCloudflare =
  typeof WebSocketPair !== "undefined" ||
  (typeof navigator !== "undefined" && navigator?.userAgent === "Cloudflare-Workers") ||
  process.env.OPENNEXT_CLOUDFLARE === "1";

if (!_isCloudflare && typeof setImmediate === "function") {
  setImmediate(() => {
    ensureOutboundProxyInitialized().catch(console.log);
  });
}

export default ensureOutboundProxyInitialized;
