import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections } from "@/lib/localDb";
import { getCatalogueEntry, resolveProviderId, matchCatalogueEntry } from "@/lib/automation/catalogue";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Generate berkas TXT dari daftar akun sebuah provider.
 *
 * ── Bentuk diambil dari skrip aslinya, per provider ─────────────────────────
 *
 *   antigravity  → email:refreshToken        (format `_export_grok_tokens`/
 *                                             `menu_import_export_tokens`)
 *   grok-cli     → email:refreshToken        (parser menerima `:` `=` `,` dan
 *                                             membuang kutip pembungkus)
 *   cline        → email:accessToken:refreshToken   (urutan dari `do_txt`/
 *                                             `do_import` skrip cline)
 *   freebuff     → email:accessToken
 *   b.ai         → email:sk-...              (dari `export_bai_keys`)
 *   tokenharbour → email:thk_...:jam         (dari `_iter_tokenharbor_export_lines`;
 *                                             jam = expire_hours, opsional)
 *   kiro         → email:refreshToken        (dari `output/keys/kiro_keys.txt`;
 *                                             pemisah skrip `|` juga diterima saat impor)
 *
 * Bentuknya SENGAJA berbeda antar provider karena tiap skrip punya parsernya
 * sendiri, dan berkas ini harus bisa dibaca kembali oleh skrip itu. Menyeragamkan
 * formatnya akan membuat berkasnya tidak berguna di tempat asalnya.
 *
 * ── Yang TIDAK pernah ditulis ───────────────────────────────────────────────
 *
 * Kata sandi. Lima dari enam skrip memakai berkas `email:password` untuk
 * MEMBUAT akun lewat browser; berkas itu tidak ada di database 9Router dan tidak
 * bisa dihasilkan dari sini. Yang bisa diekspor adalah KREDENSIAL (token/key)
 * dari akun yang sudah ada — bentuk yang sama dengan yang dipakai `--import`
 * untuk memindahkan akun antar mesin.
 */
export const GET = requireGate(async (request) => {
  const url = new URL(request.url);
  const id = url.searchParams.get("provider");
  const entry = getCatalogueEntry(id);
  if (!entry) {
    return NextResponse.json({ error: "Provider tidak dikenal" }, { status: 400, headers: NO_STORE });
  }

  const pid = resolveProviderId(entry);
  const all = await getProviderConnections({});
  const mine = all.filter((c) => c.provider === pid || matchCatalogueEntry(c)?.id === entry.id);

  if (!mine.length) {
    return NextResponse.json(
      { error: `Belum ada akun ${entry.label} untuk diekspor` },
      { status: 400, headers: NO_STORE },
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const lines = [];
  let written = 0;
  let skipped = 0;

  // Kepala berkas: menyebutkan bentuknya, supaya orang yang menemukan berkas
  // ini enam bulan lagi tahu cara membacanya — dan tahu isinya rahasia.
  lines.push(`# 9Router — ${entry.label} account export`);
  lines.push(`# Dibuat: ${new Date().toISOString()}`);
  lines.push(`# Bentuk : ${txtShape(entry)}`);
  lines.push("#");
  lines.push("# BERISI KREDENSIAL. Jangan di-commit, jangan di-upload,");
  lines.push("# jangan ditaruh di folder yang disinkronkan ke cloud.");
  lines.push("");

  for (const c of mine) {
    if (entry.expiry) {
      // tokenharbour: email:key[:jam]
      const key = c.apiKey || c.accessToken;
      if (!key) { skipped++; continue; }
      const h = c.expireHours ? `:${c.expireHours}` : "";
      lines.push(`${c.email || ""}:${key}${h}`);
      written++;
      continue;
    }

    if (entry.accountKind === "apikey") {
      // b.ai: email:sk-...
      const key = c.apiKey || c.accessToken;
      if (!key) { skipped++; continue; }
      lines.push(c.email ? `${c.email}:${key}` : key);
      written++;
      continue;
    }

    if (entry.id === "cline") {
      // Cline: email:accessToken:refreshToken — tanpa access token barisnya
      // tidak berguna, jadi dilewati daripada ditulis setengah.
      if (!c.accessToken) { skipped++; continue; }
      lines.push([c.email || "", c.accessToken, c.refreshToken || ""].join(":"));
      written++;
      continue;
    }

    // antigravity, grok-cli, freebuff, kiro: email:<token>
    // Untuk antigravity, grok-cli, dan kiro, refresh token yang berguna (access
    // token berumur pendek dan bisa di-refresh); freebuff hanya punya access token.
    const token = entry.refreshable || entry.id === "grok-cli" || entry.id === "antigravity" || entry.id === "kiro"
      ? c.refreshToken || c.accessToken
      : c.accessToken;
    if (!token) { skipped++; continue; }
    lines.push(`${c.email || ""}:${token}`);
    written++;
  }

  if (written === 0) {
    return NextResponse.json(
      {
        error:
          `Tidak ada kredensial yang bisa ditulis untuk ${entry.label} ` +
          `(${skipped} akun dilewati karena tokennya kosong)`,
      },
      { status: 400, headers: NO_STORE },
    );
  }

  lines.push("");
  lines.push(`# ${written} baris${skipped ? `, ${skipped} akun dilewati (token kosong)` : ""}`);

  return new NextResponse(lines.join("\n") + "\n", {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="9router-${entry.id}-${stamp}.txt"`,
    },
  });
});

function txtShape(entry) {
  switch (entry.id) {
    case "antigravity":
    case "grok-cli":
    case "kiro":
      return "email:refreshToken";
    case "cline":
      return "email:accessToken:refreshToken";
    case "freebuff":
      return "email:accessToken";
    case "tokenharbour":
      return "email:thk_...[:expireHours]";
    case "bai":
      return "email:sk-...";
    default:
      return "email:token";
  }
}
