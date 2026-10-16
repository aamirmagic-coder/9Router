/**
 * REGRESI: "Hide to Tray" tidak boleh mematikan gateway.
 *
 * Bug yang dikunci (v0.5.114):
 *   Menu "Hide to Tray" membunuh server lalu men-spawn proses tray yang
 *   menyalakannya kembali. Tapi urutannya:
 *
 *     isShuttingDown = true;
 *     cleanup();                          ← SIGKILL server
 *     await killProcessOnPort(port);      ← melepas kontrol ke event loop
 *                                         ← event "close" menyala DI SINI
 *     spawn(... tray ...);                ← TIDAK PERNAH TERCAPAI
 *
 *   Handler "close" melihat isShuttingDown === true lalu memanggil
 *   process.exit(). CLI mati SEBELUM men-spawn tray — jadi server sudah
 *   dibunuh dan tidak ada yang menyalakannya lagi. Gateway mati total.
 *
 * Dua hal yang diuji:
 *   1. Ada penjagaan `isHandingOff` yang TERPISAH dari isShuttingDown, dan
 *      diperiksa SEBELUM cabang isShuttingDown di kedua handler.
 *   2. Penjagaan itu diset SEBELUM cleanup() dipanggil di jalur hide, supaya
 *      event "close" yang asinkron sudah menemukannya.
 *
 * Ditambah: verifikasi ada jalur pemulihan kalau tray gagal start.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../cli/cli.js");
const src = readFileSync(CLI, "utf8");

/** Buang komentar supaya pencocokan tidak kena teks penjelas. */
function kode(s) {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Hide to Tray — CLI tidak boleh mati sebelum tray di-spawn", () => {
  it("flag isHandingOff dideklarasikan", () => {
    expect(src).toMatch(/let isHandingOff = false/);
  });

  it("handler 'close' memeriksa isHandingOff SEBELUM isShuttingDown", () => {
    const fn = src.slice(src.indexOf("function attachServerEvents"), src.indexOf("async function disableMitmInDb"));
    const body = kode(fn);
    const idxHandoff = body.indexOf("isHandingOff");
    const idxShutdown = body.indexOf("isShuttingDown");
    expect(idxHandoff, "isHandingOff harus ada di attachServerEvents").toBeGreaterThan(-1);
    expect(idxShutdown, "isShuttingDown harus ada di attachServerEvents").toBeGreaterThan(-1);
    expect(
      idxHandoff,
      "penjagaan isHandingOff harus diperiksa SEBELUM isShuttingDown — kalau terbalik, process.exit() tetap jalan lebih dulu"
    ).toBeLessThan(idxShutdown);
  });

  it("kedua handler (error & close) punya penjagaan isHandingOff", () => {
    const fn = src.slice(src.indexOf("function attachServerEvents"), src.indexOf("async function disableMitmInDb"));
    const body = kode(fn);
    const jumlah = (body.match(/if \(isHandingOff\) return;/g) || []).length;
    expect(jumlah, "handler error DAN close masing-masing butuh penjagaan").toBe(2);
  });

  it("isHandingOff diset SEBELUM cleanup() di jalur hide", () => {
    const idxHide = src.indexOf('console.log(`\\n⏳ Switching to background...`)');
    expect(idxHide, "pesan 'Switching to background' harus ada").toBeGreaterThan(-1);
    const blok = kode(src.slice(idxHide, idxHide + 1200));
    const idxHandoff = blok.indexOf("isHandingOff = true");
    const idxCleanup = blok.indexOf("cleanup()");
    expect(idxHandoff, "isHandingOff = true harus ada di jalur hide").toBeGreaterThan(-1);
    expect(idxCleanup, "cleanup() harus ada di jalur hide").toBeGreaterThan(-1);
    expect(
      idxHandoff,
      "isHandingOff harus diset SEBELUM cleanup() — event close menyala asinkron tepat setelah SIGKILL"
    ).toBeLessThan(idxCleanup);
  });

  it("ada verifikasi bahwa tray benar-benar menyalakan server", () => {
    // Tanpa ini, kegagalan tray meninggalkan pengguna dengan gateway mati
    // tanpa pesan apa pun.
    const idxHide = src.indexOf('console.log(`\\n⏳ Switching to background...`)');
    const blok = src.slice(idxHide, idxHide + 3000);
    expect(blok, "harus menunggu server siap setelah spawn tray").toMatch(/waitServerReady\(port/);
    expect(blok, "harus ada jalur pemulihan kalau tray gagal").toMatch(/isHandingOff = false/);
  });

  it("'Exit' tetap mematikan server (perilaku yang diinginkan, jangan ikut berubah)", () => {
    // Jalur exit TIDAK boleh ikut memakai isHandingOff — di sana kita memang
    // ingin CLI keluar dan server mati.
    const idxExit = src.indexOf('} else if (choice === "exit")');
    expect(idxExit, "cabang 'exit' harus ada").toBeGreaterThan(-1);
    const blok = kode(src.slice(idxExit, idxExit + 400));
    expect(blok, "jalur exit tidak boleh menyetel isHandingOff").not.toMatch(/isHandingOff = true/);
    expect(blok, "jalur exit harus tetap memanggil cleanup()").toMatch(/cleanup\(\)/);
  });
});
