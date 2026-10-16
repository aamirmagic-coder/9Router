/**
 * PROBE LIVE — A/B: apakah `requestType: "agent"` memicu 429 generik?
 *
 * Klaim upstream (decolua/9router 5798b308): mengirim `requestType: "agent"`
 * membuat Google membalas 429 RESOURCE_EXHAUSTED TANPA details[] meski kuota
 * tersedia — sedangkan klien resmi menghilangkannya.
 *
 * Uji ini membandingkan DENGAN vs TANPA requestType pada burst yang sama,
 * supaya klaimnya terbukti atau gugur di mesin ini.
 */
import { describe, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { writeFileSync } from "node:fs";
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
const MODEL = "claude-opus-4-6-thinking";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN_REAL)("PROBE LIVE A/B requestType", () => {
  it("dengan vs tanpa requestType:agent", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 6"
    ).all();
    db.close();

    // Cari akun hidup.
    let acct = null;
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || "{}"); } catch { /* */ }
      const at = await token(d.refreshToken);
      if (at) { acct = { email: r.email, at, data: d }; break; }
    }
    if (!acct) { console.log("tidak ada akun hidup"); return; }

    const ex = new AntigravityExecutor();
    const creds = { accessToken: acct.at, projectId: acct.data.projectId, connectionId: "probe", email: acct.email };
    const out = [`akun: ${acct.email}`, `model: ${MODEL}`, `host: ${HOSTS[1]}`];

    // transformRequest SUDAH menghapus requestType (perbaikan upstream).
    const base = ex.transformRequest(MODEL, {
      request: {
        contents: [{ role: "user", parts: [{ text: "Balas dengan tepat: ok" }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    }, true, creds);

    const VARIANTS = [
      { label: "TANPA requestType (perbaikan upstream)", body: base },
      { label: "DENGAN requestType:agent (perilaku lama)", body: { ...base, requestType: "agent" } },
    ];

    for (const v of VARIANTS) {
      out.push(`\n### ${v.label} ###`);
      out.push(`  ada requestType di body: ${"requestType" in v.body}`);
      const t0 = Date.now();
      const results = await Promise.all(Array.from({ length: 6 }, async () => {
        try {
          const r = await fetch(`${HOSTS[1]}/v1internal:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: ex.buildHeaders(creds, true),
            body: JSON.stringify(v.body),
            signal: AbortSignal.timeout(60000),
          });
          const txt = await r.text();
          return { status: r.status, sample: r.status === 200 ? "" : txt.replace(/\s+/g, " ").slice(0, 200) };
        } catch (e) { return { status: "ERR", sample: e.message }; }
      }));
      const tally = {};
      for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
      out.push(`  6 request bersamaan: ${JSON.stringify(tally)}  (${Date.now() - t0}ms)`);
      const bad = results.find((r) => r.status !== 200 && r.sample);
      if (bad) out.push(`  contoh error: ${bad.sample}`);
      out.push("  (jeda 15s)");
      await sleep(15000);
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(REPO, "ag-requesttype-report.txt"), txt);
    console.log(txt);
  }, 900000);
});
