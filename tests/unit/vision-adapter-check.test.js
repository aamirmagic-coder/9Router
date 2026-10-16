import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";

describe("PROBE vision adapter untuk model ag", () => {
  it("cek capability & apakah adapter aktif", async () => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    const { augmentModelsWithCapacityAdapter } = await import("../../open-sse/services/capacityAdapter.js");
    const { detectRequiredCapabilities } = await import("../../open-sse/services/combo.js");

    const out = [];
    const MODELS = [
      "claude-opus-4-6-thinking",
      "claude-opus-4-6",
      "claude-opus-4.6",
      "claude-opus-5-thinking",
      "claude-sonnet-4-6",
    ];

    out.push("=== capability per model ===");
    for (const m of MODELS) {
      const c = getCapabilitiesForModel("antigravity", m);
      out.push(`  ${m.padEnd(28)} vision=${String(c.vision).padEnd(5)} fmt=${String(c.thinkingFormat).padEnd(15)} ctx=${c.contextWindow}`);
    }

    out.push("");
    out.push("=== apakah adapter ditambahkan? ===");
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "lihat" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      }],
    };
    const required = detectRequiredCapabilities(body);
    out.push(`  capability dibutuhkan: [${[...required].join(", ")}]`);

    const settings = {
      capacityAdapter: {
        vision: { enabled: true, roundRobin: false, models: ["oc/mimo-v2.5-free"] },
      },
    };

    for (const m of MODELS) {
      const full = `ag/${m}`;
      const res = augmentModelsWithCapacityAdapter([full], required, settings);
      const adapterAktif = res.length > 1;
      out.push(`  ${full.padEnd(34)} → ${adapterAktif ? "ADAPTER AKTIF" : "native vision (adapter tidak perlu)"}`);
      if (adapterAktif) out.push(`      urutan: ${res.join(" → ")}`);
    }

    const txt = out.join("\n");
    writeFileSync("C:/Users/Developer/9router-fix/vision-adapter-report.txt", txt);
    console.log(txt);
  }, 120000);
});
