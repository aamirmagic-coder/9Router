/**
 * PROBE LIVE — apakah rate limit 429 dihitung PER AKUN atau PER PROJECT?
 *
 * Semua 61 akun antigravity berbagi project `aicode-consumers`.
 * Bila limit per-project, maka menambah akun TIDAK menambah throughput —
 * persis gejala di log produksi (ganti akun terus, tetap 429).
 *
 * Desain:
 *   FASE 1 — burst 6x pada akun A saja          → berapa yang 429?
 *   jeda 65 detik (jendela rate limit diperkirakan 1 menit)
 *   FASE 2 — 2x akun A + 2x akun B + 2x akun C  → bila per-project,
 *            akun B & C ikut kena meski belum pernah dipakai di fase ini.
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";


// Probe ini menembak endpoint SUNGGUHAN. Lewati kecuali diminta:
//   RUN_REAL=1 npx vitest run unit/ag-ratelimit-scope.test.js
const RUN_REAL = process.env.RUN_REAL === "1";
const DB = resolve(process.env.APPDATA, "9router/db/data.sqlite");
const HOST = "https://daily-cloudcode-pa.googleapis.com";
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

describe.skipIf(!RUN_REAL)("PROBE LIVE scope rate limit", () => {
  it("per-akun atau per-project?", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 4"
    ).all();
    db.close();

    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();
    const out = [];

    const accts = [];
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || "{}"); } catch { /* */ }
      const at = await token(d.refreshToken);
      if (at) accts.push({ email: r.email, at, projectId: d.projectId, data: d });
    }
    out.push(`akun siap: ${accts.map((a) => a.email.split("@")[0]).join(", ")}`);
    out.push(`project: ${[...new Set(accts.map((a) => a.projectId))].join(", ")}`);

    const body = ex.transformRequest(MODEL, {
      request: {
        contents: [{ role: "user", parts: [{ text: "Reply with exactly: ok" }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    }, true, { projectId: accts[0].projectId, connectionId: "probe", email: "probe" });

    async function fire(acct, tag) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${HOST}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: ex.buildHeaders({ accessToken: acct.at }, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        const txt = await r.text();
        return { tag, status: r.status, ms: Date.now() - t0, raw: txt };
      } catch (e) {
        return { tag, status: "ERR", ms: Date.now() - t0, raw: e.message };
      }
    }

    function summarize(res) {
      const byStatus = {};
      for (const r of res) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      return JSON.stringify(byStatus);
    }

    // ── FASE 1: burst pada SATU akun ────────────────────────────
    out.push("\n### FASE 1 — burst 6x pada akun A SAJA ###");
    let res1 = await Promise.all(Array.from({ length: 6 }, () => fire(accts[0], accts[0].email)));
    for (const r of res1) out.push(`  ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms`);
    out.push(`  ringkas: ${summarize(res1)}`);
    const first429 = res1.find((r) => r.status === 429);
    if (first429) out.push(`  BODY 429 LENGKAP:\n    ${first429.raw.replace(/\s+/g, " ").slice(0, 600)}`);

    // ── JEDA: biarkan jendela rate limit lewat ──────────────────
    out.push("\n  (jeda 65s — menunggu jendela rate limit lewat)");
    await sleep(65000);

    // ── FASE 2: campur 3 akun bersamaan ─────────────────────────
    out.push("\n### FASE 2 — 2x A + 2x B + 2x C BERSAMAAN ###");
    const mix = [
      ...Array.from({ length: 2 }, () => fire(accts[0], `A:${accts[0].email.split("@")[0]}`)),
      ...Array.from({ length: 2 }, () => fire(accts[1], `B:${accts[1].email.split("@")[0]}`)),
      ...Array.from({ length: 2 }, () => fire(accts[2], `C:${accts[2].email.split("@")[0]}`)),
    ];
    const res2 = await Promise.all(mix);
    for (const r of res2.sort((a, b) => a.tag.localeCompare(b.tag))) {
      out.push(`  ${r.tag.padEnd(16)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms`);
    }
    out.push(`  ringkas: ${summarize(res2)}`);

    // ── FASE 3: kendali — akun D sendirian, tanpa kompetisi ─────
    if (accts[3]) {
      out.push("\n### FASE 3 — kendali: akun D SENDIRIAN (1 request) ###");
      const r3 = await fire(accts[3], accts[3].email);
      out.push(`  ${String(r3.status).padEnd(4)} ${String(r3.ms).padStart(6)}ms`);
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-scope-report.txt"), txt);
    console.log(txt);
  }, 900000);
});
