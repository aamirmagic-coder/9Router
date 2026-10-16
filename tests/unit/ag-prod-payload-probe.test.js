/**
 * PROBE LIVE — reproduksi persis log produksi.
 *
 * Log 19:09-19:10: gemini-3.8-flash-high, 2 MSG · 119 TOOL · THINK:high,
 * SEMUA 429 di daily tanpa rotasi host. Padahal:
 *   - antigravityHostMode = "all-hosts" (sudah dicek di DB)
 *   - shouldRetry(429, 0) seharusnya true (1 < 3)
 *   - gemini sukses di ketiga host dengan request KECIL
 *
 * Uji lewat executor ASLI dengan payload produksi (119 tool + 2 pesan),
 * dan bandingkan dengan payload kecil.
 */
import { describe, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

// Rantai executor menarik @/lib/db (lewat proxyFetch → got-scraping) yang
// tidak resolve sebagai paket di vitest. Probe ini tidak butuh DB.
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
  return (await r.json()).access_token || null;
}

function bigTools(n) {
  const base = ["bash", "glob", "grep", "read", "write", "edit", "webfetch", "todowrite"];
  return Array.from({ length: n }, (_, i) => ({
    name: `${base[i % base.length]}_${i}`,
    description: `Tool ${i} untuk pengukuran payload. `.repeat(3),
    parameters: {
      type: "object",
      properties: { a: { type: "string", description: "arg ".repeat(4) }, b: { type: "number" } },
      required: ["a"],
    },
  }));
}

const LOG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!RUN_REAL)("PROBE LIVE payload produksi gemini", () => {
  it("executor asli: payload besar vs kecil", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 2"
    ).all();
    db.close();


    const ex = new AntigravityExecutor();
    const urls = ex.getBaseUrls();
    const out = [`host aktif: ${urls.length} → ${urls.map(u => new URL(u).host.split(".")[0]).join(", ")}`];
    out.push(`shouldRetry(429,0)=${ex.shouldRetry(429, 0)}  shouldRetry(429,2)=${ex.shouldRetry(429, 2)}`);
    out.push(`getFallbackCount()=${ex.getFallbackCount()}`);

    const CASES = [
      { label: "kecil (1 MSG, 0 tool)", msgs: 1, tools: 0 },
      { label: "produksi (2 MSG, 119 tool)", msgs: 2, tools: 119 },
    ];

    for (const acct of rows) {
      let d = {};
      try { d = JSON.parse(acct.data || "{}"); } catch { /* */ }
      const at = await token(d.refreshToken);
      if (!at) { out.push(`${acct.email}: refresh gagal`); continue; }
      const creds = { accessToken: at, projectId: d.projectId, connectionId: "probe", email: acct.email };

      out.push(`\n=== ${acct.email} ===`);
      for (const c of CASES) {
        const contents = [];
        for (let i = 0; i < c.msgs; i++) {
          contents.push({ role: "user", parts: [{ text: `Pertanyaan ${i}: jawab singkat.` }] });
          if (i < c.msgs - 1) contents.push({ role: "model", parts: [{ text: `Jawaban ${i}.` }] });
        }
        const req = { contents, generationConfig: { maxOutputTokens: 64 } };
        if (c.tools) req.tools = [{ functionDeclarations: bigTools(c.tools) }];

        const body = ex.transformRequest(MODEL, { request: req }, true, creds);
        const bytes = JSON.stringify(body).length;

        // Uji KETIGA host berurutan (persis yang dilakukan executor saat 429),
        // supaya terlihat apakah rotasi host menolong untuk payload besar.
        const hostsTried = [];
        const t0 = Date.now();
        for (const base of urls) {
          const label = new URL(base).host.replace(".googleapis.com", "");
          try {
            const r = await fetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
              method: "POST",
              headers: ex.buildHeaders(creds, true),
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(90000),
            });
            const txt = await r.text();
            hostsTried.push(`${label}=${r.status}`);
            if (r.status === 200) break;
          } catch (e) {
            hostsTried.push(`${label}=ERR`);
          }
        }
        out.push(`  ${String(Date.now() - t0).padStart(6)}ms  ${(bytes / 1024).toFixed(0)}KB  ${c.label}  :: ${hostsTried.join(" → ")}`);
      }
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-prod-report.txt"), txt);
    console.log(txt);
  }, 900000);
});
