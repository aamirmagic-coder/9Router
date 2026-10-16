/**
 * PROBE LIVE — jalur LENGKAP: Claude Code → translator → Google.
 *
 * Uji sebelumnya memakai body MENTAH (melewati translator), jadi hanya
 * membuktikan Google menerima kedua bentuk mime. Yang belum diuji: apa yang
 * SEBENARNYA dihasilkan translator fork untuk request ber-image, dan apakah
 * hasilnya diterima Google.
 *
 * Inilah alur nyata Claude Code: format claude → claude-to-antigravity.
 */
import { describe, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

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

function extractText(sse) {
  const texts = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const parts = JSON.parse(raw)?.response?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) if (typeof p.text === "string") texts.push(p.text);
    } catch { /* */ }
  }
  return texts.join("");
}

describe.skipIf(!RUN_REAL)("PROBE LIVE jalur translator penuh", () => {
  it("Claude+image lewat translator → Google", async () => {
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
    const HOSTS = [
      "https://daily-cloudcode-pa.googleapis.com",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com",
      "https://staging-cloudcode-pa.sandbox.googleapis.com",
    ];
    const png = readFileSync(resolve(REPO, "images", "9router.png")).toString("base64");
    const creds = { accessToken: acct.at, projectId: acct.data.projectId, connectionId: "probe", email: acct.email };
    const out = [`akun: ${acct.email}`, `gambar: ${(png.length / 1024).toFixed(0)}KB`];

    const MODEL = "claude-opus-4-6-thinking";
    const claudeBody = {
      model: MODEL,
      max_tokens: 400,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Sebutkan teks yang terlihat di gambar ini, lalu jelaskan gambar apa ini. Bahasa Indonesia." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        ],
      }],
    };

    // 1) Lewat translator sungguhan
    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, MODEL, claudeBody, true, creds);
    out.push(`\ntranslateRequest → ${translated ? "OK" : "NULL"}`);

    if (!translated) {
      out.push("TRANSLATOR MENGEMBALIKAN NULL — ini sendiri bug.");
    } else {
      const s = JSON.stringify(translated);
      out.push(`ukuran body: ${(s.length / 1024).toFixed(0)}KB`);
      out.push(`punya inlineData: ${/inlineData/.test(s)}`);
      const mimeFields = [...s.matchAll(/"(mime_type|mimeType)"/g)].map((m) => m[1]);
      out.push(`field mime: ${[...new Set(mimeFields)].join(", ") || "(tidak ada)"}`);
      out.push(`project: ${translated.project || "(KOSONG!)"}`);
      out.push(`requestId: ${translated.requestId || "(kosong)"}`);
      out.push(`sessionId: ${translated.request?.sessionId ?? "(kosong)"}`);

      // 2) Kirim ke KETIGA host (kapasitas terpisah per host)
      for (const HOST of HOSTS) {
        const label = new URL(HOST).host.replace(".googleapis.com", "");
        const t0 = Date.now();
        try {
          const r = await fetch(`${HOST}/v1internal:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: ex.buildHeaders(creds, true),
            body: s,
            signal: AbortSignal.timeout(120000),
          });
          const sse = await r.text();
          const answer = extractText(sse);
          out.push(`\n[${label}] HTTP ${r.status} | ${Date.now() - t0}ms | jawaban ${answer.length} char`);
          if (answer) out.push(`JAWABAN:\n${answer.slice(0, 600)}`);
          if (r.status !== 200) out.push(`BODY: ${sse.replace(/\s+/g, " ").slice(0, 300)}`);
        } catch (e) {
          out.push(`\n[${label}] ERR: ${e.message}`);
        }
      }
    }

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(REPO, "ag-fullpath.txt"), txt);
    console.log(txt);
  }, 900000);
});
