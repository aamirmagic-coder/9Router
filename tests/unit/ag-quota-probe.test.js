/**
 * PROBE LIVE — (A) baca API kuota langsung, (B) burst untuk memancing 429.
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";


// Probe ini menembak endpoint SUNGGUHAN. Lewati kecuali diminta:
//   RUN_REAL=1 npx vitest run unit/ag-quota-probe.test.js
const RUN_REAL = process.env.RUN_REAL === "1";
const DB = resolve(process.env.APPDATA, "9router/db/data.sqlite");

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

describe.skipIf(!RUN_REAL)("PROBE LIVE kuota + burst", () => {
  it("baca quota API dan uji burst", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 3"
    ).all();
    db.close();

    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const ex = new AntigravityExecutor();
    const HOST = "https://daily-cloudcode-pa.googleapis.com";
    const MODEL = "claude-opus-4-6-thinking";
    const out = [];

    // ── (A) API kuota ───────────────────────────────────────────
    out.push("### A. API KUOTA (per akun) ###");
    for (const a of rows) {
      let d = {};
      try { d = JSON.parse(a.data || "{}"); } catch { /* */ }
      const at = await token(d.refreshToken);
      if (!at) { out.push(`${a.email}: refresh gagal`); continue; }
      try {
        const usage = await getAntigravityUsage(at, d, null);
        out.push(`${a.email} project=${d.projectId}`);
        out.push(`  message: ${usage?.message || "(none)"}`);
        const q = usage?.quotas || {};
        for (const [k, v] of Object.entries(q)) {
          out.push(`  ${k}: remaining=${v.remainingPercentage?.toFixed?.(1)}% resetAt=${v.resetAt}`);
        }
        if (!Object.keys(q).length) out.push("  (quotas kosong)");
      } catch (e) {
        out.push(`${a.email} quota ERR: ${e.message}`);
      }
    }

    // ── (B) burst pada SATU akun ────────────────────────────────
    out.push("\n### B. BURST 12x pada satu akun (daily) ###");
    const first = rows[0];
    let d0 = {};
    try { d0 = JSON.parse(first.data || "{}"); } catch { /* */ }
    const at0 = await token(d0.refreshToken);
    const body = ex.transformRequest(MODEL, {
      request: {
        contents: [{ role: "user", parts: [{ text: "Reply with exactly: ok" }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    }, true, { projectId: d0.projectId, connectionId: "probe", email: first.email });

    const statuses = [];
    const t00 = Date.now();
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const t0 = Date.now();
      try {
        const r = await fetch(`${HOST}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: ex.buildHeaders({ accessToken: at0 }, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        const txt = await r.text();
        statuses[i] = { i, status: r.status, ms: Date.now() - t0,
          msg: r.status === 200 ? "OK" : txt.replace(/\s+/g, " ").slice(0, 110) };
      } catch (e) {
        statuses[i] = { i, status: "ERR", ms: Date.now() - t0, msg: e.message };
      }
    }));
    out.push(`total burst: ${Date.now() - t00}ms`);
    for (const s of statuses.filter(Boolean).sort((a, b) => a.i - b.i)) {
      out.push(`  #${String(s.i).padStart(2)} ${String(s.status).padEnd(4)} ${String(s.ms).padStart(6)}ms :: ${s.msg}`);
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-quota-report.txt"), txt);
    console.log(txt);
  }, 600000);
});
