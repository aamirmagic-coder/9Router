import { NextResponse } from "next/server";
import { exportUsageData, importUsageData } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await exportUsageData();
    return NextResponse.json(payload, {
      headers: {
        "Content-Disposition": `attachment; filename="9router-usage-export-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (error) {
    console.error("[UsageBackup] Export error:", error);
    return NextResponse.json({ error: "Failed to export usage data" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { mode = "merge", ...payload } = body;

    if (!payload || !Array.isArray(payload.daily)) {
      return NextResponse.json({ error: "Invalid usage backup format" }, { status: 400 });
    }

    await importUsageData(payload, mode);
    return NextResponse.json({ success: true, message: `Usage data imported (${mode} mode)` });
  } catch (error) {
    console.error("[UsageBackup] Import error:", error);
    return NextResponse.json({ error: error?.message || "Failed to import usage data" }, { status: 500 });
  }
}
