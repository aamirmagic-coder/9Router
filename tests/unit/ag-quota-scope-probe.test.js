/**
 * PROBE LIVE — apakah 429 "Resource has been exhausted (e.g. check quota)."
 * dihitung per-PROJECT?
 *
 * Kejadian 2026-09-20: 429 muncul di `staging` (host ketiga) setelah daily
 * dan autopush juga menolak, dengan body generik TANPA details[]. Semua 61
 * akun berbagi project `aicode-consumers`.
 *
 * Desain: burst besar pada SATU akun di staging, lalu uji akun LAIN di staging
 * pada saat yang sama. Bila per-project, akun kedua ikut kena meski belum
 * pernah dipakai.
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const RUN_REAL = process.env.RUN_REAL === "1";
const DB = resolve(process.env.APPDATA, "9router/db/data.sqlite");
const MODEL = "claude-opus-4-6-thinking";
const STAGING = "https://staging-cloudcode-pa.sandbox.googleapis.com";

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

// Payload BESAR mirip produksi: image + banyak tool.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function bigTools(n) {
  const base = ["bash", "glob", "grep", "read", "write", "edit", "webfetch", "todowrite"];
  return Array.from({ length: n }, (_, i) => ({
    name: `${base[i % base.length]}_${i}`,
    description: `Tool ${i} for payload sizing. `.repeat(3),
    parameters: {
      type: "object",
      properties: {
        a: { type: "string", description: "arg ".repeat(4) },
        b: { type: "number", description: "num" },
      },
      required: ["a"],
    },
  }));
}

describe.skipIf(!RUN_REAL)("PROBE LIVE scope 429 generik", () => {
  it("per-akun atau per-project?", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT email, data FROM providerConnections WHERE provider='antigravity' AND isActive=1 ORDER BY email LIMIT 3"
    ).all();
    db.close();

    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const ex = new AntigravityExecutor();
    const out = [];

    const accts = [];
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data || "{}"); } catch { /* */ }
      const at = await token(d.refreshToken);
      if (at) accts.push({ email: r.email, at, projectId: d.projectId });
    }
    out.push(`akun: ${accts.map((a) => a.email.split("@")[0]).join(", ")}`);
    out.push(`project: ${[...new Set(accts.map((a) => a.projectId))].join(", ")}`);

    const body = ex.transformRequest(MODEL, {
      request: {
        contents: [{ role: "user", parts: [
          { text: "Describe this image briefly." },
          { inlineData: { mime_type: "image/png", data: PNG_B64 } },
        ] }],
        tools: [{ functionDeclarations: bigTools(123) }],
        generationConfig: { maxOutputTokens: 64 },
      },
    }, true, { projectId: accts[0].projectId, connectionId: "probe", email: "probe" });
    out.push(`ukuran payload: ${(JSON.stringify(body).length / 1024).toFixed(0)}KB`);

    async function hit(acct, tag) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${STAGING}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: ex.buildHeaders({ accessToken: acct.at }, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
        const txt = await r.text();
        return { tag, status: r.status, ms: Date.now() - t0, raw: txt };
      } catch (e) {
        return { tag, status: "ERR", ms: Date.now() - t0, raw: e.message };
      }
    }

    // ── FASE 1: burst pada akun A saja ──────────────────────────
    out.push("\n### FASE 1 — burst 6x akun A di staging ###");
    const r1 = await Promise.all(Array.from({ length: 6 }, () => hit(accts[0], "A")));
    const s1 = {};
    for (const r of r1) s1[r.status] = (s1[r.status] || 0) + 1;
    out.push(`  ringkas: ${JSON.stringify(s1)}`);
    for (const r of r1) out.push(`    ${r.status} ${r.ms}ms`);
    const bad = r1.find((r) => r.status !== 200);
    if (bad) out.push(`  BODY: ${bad.raw.replace(/\s+/g, " ").slice(0, 400)}`);

    // ── FASE 2: akun B & C (belum dipakai) di staging, BERSAMAAN ─
    out.push("\n### FASE 2 — akun B & C (fresh) di staging, saat A baru kena ###");
    const r2 = await Promise.all([
      hit(accts[1], "B:fresh"),
      hit(accts[2], "C:fresh"),
    ]);
    for (const r of r2) {
      out.push(`  ${r.tag.padEnd(10)} ${r.status} ${r.ms}ms`);
      if (r.status !== 200) out.push(`      BODY: ${r.raw.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    const s2 = {};
    for (const r of r2) s2[r.status] = (s2[r.status] || 0) + 1;
    out.push(`  ringkas: ${JSON.stringify(s2)}`);

    // ── FASE 3: kendali — akun A lagi, 20s kemudian ─────────────
    out.push("\n  (jeda 20s)");
    await new Promise((r) => setTimeout(r, 20000));
    out.push("### FASE 3 — akun A setelah 20s ###");
    const r3 = await hit(accts[0], "A:after");
    out.push(`  ${r3.status} ${r3.ms}ms`);

    const txt = "\n" + "=".repeat(72) + "\n" + out.join("\n") + "\n" + "=".repeat(72) + "\n";
    writeFileSync(resolve(process.cwd(), "..", "ag-scope2-report.txt"), txt);
    console.log(txt);
  }, 900000);
});
