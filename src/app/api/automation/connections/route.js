import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections } from "@/lib/localDb";
import { classifyConnectionError, effectiveStatus } from "@/lib/automation/operations";
import { getCatalogueEntry, resolveProviderId, matchCatalogueEntry } from "@/lib/automation/catalogue";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Daftar akun untuk halaman Automation.
 *
 * ── Yang TIDAK dikembalikan ─────────────────────────────────────────────────
 *
 * Token. Tidak `accessToken`, tidak `refreshToken`, tidak `apiKey` — hanya
 * penanda bahwa kredensialnya ada, plus awalan pendek untuk membedakan dua akun
 * dengan email sama. Skrip terminal mencetak 25 karakter pertama API key ke
 * layar; itu cukup untuk memakainya kalau layarnya dilihat orang lain, dan
 * halaman ini jauh lebih mungkin dibuka di ruangan bersama daripada terminal.
 *
 * Yang dibutuhkan operator untuk memutuskan ("akun mana yang mau dihapus?")
 * adalah email, nama, provider, status, dan error terakhir — semuanya bukan
 * rahasia. Token tetap bisa diambil lewat tab Export, yang sudah punya
 * peringatannya sendiri.
 *
 * `query` menyaring berdasarkan email, nama, atau id sekaligus: operator yang
 * mencari satu akun tidak peduli kolom mana yang kebetulan cocok.
 */
export const GET = requireGate(async (request) => {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider");
  const catalogueId = url.searchParams.get("catalogueId");
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const state = url.searchParams.get("state"); // active | inactive | error

  let connections = provider ? await getProviderConnections({ provider }) : await getProviderConnections({});

  // `catalogueId` menyaring lewat entri katalog, bukan lewat id provider.
  //
  // Alasannya: `b.ai` dan `tokenharbour` adalah provider kustom ber-id UUID
  // yang berbeda di tiap mesin. Memfilter dengan id dari skrip akan kosong di
  // mesin yang membuat providernya dengan id lain. Katalog tahu cara
  // mencocokkannya (id ATAU prefix), jadi penyaringan dilakukan lewat katalog.
  if (catalogueId) {
    const entry = getCatalogueEntry(catalogueId);
    if (!entry) {
      return NextResponse.json({ error: "Provider tidak dikenal" }, { status: 400, headers: NO_STORE });
    }
    const pid = resolveProviderId(entry);
    const all = await getProviderConnections({});
    connections = all.filter((c) => c.provider === pid || matchCatalogueEntry(c)?.id === entry.id);
  }

  if (query) {
    connections = connections.filter((c) =>
      [c.email, c.name, c.id].some((v) => String(v || "").toLowerCase().includes(query)),
    );
  }

  if (state === "active") connections = connections.filter((c) => effectiveStatus(c) === "active");
  else if (state === "inactive") connections = connections.filter((c) => !c.isActive);
  else if (state === "error") {
    // Diklasifikasi, BUKAN "punya lastError". Pada instalasi nyata 146 dari 156
    // akun grok-cli punya lastError berisi `400 input_too_large` — masalah
    // prompt, bukan akun — dan menyaring dengan `!!lastError` akan melaporkan
    // semuanya sebagai rusak.
    connections = connections.filter((c) => {
      const s = classifyConnectionError(c).state;
      return s === "invalid" || s === "depleted";
    });
  }

  const rows = connections.map((c) => {
    const err = classifyConnectionError(c);
    return {
    id: c.id,
    provider: c.provider,
    // Nama node dipakai kalau ada: provider kustom ber-id UUID, dan UUID
    // terpotong tidak berarti apa-apa bagi operator.
    providerLabel: c.providerSpecificData?.nodeName || c.provider,
    name: c.name || null,
    email: c.email || null,
    authType: c.authType || null,
    isActive: !!c.isActive,
    // Status EFEKTIF, bukan `testStatus` mentah. Lihat catatan di operations.js:
    // "unavailable" yang cooldown-nya sudah lewat berarti akun aktif kembali.
    status: effectiveStatus(c),
    priority: c.priority ?? null,
    // Klasifikasi, bukan nilai mentah — plus teks aslinya untuk ditelusuri.
    errorState: err.state,
    errorReasonCode: err.reason,
    lastError: c.lastError ? String(c.lastError).slice(0, 300) : null,
    errorCode: c.errorCode ?? null,
    model: c.defaultModel || c.freebuffModel || c.assignedModel || null,
    expiresAt: c.expiresAt || null,
    // Penanda, bukan nilainya.
    hasAccessToken: !!(c.accessToken || c.apiKey),
    hasRefreshToken: !!c.refreshToken,
    keyPreview: (() => {
      const k = c.apiKey || c.accessToken;
      if (!k) return null;
      // Awalan saja — cukup untuk membedakan dua akun, tidak cukup untuk dipakai.
      return `${String(k).slice(0, 6)}…`;
    })(),
    createdAt: c.createdAt || null,
    };
  });

  // Provider yang punya akun, untuk mengisi pemilih di UI tanpa perlu endpoint
  // kedua.
  const all = await getProviderConnections({});
  const providers = [...new Set(all.map((c) => c.provider))].sort();

  return NextResponse.json(
    { connections: rows, total: rows.length, providers },
    { headers: NO_STORE },
  );
});
