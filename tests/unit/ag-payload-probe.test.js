/**
 * PROBE LIVE — apakah UKURAN payload memicu 429 RESOURCE_EXHAUSTED?
 *
 * Log produksi menunjukkan pola: request besar (3 MSG, 123 TOOL, THINK:25k)
 * kena 429 setelah ~12 detik, sementara request kecil di akun yang SAMA
 * sukses. Probe ini menguji akun yang sama dengan payload bertingkat.
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";


// Probe ini menembak endpoint SUNGGUHAN. Lewati kecuali diminta:
//   RUN_REAL=1 npx vitest run unit/ag-payload-probe.test.js
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

// Tiru tool quartet yang dipakai klien agentik.
function makeTools(n) {
  const base = ["bash", "glob", "grep", "read", "write", "edit", "webfetch", "todowrite"];
  const tools = [];
  for (let i = 0; i < n; i++) {
    const name = `${base[i % base.length]}_${i}`;
    tools.push({
      name,
      description: `Tool number ${i} used for testing payload size effects on quota. `.repeat(3),
      parameters: {
        type: "object",
        properties: {
          arg1: { type: "string", description: "first argument ".repeat(4) },
          arg2: { type: "string", description: "second argument ".repeat(4) },
          arg3: { type: "number", description: "third argument" },
        },
        required: ["arg1"],
      },
    });
  }
  return tools;
}

describe.skipIf(!RUN_REAL)("PROBE LIVE payload besar vs 429", () => {
  it("payload bertingkat pada akun yang sama", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 2"
    ).all();
    db.close();

    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();
    const HOST = "https://daily-cloudcode-pa.googleapis.com";
    const MODEL = "claude-opus-4-6-thinking";

    const CASES = [
      { label: "kecil: 1 pesan, 0 tool",       msgs: 1, tools: 0,   think: 25000 },
      { label: "sedang: 1 pesan, 40 tool",     msgs: 1, tools: 40,  think: 25000 },
      { label: "besar: 3 pesan, 123 tool",     msgs: 3, tools: 123, think: 25000 },
      { label: "besar+think kecil: 3/123/4k",  msgs: 3, tools: 123, think: 4000 },
      { label: "3 pesan, 0 tool",              msgs: 3, tools: 0,   think: 25000 },
    ];

    const report = [];
    for (const acct of rows) {
      let d = {};
      try { d = JSON.parse(acct.data || "{}"); } catch { /* */ }
      const at = await token(d.refreshToken);
      if (!at) { report.push(`${acct.email}: refresh gagal`); continue; }

      report.push(`\n=== ${acct.email} ===`);
      for (const c of CASES) {
        const contents = [];
        for (let i = 0; i < c.msgs; i++) {
          contents.push({ role: "user", parts: [{ text: `Pertanyaan ${i}: jelaskan singkat.` }] });
          if (i < c.msgs - 1) contents.push({ role: "model", parts: [{ text: `Jawaban ${i}.` }] });
        }
        const req = { contents, generationConfig: { maxOutputTokens: 64 } };
        if (c.tools) req.tools = [{ functionDeclarations: makeTools(c.tools) }];

        // Executor menangani thinking sendiri lewat nama model + thinkingConfig.
        const body = ex.transformRequest(MODEL, { request: req }, true, {
          projectId: d.projectId || d.project, connectionId: "probe", email: acct.email,
        });

        const bytes = JSON.stringify(body).length;
        const t0 = Date.now();
        try {
          const r = await fetch(`${HOST}/v1internal:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: ex.buildHeaders({ accessToken: at }, true),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
          });
          const text = await r.text();
          const msg = r.status === 200 ? "OK" : text.replace(/\s+/g, " ").slice(0, 150);
          report.push(`  ${String(r.status).padEnd(4)} ${String(Date.now() - t0).padStart(6)}ms  ${(bytes / 1024).toFixed(0).padStart(4)}KB  ${c.label}  :: ${msg}`);
        } catch (e) {
          report.push(`  ERR  ${String(Date.now() - t0).padStart(6)}ms  ${(bytes / 1024).toFixed(0).padStart(4)}KB  ${c.label}  :: ${e.message}`);
        }
      }
    }

    const out = "\n" + "=".repeat(72) + "\n" + report.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-payload-report.txt"), out);
    console.log(out);
  }, 600000);
});
