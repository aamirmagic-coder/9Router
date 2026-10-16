import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";

describe("PROBE resolusi alias provider", () => {
  it("cek alias pendek vs id panjang", async () => {
    const { getProviderModels } = await import("../../open-sse/config/providerModels.js");
    const { resolveProviderId, AI_PROVIDERS } = await import("../../src/shared/constants/providers.js");

    const out = [];
    out.push("alias | models | resolveProviderId");
    out.push("-".repeat(55));
    for (const a of ["ds", "deepseek", "xmtp", "xiaomi-tokenplan", "cf", "cloudflare-ai", "kc", "kilocode", "ag", "antigravity"]) {
      const models = getProviderModels(a);
      const rid = resolveProviderId(a);
      const ok = models.length > 0 ? "OK" : "RUSAK";
      out.push(`${a.padEnd(18)} | ${String(models.length).padStart(3)} | ${rid.padEnd(18)} ${ok}`);
    }

    // Berapa banyak alias pendek yang rusak total?
    let broken = 0, total = 0;
    for (const [id, p] of Object.entries(AI_PROVIDERS)) {
      const list = Array.isArray(p.aliases) ? p.aliases : [];
      for (const al of list) {
        total++;
        if (getProviderModels(al).length === 0) broken++;
      }
    }
    out.push("");
    out.push(`alias pendek yang TIDAK resolve ke model: ${broken} dari ${total}`);

    const txt = out.join("\n");
    writeFileSync("C:/Users/Developer/9router-fix/alias-resolution.txt", txt);
    console.log(txt);
  }, 120000);
});
