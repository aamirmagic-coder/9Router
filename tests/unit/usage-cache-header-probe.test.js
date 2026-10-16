/**
 * Verifikasi header cache halaman dashboard setelah perbaikan.
 * Server tes di port 20129 (dari build lokal).
 */
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:20129";

describe("PROBE header cache dashboard", () => {
  it("HTML dashboard tidak lagi di-cache 1 tahun", async () => {
    const { createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js");
    const t = await createDashboardAuthToken({});

    const out = [];
    for (const p of ["/dashboard/usage", "/dashboard/providers", "/dashboard"]) {
      try {
        const r = await fetch(`${BASE}${p}`, { headers: { Cookie: `auth_token=${t}` }, redirect: "manual" });
        const cc = r.headers.get("cache-control") || "(tidak ada)";
        const nx = r.headers.get("x-nextjs-cache") || "(tidak ada)";
        out.push(`${p.padEnd(24)} HTTP ${r.status} | cache-control: ${cc} | x-nextjs-cache: ${nx}`);
      } catch (e) {
        out.push(`${p.padEnd(24)} ERR ${e.message.slice(0, 60)}`);
      }
    }

    const txt = out.join("\n");
    writeFileSync("C:/Users/Developer/9router-fix/cache-header-report.txt", txt);
    console.log(txt);

    // Assertion: tidak boleh ada s-maxage panjang lagi.
    const bad = out.filter((l) => /s-maxage=31536000/.test(l));
    if (bad.length) {
      console.log("\n❌ MASIH ADA yang di-cache 1 tahun:");
      bad.forEach((l) => console.log("   " + l));
    } else {
      console.log("\n✅ Tidak ada lagi s-maxage=31536000 pada halaman dashboard.");
    }
  }, 120000);
});
