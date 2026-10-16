/**
 * REGRESI: setiap item menu "Choose Interface" harus menghasilkan aksinya sendiri.
 *
 * Bug yang dikunci (v0.5.113):
 *   Menu punya 4 item tanpa update — Web UI (0), Terminal UI (1),
 *   Hide to Tray (2), Exit (3). Tapi pembacaannya memakai `offset + N`
 *   hardcoded dan TIDAK ADA cabang untuk indeks 3 ("Exit"). Memilih Exit
 *   mengembalikan "back" → menu muncul lagi, server tidak pernah mati.
 *   Gejala di lapangan: opsi "Exit" dan "Hide to Tray" tampak tidak berfungsi.
 *
 * Logika diuji langsung dari modul murni `cli/src/cli/utils/interfaceMenu.js`
 * — bukan dari cli.js, yang mengeksekusi dirinya di module scope (startServer,
 * bahkan process.exit) sehingga tidak bisa di-require dari test.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildInterfaceMenuItems, resolveMenuAction } = require("../../cli/src/cli/utils/interfaceMenu.js");

const VER = "0.5.113";

describe("menu Choose Interface", () => {
  describe("buildInterfaceMenuItems", () => {
    it("tanpa update: 4 item dengan aksi yang benar", () => {
      const items = buildInterfaceMenuItems(null, VER);
      expect(items.map((i) => i.action)).toEqual(["web", "terminal", "hide", "exit"]);
    });

    it("dengan update: 5 item, update di paling atas", () => {
      const items = buildInterfaceMenuItems("9.9.9", VER);
      expect(items.map((i) => i.action)).toEqual(["update", "web", "terminal", "hide", "exit"]);
    });

    it("setiap item punya label dan icon", () => {
      for (const item of buildInterfaceMenuItems(null, VER)) {
        expect(item.label, `label kosong untuk ${item.action}`).toBeTruthy();
        expect(item.icon, `icon kosong untuk ${item.action}`).toBeTruthy();
      }
    });

    it("label update menyebut versi saat ini", () => {
      const items = buildInterfaceMenuItems("9.9.9", VER);
      expect(items[0].label).toContain("9.9.9");
      expect(items[0].label).toContain(VER);
    });
  });

  describe("resolveMenuAction", () => {
    it("tanpa update: setiap indeks menghasilkan aksinya", () => {
      const harapan = ["web", "terminal", "hide", "exit"];
      harapan.forEach((aksi, i) => {
        expect(resolveMenuAction(i, null, VER), `indeks ${i}`).toBe(aksi);
      });
    });

    it("dengan update: setiap indeks menghasilkan aksinya", () => {
      const harapan = ["update", "web", "terminal", "hide", "exit"];
      harapan.forEach((aksi, i) => {
        expect(resolveMenuAction(i, "9.9.9", VER), `indeks ${i}`).toBe(aksi);
      });
    });

    it("'Exit' TIDAK PERNAH mengembalikan 'back' (inti bug v0.5.112)", () => {
      // Tanpa update, Exit = indeks 3
      expect(resolveMenuAction(3, null, VER)).toBe("exit");
      // Dengan update, Exit = indeks 4
      expect(resolveMenuAction(4, "9.9.9", VER)).toBe("exit");
    });

    it("'Hide to Tray' menghasilkan 'hide', bukan 'back'", () => {
      expect(resolveMenuAction(2, null, VER)).toBe("hide");
      expect(resolveMenuAction(3, "9.9.9", VER)).toBe("hide");
    });

    it("ESC (-1) tetap 'back', BUKAN 'exit' — server tidak boleh mati", () => {
      // Ini perilaku yang sengaja dipertahankan: ESC dan stdin non-TTY sama-sama
      // mengembalikan -1, dan keduanya TIDAK boleh mematikan gateway.
      expect(resolveMenuAction(-1, null, VER)).toBe("back");
      expect(resolveMenuAction(-1, "9.9.9", VER)).toBe("back");
    });

    it("indeks di luar jangkauan tetap 'back', bukan 'exit'", () => {
      expect(resolveMenuAction(99, null, VER)).toBe("back");
      expect(resolveMenuAction(99, "9.9.9", VER)).toBe("back");
      expect(resolveMenuAction(-5, null, VER)).toBe("back");
    });
  });
});
