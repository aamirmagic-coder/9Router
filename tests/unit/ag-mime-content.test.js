/**
 * PROBE LIVE — apakah model benar-benar MELIHAT gambarnya?
 *
 * Uji sebelumnya: keempat varian mime dapat HTTP 200. Tapi 200 saja tidak
 * cukup — harus dibuktikan model menyebut ISI gambar. Perhatikan juga apakah
 * jawabannya masuk akal (bukan potongan rusak seperti `").\n\n2`).
 *
 * Gambar uji: images/9router.png — screenshot dashboard yang memuat teks
 * khas ("9Router", tabel provider, dsb) sehingga jawaban bisa dinilai.
 */
import { describe, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
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
  const j = await r.json();
  return j.access_token || null;
}

/** Ambil teks jawaban dari SSE stream Cloud Code. */
function extractText(sse) {
  const texts = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const j = JSON.parse(raw);
      const parts = j?.response?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) if (typeof p.text === "string") texts.push(p.text);
    } catch { /* */ }
  }
  return texts.join("");
}

describe.skipIf(!RUN_REAL)("PROBE LIVE isi jawaban gambar", () => {
  it("bandingkan mime_type vs mimeType dengan prompt yang sama", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 10"
    ).all();
    db.close();

    let acct = null;
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || "{}"); } catch { /* */ }
      const at = await token(d.refreshToken);
      if (at) { acct = { email: r.email, at, data: d }; break; }
    }
    if (!acct) { console.log("tidak ada akun hidup"); return; }

    const ex = new AntigravityExecutor();
    const HOST = "https://daily-cloudcode-pa.googleapis.com";
    const png = readFileSync(resolve(REPO, "images", "9router.png")).toString("base64");
    const creds = { accessToken: acct.at, projectId: acct.data.projectId, connectionId: "probe", email: acct.email };

    const out = [`akun: ${acct.email}`, `gambar: 9router.png (${(png.length / 1024).toFixed(0)}KB)`];

    const PROMPT = "Sebutkan SEMUA teks yang terlihat di gambar ini, lalu jelaskan gambar ini apa. Bahasa Indonesia.";

    const VARIANTS = [
      { label: "mime_type (snake — ORI)", mk: (b) => ({ inlineData: { mime_type: "image/png", data: b } }) },
      { label: "mimeType (camel — FORK)", mk: (b) => ({ inlineData: { mimeType: "image/png", data: b } }) },
    ];

    for (const v of VARIANTS) {
      const body = {
        project: acct.data.projectId,
        model: MODEL,
        userAgent: "antigravity",
        requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
        requestType: "agent",
        request: {
          sessionId: "-3750763034362895579",
          contents: [{
            role: "user",
            parts: [{ text: PROMPT }, v.mk(png)],
          }],
          generationConfig: { temperature: 1, maxOutputTokens: 400 },
        },
      };

      const t0 = Date.now();
      try {
        const r = await fetch(`${HOST}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: ex.buildHeaders(creds, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
        const sse = await r.text();
        const answer = extractText(sse);
        const tokens = sse.match(/"promptTokenCount":(\d+)/)?.[1] ?? "?";

        out.push(`\n### ${v.label} ###`);
        out.push(`HTTP ${r.status} | ${Date.now() - t0}ms | promptToken=${tokens} | panjang jawaban=${answer.length} char`);
        out.push(`JAWABAN:\n${answer.slice(0, 700) || "(KOSONG)"}`);
        // Penanda apakah model benar-benar melihat isi gambar.
        const hits = ["9router", "router", "dashboard", "provider", "tabel", "model", "usage"]
          .filter((k) => answer.toLowerCase().includes(k));
        out.push(`penanda isi gambar ditemukan: ${hits.length ? hits.join(", ") : "TIDAK ADA"}`);
      } catch (e) {
        out.push(`\n### ${v.label} ###\nERR: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 10000));
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(REPO, "ag-mime-content.txt"), txt);
    console.log(txt);
  }, 900000);
});
