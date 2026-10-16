/**
 * Daftarkan kunci MiMo Token Plan ke provider yang BENAR: `xiaomi-tokenplan`.
 *
 * Koreksi penting: sebelumnya kunci ini didaftarkan ke `xiaomi-mimo` — itu
 * provider BERBEDA (platform pay-as-you-go, api.xiaomimimo.com). Token Plan
 * punya provider sendiri (`xiaomi-tokenplan`, alias `xmtp`) yang menunjuk ke
 * token-plan-<region>.xiaomimimo.com. Kunci Token Plan ditolak di endpoint
 * platform dan sebaliknya.
 *
 * Jalankan: npx vitest run unit/add-mimo-token-plan.test.js
 */
import { describe, it, expect } from "vitest";

const API_KEY = "sk-sbzhozstb1svh0kp7sumpnrruollx0i1yk9azrc1bps9uk7m";
const TOKENPLAN = "xiaomi-tokenplan";
const PLATFORM = "xiaomi-mimo";
const REGION = "sgp";

describe("koneksi MiMo Token Plan (provider yang benar)", () => {
  it("pasang di xiaomi-tokenplan, bersihkan yang salah di xiaomi-mimo", async () => {
    const { getProviderConnections, createProviderConnection, updateProviderConnection, deleteProviderConnection } =
      await import("../../src/lib/db/repos/connectionsRepo.js");

    // 1. Buang koneksi yang salah tempat (xiaomi-mimo memakai kunci Token Plan).
    const wrong = await getProviderConnections({ provider: PLATFORM });
    for (const c of wrong) {
      if (c.apiKey === API_KEY) {
        if (typeof deleteProviderConnection === "function") {
          await deleteProviderConnection(c.id);
          console.log(`dihapus dari ${PLATFORM} (salah provider): ${c.id}`);
        } else {
          await updateProviderConnection(c.id, { isActive: false });
          console.log(`dinonaktifkan di ${PLATFORM} (salah provider): ${c.id}`);
        }
      }
    }

    // 2. Pasang di provider yang benar.
    const existing = await getProviderConnections({ provider: TOKENPLAN });
    const same = existing.find((c) => c.apiKey === API_KEY);
    if (same) {
      await updateProviderConnection(same.id, {
        isActive: true,
        providerSpecificData: { ...(same.providerSpecificData || {}), region: REGION },
      });
      console.log(`sudah ada di ${TOKENPLAN}: ${same.id} — diaktifkan`);
      expect(same.apiKey).toBe(API_KEY);
      return;
    }

    const conn = await createProviderConnection({
      provider: TOKENPLAN,
      authType: "apikey",
      name: "MiMo Token Plan Lite",
      apiKey: API_KEY,
      priority: 1,
      providerSpecificData: { region: REGION },
      isActive: true,
      testStatus: "unknown",
    });

    console.log("dibuat:", conn.id, "| provider:", TOKENPLAN, "| region:", REGION);
    const after = await getProviderConnections({ provider: TOKENPLAN });
    const found = after.find((c) => c.id === conn.id);
    expect(found, "koneksi tidak ditemukan setelah dibuat").toBeTruthy();
    expect(found.apiKey).toBe(API_KEY);
    console.log(`total ${TOKENPLAN}: ${after.length}`);
  }, 60000);
});
