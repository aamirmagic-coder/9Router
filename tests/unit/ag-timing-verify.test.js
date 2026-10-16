/**
 * PROBE LIVE — verifikasi REGRESI HILANG: waktu total saat ketiga host menolak.
 *
 * Sebelum perbaikan (attempts:2 + backoff buta): 9 percobaan lintas 3 host
 * = 48-64 detik pada payload besar.
 * Sesudah: 429 tanpa info delay langsung di-veto → 1 percobaan per host.
 *
 * Uji lewat executor asli pada payload besar (image + 123 tool) supaya
 * biaya per percobaan realistis seperti produksi.
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

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function bigTools(n) {
  const base = ["bash", "glob", "grep", "read", "write", "edit", "webfetch", "todowrite"];
  return Array.from({ length: n }, (_, i) => ({
    name: `${base[i % base.length]}_${i}`,
    description: `Tool ${i} for payload sizing. `.repeat(3),
    parameters: {
      type: "object",
      properties: { a: { type: "string", description: "arg ".repeat(4) }, b: { type: "number" } },
      required: ["a"],
    },
  }));
}

describe.skipIf(!RUN_REAL)("PROBE LIVE timing payload besar", () => {
  it("waktu total lintas 3 host untuk payload produksi", async () => {
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

    const body = { request: {
      contents: [{ role: "user", parts: [
        { text: "Describe this image briefly." },
        { inlineData: { mime_type: "image/png", data: PNG_B64 } },
      ] }],
      tools: [{ functionDeclarations: bigTools(123) }],
      generationConfig: { maxOutputTokens: 64 },
    } };
    const out = [`akun: ${rows[0].email}`, `payload: ${(JSON.stringify(body).length / 1024).toFixed(0)}KB`];

    const t0 = Date.now();
    let result;
    try {
      result = await ex.execute({
        model: MODEL, body, stream: false, credentials: creds,
        signal: AbortSignal.timeout(180000),
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });
    } catch (e) {
      out.push(`EXECUTE ERR: ${e.message}`);
    }
    const total = Date.now() - t0;

    out.push(`\nTOTAL: ${total}ms (${(total / 1000).toFixed(1)}s)`);
    if (result) {
      out.push(`status akhir: ${result.response?.status}`);
      out.push(`host akhir: ${result.url ? new URL(result.url).host.replace(".googleapis.com", "") : "?"}`);
    }
    out.push(`\nPembanding: sebelum perbaikan = 48-64s (9 percobaan lintas 3 host).`);
    out.push(`Target: < 25s (1 percobaan per host + rotasi).`);

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-timing-report.txt"), txt);
    console.log(txt);
  }, 600000);
});
