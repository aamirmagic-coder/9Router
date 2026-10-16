/**
 * PROBE LIVE — kenapa gemini-3.8-flash-high 429 di SEMUA akun pada `daily`?
 *
 * Log produksi 19:09-19:10: setiap akun kena 429 di
 * https://daily-cloudcode-pa.googleapis.com — TIDAK ada rotasi host.
 * Body generik tanpa details[].
 *
 * Yang diperiksa:
 *   A. settings.antigravityHostMode di DB (bila daily-only → tidak ada rotasi)
 *   B. gemini-3.8-flash-high di KETIGA host dengan akun yang sama
 *   C. kuota pool gemini dari API
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const RUN_REAL = process.env.RUN_REAL === "1";
const DB = resolve(process.env.APPDATA, "9router/db/data.sqlite");
const MODEL = "gemini-3.8-flash-high";
const HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://staging-cloudcode-pa.sandbox.googleapis.com",
];

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

describe.skipIf(!RUN_REAL)("PROBE LIVE gemini 429 di daily", () => {
  it("host mode + 3 host + kuota", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const out = [];

    // ── A. host mode dari settings ──────────────────────────────
    out.push("### A. settings.antigravityHostMode ###");
    try {
      const rows = db.prepare("SELECT key, value FROM settings").all();
      const keys = rows.map((r) => r.key);
      out.push(`  keys: ${keys.join(", ")}`);
      const hm = rows.find((r) => r.key === "antigravityHostMode");
      out.push(`  antigravityHostMode = ${hm ? hm.value : "(TIDAK DISET → default all-hosts)"}`);
      // Cari juga di kv
      try {
        const kv = db.prepare("SELECT key, value FROM kv").all();
        const kvm = kv.find((r) => String(r.key).includes("antigravityHostMode"));
        if (kvm) out.push(`  kv: ${kvm.key} = ${kvm.value}`);
      } catch { /* */ }
    } catch (e) {
      out.push(`  settings ERR: ${e.message}`);
    }

    // ── B. akun ─────────────────────────────────────────────────
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 1"
    ).all();
    db.close();

    let d = {};
    try { d = JSON.parse(rows[0].data || "{}"); } catch { /* */ }
    const at = await token(d.refreshToken);
    out.push(`\n### B. ${rows[0].email} → ${MODEL} di 3 host ###`);

    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();

    const body = ex.transformRequest(MODEL, {
      request: {
        contents: [{ role: "user", parts: [{ text: "Reply with exactly: ok" }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    }, true, { projectId: d.projectId, connectionId: "probe", email: rows[0].email });

    for (const host of HOSTS) {
      const label = new URL(host).host.replace(".googleapis.com", "");
      const t0 = Date.now();
      try {
        const r = await fetch(`${host}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: ex.buildHeaders({ accessToken: at }, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        const txt = await r.text();
        out.push(`  [${label}] ${r.status} ${Date.now() - t0}ms`);
        if (r.status !== 200) out.push(`      ${txt.replace(/\s+/g, " ").slice(0, 400)}`);
      } catch (e) {
        out.push(`  [${label}] ERR ${Date.now() - t0}ms: ${e.message}`);
      }
    }

    // ── C. kuota pool gemini ────────────────────────────────────
    out.push("\n### C. API kuota ###");
    try {
      const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
      const usage = await getAntigravityUsage(at, d, null);
      out.push(`  message: ${usage?.message || "(none)"}`);
      for (const [k, v] of Object.entries(usage?.quotas || {})) {
        out.push(`  ${k}: remaining=${v.remainingPercentage?.toFixed?.(1)}% resetAt=${v.resetAt}`);
      }
    } catch (e) {
      out.push(`  quota ERR: ${e.message}`);
    }

    // ── D. bandingkan: apakah claude jalan di daily? ────────────
    out.push("\n### D. pembanding: claude-opus-4-6-thinking di daily ###");
    const claudeBody = ex.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [{ role: "user", parts: [{ text: "Reply with exactly: ok" }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    }, true, { projectId: d.projectId, connectionId: "probe", email: rows[0].email });
    const t1 = Date.now();
    try {
      const r = await fetch(`${HOSTS[0]}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: ex.buildHeaders({ accessToken: at }, true),
        body: JSON.stringify(claudeBody),
        signal: AbortSignal.timeout(60000),
      });
      const txt = await r.text();
      out.push(`  [daily] ${r.status} ${Date.now() - t1}ms`);
      if (r.status !== 200) out.push(`      ${txt.replace(/\s+/g, " ").slice(0, 300)}`);
    } catch (e) {
      out.push(`  [daily] ERR: ${e.message}`);
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-gemini-report.txt"), txt);
    console.log(txt);
  }, 600000);
});
