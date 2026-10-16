import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Export kredensial akun ke berkas, untuk dipindah antar mesin.
 *
 * ── Ini SATU-SATUNYA endpoint di 9Router yang sengaja mengembalikan token ────
 *
 * `/api/oauth/codex/bulk-import` menulis "Tokens are NEVER echoed back in the
 * response", dan itu benar untuk endpoint itu: mengembalikan token yang baru
 * saja dibuat tidak ada gunanya dan menambah satu tempat kebocoran. Di sini
 * kebalikannya — mengembalikan token ADALAH tujuan endpoint ini; tanpa itu
 * operator tidak bisa memindahkan akun ke laptop lain, yang justru salah satu
 * hal yang skrip terminal lakukan dan tidak bisa dilakukan dashboard.
 *
 * Konsekuensinya harus disadari: berkas hasil export ini berisi akses penuh ke
 * semua akun. Jangan di-commit, jangan ditaruh di folder yang disinkronkan ke
 * cloud. Itu sebabnya unduhannya memakai nama ber-tanggal dan bukan default,
 * supaya berkasnya tidak menumpuk tanpa disadari.
 *
 * `?format=txt` menghasilkan berkas teks yang bisa dibaca manusia (satu akun
 * per baris: provider + email + token) — bentuk yang sama dengan yang
 * dihasilkan skrip terminal, supaya bisa saling tukar.
 */
export const GET = requireGate(async (request) => {
  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  const onlyProvider = url.searchParams.get("provider");

  const connections = await getProviderConnections(
    onlyProvider ? { provider: onlyProvider } : {},
  );

  // Hanya akun OAuth yang berguna untuk dipindah. API key juga ikut — skrip
  // terminal memindahkannya juga, dan operator yang mengekspor biasanya ingin
  // seluruh keadaan providernya, bukan sebagian.
  const rows = connections.map((c) => ({
    provider: c.provider,
    authType: c.authType,
    email: c.email || null,
    name: c.name || null,
    accessToken: c.accessToken || null,
    refreshToken: c.refreshToken || null,
    idToken: c.idToken || null,
    expiresAt: c.expiresAt || null,
    apiKey: c.apiKey || null,
    providerSpecificData: c.providerSpecificData || null,
  }));

  const stamp = new Date().toISOString().slice(0, 10);
  const base = onlyProvider ? `9router-${onlyProvider}-${stamp}` : `9router-accounts-${stamp}`;

  if (format === "txt") {
    const lines = [
      `# 9Router account export — ${new Date().toISOString()}`,
      `# ${rows.length} akun${onlyProvider ? ` (provider: ${onlyProvider})` : ""}`,
      "# BERISI KREDENSIAL. Jangan di-commit, jangan di-upload.",
      "",
    ];
    for (const r of rows) {
      const secret = r.accessToken || r.apiKey || "";
      lines.push(
        [
          r.provider,
          r.authType || "",
          r.email || "-",
          r.name || "-",
          secret,
          r.refreshToken || "",
        ].join("\t"),
      );
    }
    return new NextResponse(lines.join("\n") + "\n", {
      headers: {
        ...NO_STORE,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.txt"`,
      },
    });
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    note: "Berisi kredensial. Jangan di-commit atau di-upload ke layanan lain.",
    count: rows.length,
    accounts: rows,
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.json"`,
    },
  });
});
