/**
 * Panggil /api/usage/stats persis seperti browser, untuk tiap period.
 * Membuat token sesi dashboard yang sah supaya bisa menembus guard.
 */
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:20128";

describe("PROBE API usage stats per period", () => {
  it("bandingkan respons server untuk tiap period", async () => {
    const { createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js");
    const token = await createDashboardAuthToken({});

    const out = [];
    const rows = [];
    for (const p of ["today", "24h", "7d", "30d", "60d", "all"]) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${BASE}/api/usage/stats?period=${p}`, {
          headers: { Cookie: `auth_token=${token}` },
        });
        const ms = Date.now() - t0;
        const txt = await r.text();
        let j = null;
        try { j = JSON.parse(txt); } catch { /* */ }
        if (j && !j.error) {
          rows.push({
            period: p,
            status: r.status,
            promptTokens: j.totalPromptTokens,
            requests: j.totalRequests,
            models: Object.keys(j.byModel || {}).length,
            providers: Object.keys(j.byProvider || {}).length,
            ms,
          });
        } else {
          rows.push({ period: p, status: r.status, error: (j?.error || txt).slice(0, 80), ms });
        }
      } catch (e) {
        rows.push({ period: p, status: "ERR", error: e.message.slice(0, 80), ms: Date.now() - t0 });
      }
    }

    out.push("period | HTTP | promptTokens | requests | models | providers | ms");
    for (const r of rows) {
      if (r.error) { out.push(`${r.period.padEnd(6)} | ${r.status} | ERROR: ${r.error}`); continue; }
      out.push(`${r.period.padEnd(6)} | ${r.status} | ${String(r.promptTokens).padStart(13)} | ${String(r.requests).padStart(6)} | ${String(r.models).padStart(3)} | ${String(r.providers).padStart(3)} | ${r.ms}`);
    }
    const vals = rows.filter((r) => !r.error).map((r) => r.promptTokens);
    const uniq = new Set(vals).size;
    out.push("");
    out.push(`nilai unik: ${uniq} dari ${vals.length}`);
    out.push(uniq > 1 ? "✅ server mengembalikan angka BERBEDA" : "❌ SERVER MENGEMBALIKAN ANGKA SAMA — bug di backend!");

    const txt = out.join("\n");
    writeFileSync("C:/Users/Developer/9router-fix/usage-api-report.txt", txt);
    console.log(txt);
  }, 300000);
});
