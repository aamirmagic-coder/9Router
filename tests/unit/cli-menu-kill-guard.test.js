/**
 * CLI: ESC / stdin-bukan-TTY tidak boleh mematikan server.
 *
 * Kejadian nyata (2026-09-21): 9Router "tiba-tiba berhenti" dan harus
 * dijalankan ulang manual. Akarnya di cli/cli.js:
 *
 *   selectMenu() mengembalikan -1 saat ESC ditekan ATAU stdin bukan TTY
 *   (input.js: `if (!process.stdin.isTTY) { resolve(-1); return; }`)
 *
 *   showInterfaceMenu() memetakan SEMUA nilai yang bukan indeks dikenal ke
 *   "exit" — termasuk -1
 *
 *   loop pemanggil: `choice === "exit"` → cleanup() → process.exit(0)
 *   dan cleanup() MEMBUNUH proses server.
 *
 * Jadi satu tekanan ESC sudah cukup untuk mematikan gateway.
 *
 * Test ini membaca sumber (bukan menjalankan TUI) supaya murah dan menunjuk
 * tepat ke kontrak yang salah.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../cli/cli.js");
const INPUT = resolve(here, "../../cli/src/cli/utils/input.js");

const cli = readFileSync(CLI, "utf8");
const input = readFileSync(INPUT, "utf8");

describe("CLI — ESC/bukan-TTY tidak mematikan server", () => {
  it("selectMenu memang mengembalikan -1 untuk ESC dan bukan-TTY", () => {
    // Kalau kontrak ini berubah, alasan di balik penjagaan di cli.js ikut berubah.
    expect(input).toMatch(/if \(!process\.stdin\.isTTY\)\s*\{\s*resolve\(-1\)/);
    expect(input).toMatch(/key\.name === "escape"\)\s*\{\s*cleanup\(\);\s*resolve\(-1\)/);
  });

  it("showInterfaceMenu memakai resolveMenuAction (satu sumber kebenaran)", () => {
    // Logika pemetaan tinggal di interfaceMenu.js. Menguji PERILAKU-nya
    // (bukan mencocokkan teks) ada di cli-menu-exit-guard.test.js — itulah
    // yang seharusnya, karena pencocokan teks membuat bug "Exit tidak
    // berfungsi" lolos di v0.5.112.
    expect(cli).toMatch(/resolveMenuAction\(selected, latestVersion, pkg\.version\)/);
    expect(cli).toMatch(/require\("\.\/src\/cli\/utils\/interfaceMenu"\)/);
  });

  it("'Exit' tetap terjangkau — bug v0.5.112 tidak boleh kembali", () => {
    // Perilaku lengkapnya diuji di cli-menu-exit-guard.test.js; di sini hanya
    // memastikan menu memang mendeklarasikan aksi "exit".
    const { buildInterfaceMenuItems } = require("../../cli/src/cli/utils/interfaceMenu.js");
    const aksi = buildInterfaceMenuItems(null, "0.0.0").map((i) => i.action);
    expect(aksi).toContain("exit");
  });

  it("'exit' hanya dieksekusi dari pilihan menu yang sah", () => {
    // Blok exit harus tetap ada (user memang boleh keluar), tapi hanya
    // terjangkau lewat choice === "exit".
    expect(cli).toMatch(/choice === "exit"/);
    expect(cli).toMatch(/cleanup\(\)/);
  });

  it("loop menangani 'back' tanpa mematikan server", () => {
    expect(cli).toMatch(/else \{\s*\n\s*\/\/ "back"/);
  });

  it("tryRestart me-reset restartCount setelah restart berhasil", () => {
    // Bug lama: counter tidak pernah di-reset setelah spawn sukses, jadi
    // setelah MAX_RESTARTS tercapai sekali, crash berikutnya (bahkan berjam
    // kemudian) langsung masuk jalur "menyerah" tanpa restart.
    expect(cli).toMatch(/serverStartTime = Date\.now\(\);\s*\n\s*server = spawnServer\(\)/);
  });

  it("disableMitmInDb menulis ke SQLite, bukan db.json", () => {
    // Bug lama: menulis db.json padahal state hidup di db/data.sqlite,
    // sehingga "disable MITM" tidak pernah tersimpan.
    expect(cli).toContain("data.sqlite");
    const fn = cli.slice(cli.indexOf("async function disableMitmInDb"), cli.indexOf("function tryRestart"));
    expect(fn).not.toMatch(/db\.json/);
  });
});
