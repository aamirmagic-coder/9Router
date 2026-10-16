import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";

describe("PROBE resolve model oc", () => {
  it("cek apakah oc/* bisa di-resolve", async () => {
    const out = [];
    try {
      const mod = await import("../../src/sse/services/model.js");
      out.push("exports: " + Object.keys(mod).join(", "));

      const { getProviderModels, isValidModel } = await import("../../open-sse/config/providerModels.js");
      for (const alias of ["oc", "opencode", "xmtp", "ag", "kc"]) {
        const models = getProviderModels(alias);
        out.push(`  ${alias.padEnd(10)} → ${models ? models.length + " model" : "TIDAK ADA"}`);
        if (models && models.length && alias === "oc") {
          out.push("      contoh: " + models.slice(0, 3).map((m) => m.id).join(", "));
        }
      }

      out.push("");
      out.push("valid oc/mimo-v2.5-free: " + isValidModel("oc", "mimo-v2.5-free"));
      out.push("valid xmtp/mimo-v2.6-pro: " + isValidModel("xmtp", "mimo-v2.6-pro"));
    } catch (e) {
      out.push("ERR: " + e.message);
    }

    const txt = out.join("\n");
    writeFileSync("C:/Users/Developer/9router-fix/resolve-oc.txt", txt);
    console.log(txt);
  }, 120000);
});
