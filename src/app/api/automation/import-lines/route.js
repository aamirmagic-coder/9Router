import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections, createProviderConnection, updateProviderConnection } from "@/lib/localDb";
import { getCatalogueEntry, resolveProviderId, matchCatalogueEntry } from "@/lib/automation/catalogue";
import { KiroService } from "@/lib/oauth/services/kiro";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Impor kredensial dari baris teks — bentuknya per provider, mengikuti skripnya.
 *
 *   antigravity  email:refreshToken
 *   grok-cli     email:refreshToken        (parser juga menerima `=` dan `,`)
 *   cline        email:accessToken:refreshToken
 *   freebuff     email:accessToken
 *   bai          email:sk-...
 *   tokenharbour email:thk_...[:expireHours]
 *   kiro         email:refreshToken        (refreshToken diawali `aorAAAAAG`;
 *                                          tervalidasi via refresh sebelum simpan)
 *
 * ── Tiga hal yang membedakan ini dari versi Python ──────────────────────────
 *
 * 1. **Dedup benar.** Skrip `tokenharbor` membaca `row[2]` untuk membandingkan
 *    API key, padahal `row[2]` adalah kolom `name` — `json.loads("bkd1 #1")`
 *    selalu gagal, jadi dedupnya tidak pernah bekerja dan setiap impor
 *    menambah baris baru. Di sini perbandingannya memakai nilai kredensial dari
 *    objek koneksi yang sudah di-parse.
 *
 * 2. **Tidak menimpa data 9Router.** Skrip `cline` menulis seluruh kolom `data`
 *    dengan payload baru, sehingga `lastUsedAt`, `consecutiveUseCount`, dan
 *    `modelLock_*` yang dipasang 9Router hilang. Di sini `updateProviderConnection`
 *    dipakai, yang menggabung.
 *
 * 3. **Berhenti di batas yang jelas.** Ini mengimpor kredensial yang SUDAH
 *    dimiliki. Ia tidak membuat akun, dan tidak memakai kata sandi akun —
 *    bentuk `email:password` dari skrip tidak diterima di sini.
 */
export const POST = requireGate(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const { provider, lines } = body || {};
  const entry = getCatalogueEntry(provider);
  if (!entry) {
    return NextResponse.json({ error: "Provider tidak dikenal" }, { status: 400, headers: NO_STORE });
  }
  if (!Array.isArray(lines) || !lines.length) {
    return NextResponse.json({ error: "Tidak ada baris untuk diimpor" }, { status: 400, headers: NO_STORE });
  }
  if (lines.length > 2000) {
    return NextResponse.json({ error: "Terlalu banyak baris (maks 2000)" }, { status: 400, headers: NO_STORE });
  }

  const pid = resolveProviderId(entry);
  const existing = (await getProviderConnections({})).filter(
    (c) => c.provider === pid || matchCatalogueEntry(c)?.id === entry.id,
  );

  /** Nilai kredensial yang sudah ada, untuk dedup. */
  const seen = new Set(
    existing.map((c) => c.apiKey || c.accessToken || c.refreshToken).filter(Boolean),
  );
  /** Indeks per email, untuk memperbarui alih-alih menggandakan. */
  const byEmail = new Map();
  for (const c of existing) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c);
  }

  const results = [];
  let success = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  // Kiro: satu service untuk seluruh batch — validateImportToken me-refresh
  // tiap token ke AWS untuk memastikan ia hidup SEBELUM disimpan.
  const kiroSvc = entry.id === "kiro" ? new KiroService() : null;

  for (let i = 0; i < lines.length; i++) {
    const raw = String(lines[i]).trim();
    if (!raw || raw.startsWith("#")) continue;

    try {
      const parsed = parseLine(entry, raw);
      if (!parsed) {
        failed++;
        results.push({ index: i, ok: false, error: "Bentuk baris tidak dikenali" });
        continue;
      }

      let credential = parsed.apiKey || parsed.accessToken || parsed.refreshToken;
      if (!credential) {
        failed++;
        results.push({ index: i, ok: false, error: "Kredensial kosong" });
        continue;
      }

      if (seen.has(credential)) {
        skipped++;
        results.push({ index: i, ok: true, skipped: true, reason: "Sudah ada" });
        continue;
      }

      // Kiro: validasi refreshToken via refresh ke AWS SEBELUM simpan —
      // persis seperti skrip (token mati ditolak saat impor, bukan sesudahnya).
      // Hasil validasi (accessToken segar + profileArn) ikut disimpan.
      let kiroExtra = null;
      if (entry.id === "kiro" && kiroSvc) {
        try {
          const v = await kiroSvc.validateImportToken(String(parsed.refreshToken));
          parsed.accessToken = v.accessToken;
          if (v.refreshToken) parsed.refreshToken = v.refreshToken;
          if (v.expiresIn) {
            parsed.expiresAt = new Date(Date.now() + Number(v.expiresIn) * 1000).toISOString();
          }
          kiroExtra = { profileArn: v.profileArn || null, authMethod: v.authMethod || "imported" };
          credential = parsed.refreshToken;
          if (seen.has(credential)) {
            skipped++;
            results.push({ index: i, ok: true, skipped: true, reason: "Sudah ada" });
            continue;
          }
        } catch (e) {
          failed++;
          results.push({ index: i, ok: false, error: e?.message || "Token Kiro tidak valid" });
          continue;
        }
      }

      const prior = parsed.email ? byEmail.get(parsed.email.toLowerCase()) : null;
      const payload = {
        provider: pid,
        authType: entry.accountKind === "apikey" ? "apikey" : "oauth",
        ...parsed,
        testStatus: "active",
        providerSpecificData: {
          prefix: entry.id === "bai" ? "bai" : entry.id === "tokenharbour" ? "tokenharbor" : undefined,
          nodeName: entry.label,
          apiType: "chat",
          ...(kiroExtra || {}),
        },
      };

      if (prior) {
        // Sudah ada dengan email sama tetapi kredensial berbeda — perbarui,
        // jangan tambah baris. Ini yang membuat impor ulang aman dijalankan.
        await updateProviderConnection(prior.id, payload);
        updated++;
        seen.add(credential);
        results.push({ index: i, ok: true, updated: true, id: prior.id });
        continue;
      }

      const conn = await createProviderConnection(payload);
      success++;
      seen.add(credential);
      if (parsed.email) byEmail.set(parsed.email.toLowerCase(), conn);
      results.push({ index: i, ok: true, id: conn.id });
    } catch (err) {
      failed++;
      results.push({ index: i, ok: false, error: err?.message || "Impor gagal" });
    }
  }

  return NextResponse.json(
    { success, updated, skipped, failed, total: lines.length, results: results.filter((r) => !r.ok).slice(0, 50) },
    { headers: NO_STORE },
  );
});

/**
 * Parser per provider.
 *
 * Pemisahnya `:` di semua bentuk, tetapi skrip `grok` juga menerima `=` dan `,`
 * — dan berkas yang beredar antar mesin memang datang dalam ketiga bentuk itu.
 * Menolak dua di antaranya berarti operator harus mengedit berkasnya dulu.
 */
function parseLine(entry, line) {
  const parts = splitFields(line);
  if (!parts.length) return null;

  const email = parts.find((p) => p.includes("@") && p.length > 3) || null;
  const rest = parts.filter((p) => p !== email);

  const isKey = (v) =>
    entry.keyPrefix ? v.startsWith(entry.keyPrefix) : v.length > 12 && !v.includes("@");

  if (entry.id === "cline") {
    // email:accessToken:refreshToken
    const [accessToken, refreshToken] = rest;
    if (!accessToken) return null;
    return { email, accessToken, refreshToken: refreshToken || null };
  }

  if (entry.id === "kiro") {
    // email:refreshToken — refreshToken diawali `aorAAAAAG` (format skrip
    // add-account-kiro-9router.py). Validasinya lewat refresh di bawah
    // (validateKiroLine), BUKAN di sini — parser hanya memecah bentuk.
    const token = rest.find((v) => v.length > 10) || rest[0];
    if (!token) return null;
    return { email, refreshToken: token };
  }

  if (entry.accountKind === "apikey") {
    const apiKey = rest.find(isKey) || rest[0];
    if (!apiKey) return null;
    const out = { email, apiKey };
    if (entry.expiry) {
      // tokenharbour: email:key:jam
      const hours = rest.find((v) => v !== apiKey && /^\d+(\.\d+)?$/.test(v));
      if (hours) {
        out.expireHours = Number(hours);
        out.expiresAt = new Date(Date.now() + Number(hours) * 3_600_000).toISOString();
      }
    }
    return out;
  }

  // OAuth: antigravity, grok-cli, freebuff — email:token
  const token = rest.find((v) => v.length > 10) || rest[0];
  if (!token) return null;
  const kind = entry.id === "freebuff" ? "accessToken" : "refreshToken";
  return { email, [kind]: token, ...(kind === "refreshToken" ? {} : {}) };
}

/** Pecah baris pada pemisah pertama yang muncul, apa pun jenisnya. */
function splitFields(line) {
  for (const sep of [":", "|", "=", "\t", ","]) {
    if (line.includes(sep)) {
      return line
        .split(sep)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
    }
  }
  return [line.trim()].filter(Boolean);
}
