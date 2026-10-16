import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections } from "@/lib/localDb";
import { AUTOMATION_CATALOGUE, resolveProviderId, matchCatalogueEntry } from "@/lib/automation/catalogue";
import { classifyConnectionError, effectiveStatus } from "@/lib/automation/operations";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Ringkasan per provider: berapa akun, berapa yang aktif, berapa yang bermasalah.
 *
 * Dipakai halaman pemilihan provider, supaya operator melihat keadaan sebelum
 * memilih — bukan setelah. Skrip terminal juga begitu (dashboard di atas menu),
 * dan alasannya masih berlaku: "provider mana yang perlu dibuka" adalah
 * pertanyaan pertama, bukan "apa isi provider ini".
 *
 * Semua dihitung dari database lokal, tanpa satu pun permintaan keluar.
 * Menghitung kuota di sini berarti enam permintaan API setiap kali halaman
 * dibuka, dan itu bukan yang diminta halaman ini.
 */
export const GET = requireGate(async () => {
  const all = await getProviderConnections({});

  const providers = AUTOMATION_CATALOGUE.map((entry) => {
    const pid = resolveProviderId(entry);
    // Cocokkan lewat id provider ATAU prefix, karena provider kustom bisa
    // ber-id berbeda di mesin lain.
    const mine = all.filter((c) => c.provider === pid || matchCatalogueEntry(c)?.id === entry.id);

    let active = 0;
    let problem = 0;
    let unknown = 0;
    for (const c of mine) {
      const status = effectiveStatus(c);
      if (status === "active") active++;
      else if (status === "cooling") problem++;

      const err = classifyConnectionError(c);
      if (err.state === "invalid" || err.state === "depleted") problem++;
      // `request_too_large`, 429, dan gangguan jaringan sengaja tidak dihitung:
      // itu bukan keadaan akun. Lihat catatan di operations.js.
      else if (err.state !== "none") unknown++;
    }

    return {
      id: entry.id,
      label: entry.label,
      source: entry.source,
      note: entry.note,
      kinds: entry.kinds,
      accountKind: entry.accountKind,
      keyPrefix: entry.keyPrefix || null,
      refreshable: !!entry.refreshable,
      expiry: !!entry.expiry,
      modelAssign: !!entry.modelAssign,
      // Panduan "tambah via script" (salin perintah + file email:password).
      // Ikut dikirim supaya panel tidak mengarang perintahnya sendiri.
      script: entry.script || null,
      counts: { total: mine.length, active, problem, unknown },
    };
  });

  return NextResponse.json({ providers }, { headers: NO_STORE });
});
