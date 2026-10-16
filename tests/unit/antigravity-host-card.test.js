/**
 * Guard: dropdown pemilih host Antigravity harus terisi.
 *
 * Kejadian nyata (2026-09-20): kartu "Host Antigravity" tampil di dashboard
 * tetapi dropdown-nya KOSONG — tidak ada satu pun pilihan mode. Penyebabnya:
 * komponen `Select` milik 9Router BUKAN <select> native. Ia menerima prop
 * `options=[{value,label}]` dan mengabaikan `children` sepenuhnya (children
 * di-override oleh JSX internalnya), jadi `<Select><option/></Select>` yang
 * mengikuti kebiasaan HTML tidak merender apa pun.
 *
 * Tujuh pemakaian Select lain di dashboard semuanya memakai `options=`.
 *
 * Test ini membaca sumber komponen (bukan render React) supaya murah dan
 * langsung menunjuk kontrak yang salah.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CARD = resolve(here, "../../src/app/(dashboard)/dashboard/providers/[id]/AntigravityHostCard.js");
const SELECT = resolve(here, "../../src/shared/components/Select.js");

const card = readFileSync(CARD, "utf8");
const select = readFileSync(SELECT, "utf8");

describe("AntigravityHostCard — dropdown mode host", () => {
  it("komponen Select memang mengabaikan children (dasar regresi)", () => {
    // Kalau suatu hari Select diubah untuk menghormati children, test ini
    // memberi tahu bahwa alasan di balik `options=` sudah tidak berlaku.
    expect(select).toContain("options = []");
    expect(select).toContain("options.map");
    // Tidak ada penyebaran children ke <select>.
    expect(select).not.toMatch(/children/);
  });

  it("kartu meneruskan pilihan lewat prop `options`, bukan <option> anak", () => {
    const selectBlock = card.slice(card.indexOf("<Select"));
    const end = selectBlock.indexOf("/>");
    expect(end, "Select harus self-closing (tanpa children)").toBeGreaterThan(-1);

    const block = selectBlock.slice(0, end);
    expect(block).toContain("options=");
    expect(block).not.toContain("<option");
  });

  it("kartu TIDAK memakai bentuk HTML native <Select>...</Select>", () => {
    expect(card).not.toMatch(/<Select[\s\S]*?<\/Select>/);
  });

  it("setiap preset punya value dan label untuk dipetakan ke options", () => {
    // options= butuh {value,label}; kalau PRESETS kehilangan salah satunya,
    // dropdown kembali kosong tanpa error apa pun.
    const presetsBlock = card.slice(card.indexOf("const PRESETS"), card.indexOf("export default"));
    const values = [...presetsBlock.matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]);
    const labels = [...presetsBlock.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(labels.length).toBe(values.length);
    expect(values).toContain("daily-only");
    expect(values).toContain("all-hosts");
  });

  it("state awal dropdown cocok dengan default engine (all-hosts)", () => {
    expect(card).toContain('useState("all-hosts")');
    // Fallback saat /api/settings belum punya antigravityHostMode.
    expect(card).toContain('s?.antigravityHostMode || "all-hosts"');
  });
});
