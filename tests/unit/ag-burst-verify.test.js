/**
 * PROBE LIVE — verifikasi perbaikan retry 429.
 *
 * Sebelum: burst 12x → 9 gagal (429 "Resets in 0s."), karena 429 jatuh ke
 * backoff 2 detik dan akun dibuang.
 * Sesudah: computeRetryDelay membaca `RetryInfo.retryDelay` (~162ms) dan
 * executor me-retry in-place 2x, jadi 429 burst seharusnya pulih.
 *
 * Uji lewat EXECUTOR ASLI (execute()), bukan fetch manual, supaya jalur
 * tryRetry ikut teruji.
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";


// Probe ini menembak endpoint SUNGGUHAN. Lewati kecuali diminta:
//   RUN_REAL=1 npx vitest run unit/ag-burst-verify.test.js
const RUN_REAL = process.env.RUN_REAL === "1";
const DB = resolve(process.env.APPDATA, "9router/db/data.sqlite");
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

describe.skipIf(!RUN_REAL)("PROBE LIVE verifikasi retry 429", () => {
  it("burst 12x lewat executor asli", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 1"
    ).all();
    db.close();

    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { setAntigravityHostMode } = await import("../../open-sse/providers/shared.js");
    setAntigravityHostMode("all-hosts");

    const ex = new AntigravityExecutor();
    let d = {};
    try { d = JSON.parse(rows[0].data || "{}"); } catch { /* */ }
    const at = await token(d.refreshToken);
    const creds = { accessToken: at, projectId: d.projectId, connectionId: "probe", email: rows[0].email };

    const out = [`akun: ${rows[0].email}  host-mode: all-hosts`];

    const results = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const t0 = Date.now();
      try {
        const r = await ex.execute({
          model: MODEL,
          body: { request: {
            contents: [{ role: "user", parts: [{ text: "Reply with exactly: ok" }] }],
            generationConfig: { maxOutputTokens: 16 },
          } },
          stream: false,
          credentials: creds,
          signal: AbortSignal.timeout(90000),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        });
        const status = r?.response?.status ?? "?";
        const url = r?.url ? new URL(r.url).host.replace(".googleapis.com", "") : "?";
        return { i, status, url, ms: Date.now() - t0 };
      } catch (e) {
        return { i, status: "ERR", url: "-", ms: Date.now() - t0, msg: e.message };
      }
    }));

    const byStatus = {};
    for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    out.push(`\nringkas: ${JSON.stringify(byStatus)}`);
    out.push(`sukses: ${results.filter((r) => r.status === 200).length}/12`);
    out.push("\nper request:");
    for (const r of results.sort((a, b) => a.i - b.i)) {
      out.push(`  #${String(r.i).padStart(2)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms  host=${r.url}${r.msg ? " :: " + r.msg : ""}`);
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-burst-verify.txt"), txt);
    console.log(txt);
  }, 600000);
});
