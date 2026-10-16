/**
 * Buat Combo "vision" — selalu memprioritaskan model yang bisa baca gambar.
 *
 * Latar: model utama user (ag/claude-opus-4-6-thinking) SEBENARNYA sudah bisa
 * vision, jadi Vision Adapter tidak pernah menyala untuknya. Kalau user ingin
 * gambar SELALU lewat model tertentu, itu harus Combo — urutan model yang
 * ditentukan sendiri, bukan adapter otomatis.
 *
 * Urutan dipilih: Token Plan dulu (kuota langganan, tidak menyentuh saldo),
 * lalu Antigravity sebagai cadangan.
 */
import { describe, it, expect } from "vitest";

const NAME = "vision";
const MODELS = [
  "xmtp/mimo-v2.6-pro",           // MiMo Token Plan — vision, kuota langganan
  "ag/claude-opus-4-6-thinking",  // Antigravity Opus — vision, 1M konteks
  "ag/gemini-3.8-flash-high",     // Antigravity Gemini — vision, cepat
  "ag/gemini-3.8-flash-medium",   // cadangan (tiered tidak ada di registry)
];

describe("Combo vision", () => {
  it("membuat combo dengan model vision berurutan", async () => {
    const { createCombo, getComboByName } = await import("../../src/lib/db/repos/combosRepo.js");
    const { isValidModel } = await import("../../open-sse/config/providerModels.js");

    // Pastikan setiap model benar-benar bisa di-resolve sebelum dipasang.
    for (const m of MODELS) {
      const [alias, ...rest] = m.split("/");
      const modelId = rest.join("/");
      expect(isValidModel(alias, modelId), `${m} tidak resolve`).toBe(true);
    }

    const existing = await getComboByName(NAME);
    if (existing) {
      console.log(`sudah ada: ${existing.id} | ${JSON.stringify(existing.models)}`);
      expect(existing.name).toBe(NAME);
      return;
    }

    const c = await createCombo({ name: NAME, models: MODELS, kind: null });
    console.log(`dibuat: ${c.id}`);
    console.log(`nama  : ${c.name}`);
    console.log(`model :`);
    for (const [i, m] of c.models.entries()) console.log(`  ${i + 1}. ${m}`);

    const after = await getComboByName(NAME);
    expect(after, "combo tidak ditemukan setelah dibuat").toBeTruthy();
    expect(after.models).toEqual(MODELS);
  }, 60000);
});
