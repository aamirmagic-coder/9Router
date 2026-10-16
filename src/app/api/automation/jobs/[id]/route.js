import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getJob } from "@/lib/automation/jobs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Status satu job.
 *
 * Hasil dikirim BERTAMBAH, bukan seluruhnya setiap kali: untuk pemindaian 500
 * akun, mengirim 500 hasil setiap detik berarti memindahkan ratusan kilobyte
 * berulang-ulang untuk satu baris baru. Klien mengirim `since` (jumlah hasil
 * yang sudah dimilikinya) dan hanya menerima sisanya.
 */
export const GET = requireGate(async (request, { params }) => {
  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404, headers: NO_STORE });
  }

  const since = Number(new URL(request.url).searchParams.get("since") || 0);
  const from = Number.isFinite(since) && since > 0 ? Math.min(since, job.results.length) : 0;

  return NextResponse.json(
    {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      total: job.total,
      done: job.done,
      ok: job.ok,
      failed: job.failed,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      // `nextSince` dipakai klien untuk permintaan berikutnya. Dikirim eksplisit
      // supaya klien tidak perlu menebak dari panjang array.
      results: job.results.slice(from),
      nextSince: job.results.length,
    },
    { headers: NO_STORE },
  );
});

/** Batalkan job yang sedang berjalan. */
export const DELETE = requireGate(async (request, { params }) => {
  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404, headers: NO_STORE });
  }

  if (job.status === "running") {
    // Ditandai, bukan dihentikan paksa: loop memeriksa penanda ini di antara
    // item, sehingga pekerjaan yang sedang berjalan (satu permintaan keluar)
    // selesai dulu dan tidak ada hasil yang hilang separuh.
    job.cancelRequested = true;
  }

  return NextResponse.json({ id: job.id, status: job.status, cancelRequested: true }, { headers: NO_STORE });
});
