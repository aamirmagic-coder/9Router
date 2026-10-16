/**
 * Bug: suffix `(none)` pada muse-spark menghasilkan HTTP 400.
 *
 * Meta menolak `reasoning_effort: "none"` — nilai yang didukung hanya
 * [minimal, low, medium, high, xhigh, max]. Capability muse-spark tidak
 * menyetel `thinkingCanDisable: false`, sehingga thinkingUnified mengirim
 * "none" apa adanya dan api.meta.ai menjawab:
 *   400 reasoning_effort 'none' is not supported for model 'muse-spark-1.3-contributor'
 *
 * Perbaikan: tandai capability sebagai tidak-bisa-dimatikan supaya "none"
 * di-clamp ke `minimal` (perilaku yang sudah ada di thinkingUnified.js:266-268).
 */
import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const CASES = [
  ["meta-code", "muse-spark-1.3-contributor"],
  ["meta-code", "muse-spark-1.2-contributor"],
  ["muse", "muse-spark-1.3-contributor"],
  ["muse", "muse-spark-1.1"],
  ["opencode", "muse-spark-1.3-contributor-free"],
  ["opencode-go", "muse-spark-1.3-contributor"],
  ["opencode-zen", "muse-spark-1.3-contributor-free"],
];

describe("muse-spark tidak bisa mematikan thinking", () => {
  it("capability menandai thinkingCanDisable:false di semua jalur", () => {
    for (const [provider, model] of CASES) {
      const caps = getCapabilitiesForModel(provider, model);
      expect(caps.thinkingCanDisable, `${provider}/${model}`).toBe(false);
    }
  });

  it("suffix (none) tidak pernah menghasilkan reasoning_effort 'none'", () => {
    for (const [provider, model] of CASES) {
      const body = {};
      applyThinking("openai", `${model}(none)`, body, provider);
      const value = body.reasoning_effort ?? body.reasoning?.effort;
      expect(value, `${provider}/${model} -> ${JSON.stringify(body)}`).not.toBe("none");
      if (value !== undefined) {
        expect(["minimal", "low", "medium", "high", "xhigh", "max"]).toContain(value);
      }
    }
  });
});
