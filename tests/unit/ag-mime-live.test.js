/**
 * PROBE LIVE — field mime mana yang diterima Google untuk inlineData?
 *
 * Fakta: versi ORI (9router 0.5.75) mengirim `mime_type` (snake_case) dan
 * BERHASIL. Fork mengirim `mimeType` (camelCase). Uji keempatnya ke Google
 * dengan gambar ASLI, pada akun yang tokennya masih hidup.
 */
import { describe, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

vi.mock("@/lib/localDb", () => ({}));
vi.mock("@/lib/db/index.js", () => ({}));
vi.mock("@/lib/db/driver.js", () => ({}));
vi.mock("@/lib/db/paths.js", () => ({ DB_DIR: "/tmp", DATA_DIR: "/tmp" }));
vi.mock("@/lib/dataDir.js", () => ({ DATA_DIR: "/tmp" }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, opts) => fetch(url, opts),
}));

const RUN_REAL = process.env.RUN_REAL === "1";
const DB = resolve(process.env.APPDATA, "9router/db/data.sqlite");
const MODEL = "gemini-3.8-flash-high";

async function token(rt) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      client_secret: "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",
      refresh_token: rt, grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  return { at: j.access_token || null, err: j.error ? `${j.error}: ${j.error_description}` : null };
}

describe.skipIf(!RUN_REAL)("PROBE LIVE field mime", () => {
  it("mime_type vs mimeType (akun hidup)", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 25"
    ).all();
    db.close();

    // Cari akun yang refresh token-nya masih hidup.
    let acct = null;
    const tried = [];
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || "{}"); } catch { /* */ }
      const t = await token(d.refreshToken);
      if (t.at) { acct = { email: r.email, at: t.at, data: d }; break; }
      tried.push(`${r.email}: ${t.err}`);
      if (tried.length >= 4) break;
    }

    const out = [];
    if (tried.length) out.push(`akun mati (dilewati):\n  ${tried.join("\n  ")}`);
    if (!acct) {
      out.push("\nTIDAK ADA akun hidup — tidak bisa menguji.");
      writeFileSync(resolve(REPO, "ag-mime-report.txt"), out.join("\n"));
      console.log(out.join("\n"));
      return;
    }
    out.push(`\nakun HIDUP: ${acct.email}`);

    const ex = new AntigravityExecutor();
    const HOST = "https://daily-cloudcode-pa.googleapis.com";
    const png = readFileSync(resolve(REPO, "images", "9router.png")).toString("base64");
    const creds = { accessToken: acct.at, projectId: acct.data.projectId, connectionId: "probe", email: acct.email };
    out.push(`gambar: 9router.png (${(png.length / 1024).toFixed(0)}KB base64)`);

    const VARIANTS = [
      { label: "mime_type (snake — dipakai ORI 0.5.75)", mk: (b) => ({ inlineData: { mime_type: "image/png", data: b } }) },
      { label: "mimeType (camel — dipakai FORK)", mk: (b) => ({ inlineData: { mimeType: "image/png", data: b } }) },
      { label: "KEDUANYA", mk: (b) => ({ inlineData: { mime_type: "image/png", mimeType: "image/png", data: b } }) },
      { label: "tanpa mime (kontrol)", mk: (b) => ({ inlineData: { data: b } }) },
    ];

    for (const v of VARIANTS) {
      const body = {
        project: acct.data.projectId,
        model: MODEL,
        userAgent: "antigravity",
        requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
        requestType: "agent",
        request: {
          sessionId: "-3750763034362895579",
          contents: [{
            role: "user",
            parts: [{ text: "Apa isi gambar ini? Jawab satu kalimat." }, v.mk(png)],
          }],
          generationConfig: { temperature: 1, maxOutputTokens: 64 },
        },
      };

      const t0 = Date.now();
      try {
        const r = await fetch(`${HOST}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: ex.buildHeaders(creds, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
        const txt = await r.text();
        out.push(`\n${v.label}`);
        out.push(`  HTTP ${r.status}  ${Date.now() - t0}ms`);
        out.push(`  ${txt.replace(/\s+/g, " ").slice(0, 300)}`);
      } catch (e) {
        out.push(`\n${v.label}\n  ERR: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 8000));
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(REPO, "ag-mime-report.txt"), txt);
    console.log(txt);
  }, 900000);
});
