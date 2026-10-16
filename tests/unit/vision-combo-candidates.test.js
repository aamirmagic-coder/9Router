/**
 * Kandidat model untuk Combo vision — cek mana yang benar-benar vision-capable
 * DAN punya koneksi aktif.
 */
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

describe("PROBE kandidat combo vision", () => {
  it("cek capability + koneksi aktif", async () => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    const { DatabaseSync } = await import("node:sqlite");

    const db = new DatabaseSync(resolve(process.env.APPDATA, "9router/db/data.sqlite"), { readOnly: true });
    const conns = db.prepare("SELECT provider, COUNT(*) n FROM providerConnections WHERE isActive=1 GROUP BY provider").all();
    db.close();
    const activeProviders = new Set(conns.map((c) => c.provider));

    // Kandidat: model yang relevan untuk membaca gambar.
    const CANDIDATES = [
      ["ag", "claude-opus-4-6-thinking", "antigravity"],
      ["ag", "gemini-3.8-flash-high", "antigravity"],
      ["ag", "gemini-3.8-flash-tiered", "antigravity"],
      ["xmtp", "mimo-v2.6-pro", "xiaomi-tokenplan"],
      ["xmtp", "mimo-v2.6-flash", "xiaomi-tokenplan"],
      ["oc", "mimo-v2.5-free", "opencode"],
      ["oc", "muse-spark-1.3-contributor-free", "opencode"],
      ["kc", "mimo-v2.6-pro", "kilocode"],
      ["groq", "llama-4-scout-17b-16e-instruct", "groq"],
      ["cerebras", "llama-4-scout-17b-16e-instruct", "cerebras"],
    ];

    const out = [];
    out.push("provider | model | vision | ctx | koneksi aktif?");
    out.push("-".repeat(80));
    for (const [alias, model, prov] of CANDIDATES) {
      const c = getCapabilitiesForModel(prov, model);
      const hasConn = activeProviders.has(prov);
      out.push(
        `${alias.padEnd(8)} | ${model.padEnd(34)} | ${String(c.vision).padEnd(5)} | ${String(c.contextWindow).padStart(7)} | ${hasConn ? "ya" : "TIDAK"}`
      );
    }

    out.push("");
    out.push("=== provider aktif (punya koneksi) ===");
    out.push([...activeProviders].filter((p) => !p.startsWith("openai-compatible")).join(", "));

    const txt = out.join("\n");
    writeFileSync("C:/Users/Developer/9router-fix/vision-combo-candidates.txt", txt);
    console.log(txt);
  }, 120000);
});
