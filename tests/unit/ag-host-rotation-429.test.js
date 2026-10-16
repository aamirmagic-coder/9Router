/**
 * PROBE LIVE — apakah rotasi HOST menolong untuk 429?
 *
 * Log produksi: 429 memakan ~12 detik dan URL terakhir adalah `staging`
 * (host KETIGA). Probe sebelumnya menunjukkan 429 datang dalam ~150-650ms.
 * Selisihnya = 3 host dicoba berurutan.
 *
 * Bila limit 429 bersifat PER AKUN, ketiga host akan menolak akun yang sama —
 * rotasi host hanya membuang waktu. Bila per-host, host lain akan melayani.
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";


// Probe ini menembak endpoint SUNGGUHAN. Lewati kecuali diminta:
//   RUN_REAL=1 npx vitest run unit/ag-host-rotation-429.test.js
const RUN_REAL = process.env.RUN_REAL === "1";
const DB = resolve(process.env.APPDATA, "9router/db/data.sqlite");
const HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://staging-cloudcode-pa.sandbox.googleapis.com",
];
const MODEL = "claude-opus-4-6-thinking";

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
  return (await r.json()).access_token || null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN_REAL)("PROBE LIVE rotasi host untuk 429", () => {
  it("429 per-akun atau per-host?", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 1"
    ).all();
    db.close();

    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();
    let d = {};
    try { d = JSON.parse(rows[0].data || "{}"); } catch { /* */ }
    const at = await token(d.refreshToken);

    const body = ex.transformRequest(MODEL, {
      request: {
        contents: [{ role: "user", parts: [{ text: "Reply with exactly: ok" }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    }, true, { projectId: d.projectId, connectionId: "probe", email: rows[0].email });

    const out = [`akun: ${rows[0].email}  project=${d.projectId}`];

    async function hit(host) {
      const t0 = Date.now();
      const r = await fetch(`${host}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: ex.buildHeaders({ accessToken: at }, true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const txt = await r.text();
      return { status: r.status, ms: Date.now() - t0, raw: txt };
    }

    // ── FASE 1: pancing 429 dulu (burst pada daily) ─────────────
    out.push("\n### FASE 1 — pancing limit: burst 8x di daily ###");
    const burst = await Promise.all(Array.from({ length: 8 }, () => hit(HOSTS[0])));
    const b = {};
    for (const r of burst) b[r.status] = (b[r.status] || 0) + 1;
    out.push(`  ringkas: ${JSON.stringify(b)}`);

    // ── FASE 2: akun SEDANG kena limit — coba ketiga host ───────
    // Inilah yang dilakukan executor produksi saat 429.
    out.push("\n### FASE 2 — akun sedang kena limit: coba KETIGA host berurutan ###");
    let total = 0;
    for (const host of HOSTS) {
      const r = await hit(host);
      total += r.ms;
      const label = new URL(host).host.replace(".googleapis.com", "");
      out.push(`  [${label}] ${r.status} ${r.ms}ms :: ${r.status === 200 ? "OK" : r.raw.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    out.push(`  TOTAL waktu 3 host: ${total}ms  ← inilah ~12 detik di log produksi`);

    // ── FASE 3: tunggu, lalu buktikan limitnya per-akun ─────────
    out.push("\n  (jeda 5s lalu ulangi 3 host — bila pulih, limitnya pendek)");
    await sleep(5000);
    out.push("### FASE 3 — sesudah jeda 5s ###");
    for (const host of HOSTS) {
      const r = await hit(host);
      const label = new URL(host).host.replace(".googleapis.com", "");
      out.push(`  [${label}] ${r.status} ${r.ms}ms`);
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-host429-report.txt"), txt);
    console.log(txt);
  }, 600000);
});
