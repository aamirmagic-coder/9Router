import { checkQuotaGuardNow } from "@/shared/services/quotaGuardMonitor.js";
import { toProviderConnectionResponse } from "@/lib/providerConnectionResponse";

// Protected by the existing /api/providers dashboard authentication boundary.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await checkQuotaGuardNow(id);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    return Response.json({ connection: toProviderConnectionResponse(connection) });
  } catch {
    return Response.json({ error: "Could not check quota" }, { status: 500 });
  }
}
