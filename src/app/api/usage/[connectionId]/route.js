import { getProviderConnectionById } from "@/lib/localDb";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { getConnectionUsage } from "@/shared/services/providerUsage.js";

// Compatibility for existing auto-ping and quota-reset callers.
export { refreshAndUpdateCredentials } from "@/shared/services/providerUsage.js";

/** GET /api/usage/[connectionId] - usage for a specific connection. */
export async function GET(request, { params }) {
  try {
    const { connectionId } = await params;
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth = connection.authType === "apikey" || connection.authType === "api_key";
    if (!isOAuth && !(isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider))) {
      return Response.json({ message: "Usage not available for this connection" });
    }
    const { usage } = await getConnectionUsage(connection, {
      force: new URL(request.url).searchParams.get("force") === "1",
      // Preserve the dashboard's existing direct fallback for quota reads.
      strictProxy: false,
    });
    return Response.json(usage);
  } catch (error) {
    console.warn("[Usage] Could not read account usage");
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}
