import initializeApp from "./initializeApp.js";

// Skip during Next.js build/prerender, or in Cloudflare Workers / serverless edge runtime
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
  || process.env.NEXT_PHASE === "phase-export"
  || process.env.NEXT_PHASE === "phase-static";

const isCloudflare =
  typeof WebSocketPair !== "undefined" ||
  (typeof navigator !== "undefined" && navigator?.userAgent === "Cloudflare-Workers") ||
  process.env.OPENNEXT_CLOUDFLARE === "1";

// Server-only singleton: guard via global so HMR / re-imports don't double-init
if (typeof window === "undefined" && !isBuildPhase && !isCloudflare && !global.__appBootstrapped) {
  global.__appBootstrapped = true;
  initializeApp().catch((e) => console.error("[Bootstrap] init failed:", e.message));
}
