/**
 * Relay proxy: header TIDAK boleh hilang saat disebar.
 *
 * Bug upstream (decolua/9router 6af26a9e): `{...headers}` pada instance
 * Headers menghasilkan objek KOSONG, sehingga Authorization dan Content-Type
 * hilang saat request diteruskan lewat relay Vercel/Cloudflare/Deno — relay
 * membalas 401.
 *
 * Diverifikasi di Node: `Object.keys({...new Headers({a:1})}).length === 0`.
 *
 * Di fork belum ada executor yang mengirim instance Headers ke proxyAwareFetch
 * (buildHeaders mengembalikan objek biasa), jadi ini pencegahan laten — tapi
 * tetap dikunci supaya executor baru tidak terjebak.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(here, "../../open-sse/utils/proxyFetch.js"), "utf8");

describe("proxyFetch — normalisasi header relay", () => {
  it("membuktikan bug dasar: spread instance Headers jadi kosong", () => {
    const h = new Headers({ authorization: "Bearer t", "content-type": "application/json" });
    expect(Object.keys({ ...h })).toHaveLength(0);
    // Objek biasa tidak bermasalah — inilah bedanya.
    expect(Object.keys({ ...{ authorization: "Bearer t" } })).toHaveLength(1);
  });

  it("proxyFetch punya helper normalisasi", () => {
    expect(SRC).toMatch(/function normalizeHeadersToObject\(/);
    // Menangani Headers instance lewat .entries()
    expect(SRC).toContain(".entries()");
    // Menangani array pasangan
    expect(SRC).toContain("Array.isArray(headers)");
  });

  it("relay memakai helper, bukan spread mentah", () => {
    const relay = SRC.slice(SRC.indexOf("const vercelRelayUrl"), SRC.indexOf("x-relay-path"));
    expect(relay).toContain("normalizeHeadersToObject(options.headers)");
    // Pola lama yang berbahaya tidak boleh kembali.
    expect(relay).not.toMatch(/\.\.\.options\.headers/);
  });
});
