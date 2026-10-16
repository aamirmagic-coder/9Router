import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections } from "@/lib/localDb";
import {
  startQuotaCheck,
  startConnectionTest,
  startDelete,
  startRefresh,
  startDeactivate,
  startKeyVerify,
} from "@/lib/automation/operations";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Satu pintu untuk operasi massal.
 *
 * Digabung dalam satu route karena ketiganya butuh hal yang sama — origin dan
 * cookie dari permintaan yang masuk — dan karena pekerjaannya berjalan di
 * server yang sama dengan dashboard. Memanggil API 9Router dari dalam server
 * berarti meneruskan cookie sesi operator apa adanya; tidak ada kredensial baru
 * yang dibuat, tidak ada jalur autentikasi kedua yang harus dijaga.
 *
 * Origin diambil dari URL permintaan, bukan dari header `Host` yang bisa
 * dipalsukan klien — pekerjaan ini memanggil dashboard sendiri, jadi asalnya
 * harus yang benar-benar menerima permintaan.
 */
export const POST = requireGate(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const { op, provider = null, ids = null, reason = "manual" } = body || {};
  const origin = new URL(request.url).origin;
  const cookie = request.headers.get("cookie") || "";

  const connections = await getProviderConnections(provider ? { provider } : {});

  // `ids` opsional untuk quota/test = cek akun tertentu ala skrip `ag` menu 5
  // ("50", "1-10"). Klien menerjemahkan pilihannya menjadi id; id yang tidak
  // ada diabaikan diam-diam oleh operasinya. Batas 500 sama seperti delete.
  const selectedIds = Array.isArray(ids) && ids.length ? ids.slice(0, 500) : null;

  if (op === "quota") {
    const job = await startQuotaCheck({ origin, cookie, connections, provider, ids: selectedIds });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  if (op === "test") {
    const job = await startConnectionTest({ origin, cookie, connections, provider, ids: selectedIds });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  // Refresh token massal (menu 6 skrip `cline`): semua akun provider ini yang
  // punya refreshToken, tanpa login ulang.
  if (op === "refresh") {
    const job = await startRefresh({ connections, provider });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  // Verifikasi key kustom via inferensi nyata (b.ai `sk-…`, tokenharbor
  // `thk_…`) — `check_key_quota_live` di kedua skrip. 401/402/429
  // diklasifikasi menjadi keadaan, bukan error mentah.
  if (op === "verify") {
    const job = await startKeyVerify({ connections, provider });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  // Nonaktifkan (bukan hapus) — perilaku default cleanup expired skrip
  // tokenharbor. Dipisah dari delete karena "tidak dipakai sementara" dan
  // "dibuang permanen" adalah dua keputusan berbeda.
  if (op === "deactivate") {
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "Isi `ids` dengan koneksi yang mau dinonaktifkan" },
        { status: 400, headers: NO_STORE },
      );
    }
    if (ids.length > 500) {
      return NextResponse.json(
        { error: "Terlalu banyak sekaligus (maks 500)" },
        { status: 400, headers: NO_STORE },
      );
    }
    const job = await startDeactivate({ connections, ids, reason });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  if (op === "delete") {
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "Isi `ids` dengan koneksi yang mau dihapus" },
        { status: 400, headers: NO_STORE },
      );
    }
    // Batas atas supaya satu permintaan tidak menghapus seluruh database karena
    // bug di klien. 500 lebih dari cukup untuk satu tindakan yang disengaja.
    if (ids.length > 500) {
      return NextResponse.json(
        { error: "Terlalu banyak sekaligus (maks 500)" },
        { status: 400, headers: NO_STORE },
      );
    }
    const job = await startDelete({ connections, ids, reason });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "Operasi tidak dikenal" }, { status: 400, headers: NO_STORE });
});
