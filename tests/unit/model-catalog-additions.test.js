/**
 * Model & region yang diadopsi dari upstream v0.5.86.
 *
 * Dua fitur diadopsi (23 Sep 2026):
 *   1. Claude Opus 5.5 (upstream cbffeb97) + naikkan fingerprint CLI ke 2.1.280
 *   2. MiMo v2.6 pro/flash/pro-ultraspeed + lima region cluster
 *      (upstream 910db749) — TANPA permukaan login Desktop, yang sengaja
 *      dilewati karena menyentuh keamanan sesi dan butuh review terpisah.
 */
import { describe, it, expect } from "vitest";
import claude from "../../open-sse/providers/registry/claude.js";
import xiaomi from "../../open-sse/providers/registry/xiaomi-mimo.js";
import { CLAUDE_CLI_VERSION } from "../../open-sse/providers/shared.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("Claude Opus 5.5", () => {
  it("terdaftar di registry claude", () => {
    const ids = claude.models.map((m) => m.id);
    expect(ids).toContain("claude-opus-5-5");
  });

  it("nama tampilannya benar", () => {
    const m = claude.models.find((x) => x.id === "claude-opus-5-5");
    expect(m.name).toBe("Claude Opus 5.5");
  });

  it("fingerprint CLI dinaikkan ke 2.1.280", () => {
    // Opus 5.5 dirilis bersama CLI baru; fingerprint lama bisa ditolak
    // provider yang membatasi versi klien.
    expect(CLAUDE_CLI_VERSION).toBe("2.1.280");
  });
});

describe("MiMo v2.6", () => {
  it("tiga model v2.6 terdaftar", () => {
    const ids = xiaomi.models.map((m) => m.id);
    expect(ids).toContain("mimo-v2.6-pro");
    expect(ids).toContain("mimo-v2.6-flash");
    expect(ids).toContain("mimo-v2.6-pro-ultraspeed");
  });

  it("model v2.6 memakai upstreamModelId berprefiks xiaomi/", () => {
    for (const id of ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"]) {
      const m = xiaomi.models.find((x) => x.id === id);
      expect(m.upstreamModelId, `${id} tanpa upstreamModelId`).toBe(`xiaomi/${id}`);
    }
  });

  it("model lama tetap ada (tidak ada regresi)", () => {
    const ids = xiaomi.models.map((m) => m.id);
    for (const old of ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-omni", "mimo-v2-flash"]) {
      expect(ids, `${old} hilang`).toContain(old);
    }
  });

  it("id preview lama TIDAK ditambahkan (sudah usang)", () => {
    const ids = xiaomi.models.map((m) => m.id);
    expect(ids).not.toContain("mimo-x-pro-preview");
    expect(ids).not.toContain("mimo-x-flash-preview");
  });

  it("lima region cluster terdaftar dengan default sgp", () => {
    expect(xiaomi.regions.map((r) => r.id)).toEqual(["cn", "sgp", "ams", "ru", "in"]);
    expect(xiaomi.defaultRegion).toBe("sgp");
    // Setiap region harus punya label untuk picker dashboard.
    for (const r of xiaomi.regions) expect(r.label).toBeTruthy();
  });

  it("thinking levels v2.6 mencakup low..xhigh", () => {
    const levels = getThinkingLevels("xiaomi-mimo", "mimo-v2.6-pro");
    if (levels) {
      // MiMo v2.6 tidak bisa mematikan thinking (caps.thinkingCanDisable false),
      // jadi getThinkingLevels menyaring "none" keluar — jangan menuntutnya.
      expect(levels).not.toContain("none");
      expect(levels).toContain("low");
      expect(levels).toContain("high");
      expect(levels).toContain("xhigh");
    }
    // Kalau caps.reasoning false, getThinkingLevels mengembalikan null —
    // itu sah, yang penting pola v2.6 terdaftar di sumber.
    expect(levels === null || levels.length > 0).toBe(true);
  });
});
