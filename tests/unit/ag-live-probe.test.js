/**
 * PROBE LIVE (bukan test) — jalankan manual:
 *   npx vitest run unit/ag-live-probe.test.js
 *
 * Tujuan: membandingkan status 3 host untuk AKUN YANG SAMA dengan body yang
 * dibangun oleh EXECUTOR ASLI (bukan body buatan tangan — body buatan tangan
 * kurang requestId/model/sessionId dan dijawab 404 NOT_FOUND).
 *
 * Menjawab pertanyaan: apakah 429 itu kondisi per-akun atau per-host?
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";


// Probe ini menembak endpoint SUNGGUHAN. Lewati kecuali diminta:
//   RUN_REAL=1 npx vitest run unit/ag-live-probe.test.js
const RUN_REAL = process.env.RUN_REAL === "1";
const DB = resolve(process.env.APPDATA, "9router/db/data.sqlite");

function accounts(n) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare(
    "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT ?"
  ).all(n);
  db.close();
  return rows.map((r) => {
    let d = {};
    try { d = JSON.parse(r.data || "{}"); } catch { /* */ }
    return { email: r.email, refreshToken: d.refreshToken, projectId: d.projectId || d.project || "" };
  });
}

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

const HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://staging-cloudcode-pa.sandbox.googleapis.com",
];

describe.skipIf(!RUN_REAL)("PROBE LIVE antigravity 3 host", () => {
  it("bandingkan status per host untuk akun yang sama", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();

    const MODEL = "claude-opus-4-6-thinking";
    const accts = accounts(3);
    const report = [];

    for (const a of accts) {
      const at = await token(a.refreshToken);
      if (!at) { report.push(`${a.email}: refresh GAGAL`); continue; }

      const body = ex.transformRequest(MODEL, {
        request: {
          contents: [{ role: "user", parts: [{ text: "Reply with exactly: ok" }] }],
          generationConfig: { maxOutputTokens: 16 },
        },
      }, true, { projectId: a.projectId, connectionId: "probe", email: a.email });

      const line = [`\n${a.email} project=${a.projectId}`];
      for (const host of HOSTS) {
        const label = new URL(host).host.replace(".googleapis.com", "");
        const url = `${host}/v1internal:streamGenerateContent?alt=sse`;
        const t0 = Date.now();
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: ex.buildHeaders({ accessToken: at }, true),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(40000),
          });
          const text = await r.text();
          line.push(`  [${label}] ${r.status} ${Date.now() - t0}ms :: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
        } catch (e) {
          line.push(`  [${label}] ERR ${Date.now() - t0}ms :: ${e.message}`);
        }
      }
      report.push(line.join("\n"));
    }

    const out = "\n" + "=".repeat(70) + "\n" + report.join("\n") + "\n" + "=".repeat(70) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-live-report.txt"), out);
    console.log(out);
  }, 240000);
});
