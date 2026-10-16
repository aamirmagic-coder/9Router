/**
 * PROBE LIVE — GAMBAR SUNGGUHAN: apakah memicu 429?
 *
 * Log produksi 19:42 menunjukkan sebaliknya: request 54.891 token (membawa
 * gambar) SUKSES, sementara request 41 token kena 429. Probe ini menguji
 * dengan PNG asli (bukan base64 hasil ulang yang rusak) untuk memastikan.
 *
 * Desain: akun yang sama, jeda antar kasus supaya tidak saling mencemari.
 *   A. teks saja
 *   B. teks + 1 gambar ASLI (screenshot dashboard)
 *   C. teks + 3 gambar ASLI
 */
import { describe, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN_REAL)("PROBE LIVE gambar sungguhan", () => {
  it("teks vs gambar asli pada akun sama", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 1"
    ).all();
    db.close();

    let d = {};
    try { d = JSON.parse(rows[0].data || "{}"); } catch { /* */ }
    const at = await token(d.refreshToken);
    const creds = { accessToken: at, projectId: d.projectId, connectionId: "probe", email: rows[0].email };

    const ex = new AntigravityExecutor();
    const HOST = "https://daily-cloudcode-pa.googleapis.com";
    const out = [`akun: ${rows[0].email} | model: ${MODEL}`];

    // PNG ASLI dari repo — screenshot dashboard 9router.
    const pngPath = resolve(process.cwd(), "..", "images", "9router.png");
    let pngB64;
    try {
      pngB64 = readFileSync(pngPath).toString("base64");
      out.push(`gambar: images/9router.png (${(pngB64.length / 1024).toFixed(0)}KB base64)`);
    } catch (e) {
      out.push(`gambar TIDAK DITEMUKAN: ${e.message}`);
      pngB64 = null;
    }

    const CASES = [
      { label: "A. teks saja", imgs: 0 },
      { label: "B. teks + 1 gambar ASLI", imgs: 1 },
      { label: "C. teks + 3 gambar ASLI", imgs: 3 },
    ];

    async function burst(imgs, n) {
      const parts = [{ text: "Jelaskan singkat apa yang terlihat." }];
      for (let i = 0; i < imgs; i++) {
        parts.push({ inlineData: { mime_type: "image/png", data: pngB64 } });
      }
      const body = ex.transformRequest(MODEL, {
        request: { contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: 32 } },
      }, true, creds);
      const bytes = JSON.stringify(body).length;

      const t0 = Date.now();
      const results = await Promise.all(Array.from({ length: n }, async () => {
        try {
          const r = await fetch(`${HOST}/v1internal:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: ex.buildHeaders(creds, true),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(90000),
          });
          const txt = await r.text();
          return { status: r.status, sample: r.status === 200 ? "" : txt.replace(/\s+/g, " ").slice(0, 120) };
        } catch { return { status: "ERR", sample: "" }; }
      }));
      const tally = {};
      for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
      const firstBad = results.find((r) => r.status !== 200 && r.sample);
      return { bytes, tally, ms: Date.now() - t0, sample: firstBad?.sample };
    }

    for (const c of CASES) {
      if (c.imgs > 0 && !pngB64) { out.push(`\n${c.label}: dilewati (tidak ada gambar)`); continue; }
      const r = await burst(c.imgs, 4);
      const ok = r.tally[200] || 0;
      out.push(`\n${c.label}`);
      out.push(`  payload ${(r.bytes / 1024).toFixed(0)}KB → ${ok}/4 sukses  ${JSON.stringify(r.tally)}  (${r.ms}ms)`);
      if (r.sample) out.push(`  contoh error: ${r.sample}`);
      out.push("  (jeda 15s)");
      await sleep(15000);
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-image2-report.txt"), txt);
    console.log(txt);
  }, 900000);
});
