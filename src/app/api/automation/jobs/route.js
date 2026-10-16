import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { listJobs } from "@/lib/automation/jobs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Daftar job yang masih diingat.
 *
 * Ada supaya operator yang menutup tab lalu kembali bisa melihat bahwa
 * pemindaiannya masih berjalan (atau sudah selesai) — bukan kehilangan
 * pekerjaan 500 akun karena tidak sengaja me-refresh.
 */
export const GET = requireGate(async () => {
  const jobs = listJobs().map((j) => ({
    id: j.id,
    kind: j.kind,
    label: j.label,
    status: j.status,
    total: j.total,
    done: j.done,
    ok: j.ok,
    failed: j.failed,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  }));

  return NextResponse.json({ jobs }, { headers: NO_STORE });
});
