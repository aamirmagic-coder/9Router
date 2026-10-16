/**
 * PROBE — panggil getUsageStats() langsung untuk tiap period dan bandingkan.
 *
 * Membaca DB produksi (read-only). Membuktikan backend mengembalikan angka
 * BERBEDA per period, sehingga kalau UI tidak berubah, bug-nya di frontend.
 */
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("PROBE usage stats per period", () => {
  it("setiap period mengembalikan angka berbeda", async () => {
    const { getUsageStats } = await import("../../src/lib/db/repos/usageRepo.js");
    const out = [];
    const rows = [];
    for (const p of ["today", "24h", "7d", "30d", "60d", "all"]) {
      try {
        const s = await getUsageStats(p);
        rows.push({
          period: p,
          promptTokens: s.totalPromptTokens,
          completionTokens: s.totalCompletionTokens,
          requests: s.totalRequests,
          models: Object.keys(s.byModel || {}).length,
          providers: Object.keys(s.byProvider || {}).length,
          accounts: Object.keys(s.byAccount || {}).length,
        });
      } catch (e) {
        rows.push({ period: p, error: e.message });
      }
    }

    out.push("period | promptTokens | requests | models | providers");
    for (const r of rows) {
      if (r.error) { out.push(`${r.period} | ERROR: ${r.error}`); continue; }
      out.push(`${r.period.padEnd(6)} | ${String(r.promptTokens).padStart(12)} | ${String(r.requests).padStart(6)} | ${r.models} | ${r.providers}`);
    }

    const vals = rows.filter((r) => !r.error).map((r) => r.promptTokens);
    const distinct = new Set(vals).size;
    out.push("");
    out.push(`nilai promptTokens unik: ${distinct} dari ${vals.length} period`);
    out.push(distinct > 1 ? "✅ backend mengembalikan angka BERBEDA per period" : "❌ SEMUA period sama — bug di backend!");

    const txt = out.join("\n");
    writeFileSync(resolve(REPO, "usage-period-report.txt"), txt);
    console.log(txt);
  }, 300000);
});
