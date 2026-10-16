/**
 * Menu Automation: menjaga jalur device-code tetap sepakat dengan jalur OAuth
 * yang sudah ada.
 *
 * ── Kenapa tes ini ada ──────────────────────────────────────────────────────
 *
 * `src/lib/automation/deviceFlow.js` menyalin logika bercabang dari
 * `src/app/api/oauth/[provider]/[action]/route.js`, dan `src/lib/automation/
 * providers.js` menyalin daftar `NO_PKCE_DEVICE_PROVIDERS` dari dua tempat
 * (`route.js` dan `shared/components/OAuthModal.js`).
 *
 * Duplikasi itu disengaja — jalur Automation digerbangi password, jalur OAuth
 * tidak, jadi keduanya butuh rute sendiri. Tapi duplikasi yang tidak dijaga
 * akan menyimpang, dan cara menyimpangnya paling menyakitkan: menambah provider
 * di satu tempat lalu lupa di tempat lain, sehingga permintaan device-code
 * dikirim TANPA PKCE challenge (atau dengan) ke provider yang mengharapkan
 * sebaliknya. Yang terlihat bukan galat di sini, melainkan kegagalan upstream
 * SETELAH operator sudah susah payah menyetujui di browser.
 *
 * Tes ini membandingkan ketiga sumber, bukan menguji satu per satu.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");

const read = (p) => readFileSync(resolve(REPO, p), "utf8");

const OAUTH_ROUTE = read("src/app/api/oauth/[provider]/[action]/route.js");
const OAUTH_MODAL = read("src/shared/components/OAuthModal.js");
const AUTOMATION_PROVIDERS = read("src/lib/automation/providers.js");
const GATE = read("src/lib/automation/gate.js");

/** Ambil isi array literal `const NAME = [ "a", "b", ... ];` dari sebuah berkas. */
function arrayLiteral(source, name) {
  const m = source.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^".*"$/.test(s))
    .map((s) => s.slice(1, -1));
}

/**
 * Ambil isi `new Set([ "a", ... ])`. Bentuknya beda dari arrayLiteral — kalau
 * dipaksa lewat arrayLiteral, hasilnya termasuk string `new Set(` sehingga
 * perbandingan set selalu gagal meski isinya sama.
 */
function setLiteral(source, name) {
  const m = source.match(new RegExp(`${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^".*"$/.test(s))
    .map((s) => s.slice(1, -1));
}

describe("automation — daftar provider device-code sepakat", () => {
  it("daftar no-PKCE di Automation sama dengan di route OAuth", () => {
    const fromAutomation = setLiteral(AUTOMATION_PROVIDERS, "NO_PKCE_DEVICE_PROVIDERS");
    // Di route OAuth daftarnya array biasa, bukan Set.
    const fromRoute = arrayLiteral(OAUTH_ROUTE, "noPkceDeviceProviders");

    expect(fromAutomation, "NO_PKCE_DEVICE_PROVIDERS tidak ditemukan di providers.js").not.toBeNull();
    expect(fromRoute, "noPkceDeviceProviders tidak ditemukan di route OAuth").not.toBeNull();
    expect(fromAutomation.sort()).toEqual([...fromRoute].sort());
  });

  it("setiap provider Automation benar-benar dikenal jalur OAuth", () => {
    // Provider yang tampil di menu tapi tidak ada di daftar device-code modal
    // akan memulai alur dengan `authUrl: null` dan gagal setelah operator
    // menekan tombol. Yang dikecualikan harus terdaftar eksplisit, supaya
    // pengecualiannya terlihat saat ditinjau — bukan tersembunyi di dalam tes.
    const modalList = arrayLiteral(OAUTH_MODAL, "deviceCodeProviders");
    expect(modalList, "deviceCodeProviders tidak ditemukan di OAuthModal").not.toBeNull();

    const exempt = setLiteral(AUTOMATION_PROVIDERS, "WIRED_ONLY_IN_AUTOMATION") || [];
    const catalogueIds = [...AUTOMATION_PROVIDERS.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(catalogueIds.length).toBeGreaterThan(0);

    for (const id of catalogueIds) {
      if (exempt.includes(id)) continue;
      expect(
        modalList.includes(id),
        `${id} ada di katalog Automation tapi tidak ter-wire di OAuthModal, dan tidak terdaftar di WIRED_ONLY_IN_AUTOMATION`,
      ).toBe(true);
    }
  });

  it("provider yang dikecualikan punya requestDeviceCode + pollToken di registry", () => {
    // Pengecualian hanya boleh diberikan kalau registry membuktikan
    // kemampuannya. Tanpa pemeriksaan ini, menambah nama ke daftar pengecualian
    // cukup untuk membuat menu menawarkan provider yang tidak bisa apa-apa.
    const exempt = setLiteral(AUTOMATION_PROVIDERS, "WIRED_ONLY_IN_AUTOMATION") || [];
    for (const id of exempt) {
      const src = read(`src/lib/oauth/providers/${id}.js`);
      expect(src, `${id} tidak punya requestDeviceCode`).toContain("requestDeviceCode");
      expect(src, `${id} tidak punya pollToken`).toContain("pollToken");
      expect(src, `${id} bukan flowType device_code`).toMatch(/flowType:\s*"device_code"/);
    }
  });

  it("katalog Automation hanya menawarkan provider device_code", () => {
    // Provider non-device-code harus dibuang route /api/automation/providers.
    // Kalau filter itu hilang, menu akan menawarkan tombol yang selalu gagal.
    const ROUTE = read("src/app/api/automation/providers/route.js");
    expect(ROUTE).toMatch(/flowType\s*===\s*"device_code"/);
  });
});

describe("automation — gerbang password", () => {
  it("setiap route automation dibungkus requireGate", () => {
    // Route baru yang ditambahkan tanpa gerbang adalah cara paling mudah
    // membuat gerbang ini tidak berguna. Tes ini gagal kalau ada yang lupa.
    //
    // Daftarnya DIBACA dari disk, bukan ditulis tangan: daftar yang ditulis
    // tangan akan diam-diam ketinggalan setiap kali route baru ditambahkan —
    // dan justru route baru itulah yang paling mungkin lupa dibungkus.
    const automationDir = resolve(REPO, "src/app/api/automation");
    const routes = [];
    (function walk(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === "route.js") routes.push(full);
      }
    })(automationDir);

    expect(routes.length, "tidak ada route automation yang ditemukan").toBeGreaterThan(3);

    /**
     * Route yang MEMBUKA gerbang, bukan yang dijaganya.
     *
     * `gate/route.js` harus bisa diakses justru saat gerbang masih tertutup —
     * membungkusnya dengan `requireGate` membuatnya mustahil dibuka sama sekali.
     * Ia tetap punya pengamannya sendiri: password dibandingkan dengan
     * `timingSafeEqual` (lihat tes di bawah).
     */
    const PEMBUKA_GERBANG = new Set(["gate/route.js"]);

    for (const r of routes) {
      const rel = r.replace(REPO, "").replace(/\\/g, "/").replace(/^\//, "");
      if ([...PEMBUKA_GERBANG].some((x) => rel.endsWith(x))) continue;

      const src = readFileSync(r, "utf8");
      expect(src, `${rel} tidak mengimpor requireGate`).toContain("requireGate");
      const exported = src.match(/export const (GET|POST|DELETE|PUT)\s*=\s*([^\n]+)/g) || [];
      expect(exported.length, `${rel} tidak mengekspor handler`).toBeGreaterThan(0);
      for (const line of exported) {
        expect(line, `handler di ${rel} tidak dibungkus requireGate: ${line}`).toContain("requireGate");
      }
    }
  });

  it("password tidak pernah dibandingkan dengan == atau ===", () => {
    // Perbandingan string biasa berhenti di karakter pertama yang berbeda,
    // sehingga waktu jawabnya membocorkan berapa huruf awal yang benar.
    expect(GATE).toContain("timingSafeEqual");
    expect(GATE).not.toMatch(/input\s*===\s*expectedPassword|expectedPassword\(\)\s*===/);
  });

  it("password tidak ditulis ke respons mana pun", () => {
    // Gerbang yang mengembalikan passwordnya sendiri di pesan galat lebih buruk
    // daripada tidak ada gerbang.
    const GATE_ROUTE = read("src/app/api/automation/gate/route.js");
    expect(GATE_ROUTE).not.toMatch(/password:\s*(expected|FALLBACK)/);
  });
});
