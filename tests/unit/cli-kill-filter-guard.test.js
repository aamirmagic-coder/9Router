/**
 * CLI: penapis killAllAppProcesses tidak boleh membunuh proses asing,
 * dan tray hasil spawn tidak boleh memindai ulang.
 *
 * Dua bug nyata (2026-09-22) yang membuat 9Router "tiba-tiba berhenti":
 *
 * 1. `|| cmd.includes("next-server")` TANPA syarat lain. Setiap proses
 *    Next.js mana pun di mesin yang sama ikut di-taskkill /F. 9Router
 *    standalone sendiri tidak memakai nama itu (ia menjalankan
 *    app/custom-server.js), jadi cabang itu hanya merugikan.
 *
 * 2. Menu "background" menjalankan spawn(tray) lalu cleanup() hampir
 *    bersamaan. Proses tray juga memanggil killAllAppProcesses di startup,
 *    jadi keduanya saling membunuh dalam jendela yang sama — server mati,
 *    tray mati, tidak ada yang restart. Diperbaiki dengan --skip-kill.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = readFileSync(resolve(here, "../../cli/cli.js"), "utf8");

/** Buang komentar supaya pola lama di dokumentasi tidak ikut terhitung. */
function stripComments(src) {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("CLI — penapis kill", () => {
  it("TIDAK ada lagi cabang 'next-server' tanpa syarat", () => {
    const code = stripComments(cli);
    // Pola lama: `|| cmd.includes("next-server")`
    expect(code).not.toMatch(/\|\|\s*cmd\.includes\("next-server"\)/);
  });

  it("penapis mewajibkan '9router' pada kedua cabang platform", () => {
    const code = stripComments(cli);
    const filters = [...code.matchAll(/const isAppProcess\s*=\s*([\s\S]*?);/g)].map((m) => m[1]);
    expect(filters.length).toBeGreaterThanOrEqual(2); // win32 + posix
    for (const f of filters) {
      expect(f).toContain("9router");
      expect(f).toContain("node");
    }
  });

  it("penapis mengenali custom-server.js (proses server 9router standalone)", () => {
    const code = stripComments(cli);
    expect(code).toContain("custom-server.js");
  });

  it("--skip-kill dideklarasikan dan dilewati dari pemindaian", () => {
    const code = stripComments(cli);
    expect(code).toMatch(/let skipKill = false/);
    expect(code).toMatch(/args\[i\] === "--skip-kill"/);
    // Jalur startup harus bercabang: skipKill -> langsung startServer.
    expect(code).toMatch(/if \(skipKill\) \{\s*startServer\(updatePromise\);/);
  });

  it("spawn tray memakai --skip-kill", () => {
    const code = stripComments(cli);
    const spawnCall = code.slice(code.indexOf("const bgProcess = spawn("));
    const args = spawnCall.slice(0, spawnCall.indexOf("});"));
    expect(args).toContain("--skip-kill");
    expect(args).toContain("--tray");
  });

  it("server dimatikan SEBELUM spawn tray, bukan sesudah", () => {
    const code = stripComments(cli);
    const spawnIdx = code.indexOf("const bgProcess = spawn(");
    const cleanupIdx = code.lastIndexOf("cleanup();", spawnIdx);
    expect(cleanupIdx, "cleanup() harus dipanggil sebelum spawn tray").toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(spawnIdx);
  });
});

describe("CLI — server tidak boleh mati karena error UI", () => {
  it("catch pada loop menu tidak memanggil cleanup()/exit", () => {
    const code = stripComments(cli);
    const catchIdx = code.indexOf("Menu error:");
    expect(catchIdx, "catch menu harus menandai errornya dengan jelas").toBeGreaterThan(-1);
    // Blok catch menu: dari '} catch (err) {' sampai awal blok berikutnya.
    const start = code.lastIndexOf("} catch (err) {", catchIdx);
    const end = code.indexOf("showInterfaceMenu", catchIdx); // batas aman berikutnya
    const block = code.slice(start, end > start ? end : catchIdx + 400);
    expect(block.length).toBeGreaterThan(0);
    expect(block, "catch menu tidak boleh membunuh server").not.toMatch(/cleanup\(\)/);
    expect(block).not.toMatch(/process\.exit/);
  });

  it("setiap restart meninggalkan jejak di berkas log", () => {
    const code = stripComments(cli);
    expect(code).toMatch(/function logCrash\(/);
    expect(code).toContain("server-restarts.log");
    // tryRestart harus memanggilnya SEBELUM keputusan restart apa pun.
    const tryIdx = code.indexOf("function tryRestart(");
    const body = code.slice(tryIdx, tryIdx + 300);
    expect(body).toContain("logCrash(code, aliveMs)");
  });
});
