/**
 * PROBE LIVE — reproduksi 429 saat mengirim IMAGE, dan dump body LENGKAP.
 *
 * Log produksi menunjukkan 429 memakan 48-64s (naik dari ~12s) dengan body:
 *   "Resource has been exhausted (e.g. check quota)."
 * Bentuk ini TIDAK punya details[] (beda dari burst 429 yang punya
 * quotaResetDelay), sehingga computeRetryDelay jatuh ke backoff buta.
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

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

// PNG 1x1 transparan — payload image minimal.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe.skipIf(!RUN_REAL)("PROBE LIVE image → 429", () => {
  it("kirim image, dump body 429 lengkap", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 2"
    ).all();
    db.close();

    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { setAntigravityHostMode } = await import("../../open-sse/providers/shared.js");
    setAntigravityHostMode("all-hosts");
    const ex = new AntigravityExecutor();
    const out = [];

    const cases = [
      { label: "teks saja", parts: [{ text: "Reply with exactly: ok" }] },
      {
        label: "teks + 1 image",
        parts: [
          { text: "What is in this image? Reply in one word." },
          { inlineData: { mime_type: "image/png", data: PNG_B64 } },
        ],
      },
    ];

    for (const acct of rows) {
      let d = {};
      try { d = JSON.parse(acct.data || "{}"); } catch { /* */ }
      const at = await token(d.refreshToken);
      if (!at) { out.push(`${acct.email}: refresh gagal`); continue; }

      out.push(`\n=== ${acct.email} ===`);
      for (const c of cases) {
        const body = ex.transformRequest(MODEL, {
          request: { contents: [{ role: "user", parts: c.parts }], generationConfig: { maxOutputTokens: 32 } },
        }, true, { projectId: d.projectId, connectionId: "probe", email: acct.email });

        for (const host of [
          "https://daily-cloudcode-pa.googleapis.com",
          "https://autopush-cloudcode-pa.sandbox.googleapis.com",
          "https://staging-cloudcode-pa.sandbox.googleapis.com",
        ]) {
          const label = new URL(host).host.replace(".googleapis.com", "");
          const t0 = Date.now();
          try {
            const r = await fetch(`${host}/v1internal:streamGenerateContent?alt=sse`, {
              method: "POST",
              headers: ex.buildHeaders({ accessToken: at }, true),
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(90000),
            });
            const txt = await r.text();
            const ms = Date.now() - t0;
            out.push(`  [${label}] ${r.status} ${ms}ms  (${c.label})`);
            if (r.status !== 200) {
              out.push(`      BODY LENGKAP: ${txt.replace(/\s+/g, " ").slice(0, 700)}`);
            }
          } catch (e) {
            out.push(`  [${label}] ERR ${Date.now() - t0}ms (${c.label}): ${e.message}`);
          }
        }
      }
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-image-report.txt"), txt);
    console.log(txt);
  }, 900000);
});
