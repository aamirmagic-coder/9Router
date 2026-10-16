/**
 * Katalog provider yang bisa ditambah lewat menu Automation.
 *
 * Daftar ini TIDAK mengarang kemampuan: setiap entri hanya boleh menunjuk
 * provider yang benar-benar ada di `src/lib/oauth/providers/` dan benar-benar
 * ter-wire di jalur device-code (lihat `deviceCodeProviders` di
 * `shared/components/OAuthModal.js` dan `noPkceDeviceProviders` di
 * `api/oauth/[provider]/[action]/route.js`). Menambahkan nama yang tidak ada di
 * kedua tempat itu menghasilkan menu yang tombolnya selalu gagal — lebih buruk
 * daripada tidak ada menu.
 *
 * ── Mengapa hanya device-code ───────────────────────────────────────────────
 *
 * Dua alur OAuth hidup di repo ini: authorization-code dengan popup browser
 * (botol port callback lokal), dan device-code. Yang kedua yang bisa
 * dipindahkan ke halaman: ia tidak butuh popup, tidak butuh port callback,
 * dan seluruh pertukarannya lewat fetch. Yang pertama butuh `window.open()`
 * dan pesan lintas-jendela — memindahkannya berarti menyalin `OAuthModal.js`
 * utuh, bukan membangun menu.
 *
 * `label` dan `hint` ditulis untuk operator yang tahu providernya tapi tidak
 * tahu langkah berikutnya.
 */
/**
 * Fokus: hanya device-code dari 7 provider yang dikelola menu Automation
 * (lihat catalogue.js). Provider device-code lain (kimi, codebuddy, qoder,
 * meta-code, github) tetap bisa ditambah dari halaman Providers — di sini
 * tidak ditawarkan supaya menu ini tetap sesuai cakupannya.
 */
export const AUTOMATION_PROVIDERS = [
  {
    id: "kiro",
    label: "Kiro",
    hint: "AWS Builder ID / IDC. Membutuhkan start URL kalau memakai IDC.",
    needsStartUrl: true,
  },
  { id: "grok-cli", label: "Grok CLI", hint: "Device code, tanpa PKCE." },
  { id: "kilocode", label: "Kilo Code", hint: "Device code, tanpa PKCE." },
];

export function isAutomationProvider(id) {
  return AUTOMATION_PROVIDERS.some((p) => p.id === id);
}

export function getAutomationProvider(id) {
  return AUTOMATION_PROVIDERS.find((p) => p.id === id) || null;
}

/**
 * Provider yang device-code-nya tidak memakai PKCE.
 *
 * Disalin dari `api/oauth/[provider]/[action]/route.js` dan
 * `OAuthModal.js` — ketiganya harus sepakat. Kalau sebuah provider pindah
 * kategori, memanggilnya dengan challenge yang tidak ia harapkan membuat
 * permintaan device-code gagal dengan pesan dari upstream, bukan dari sini.
 */
// Catatan: daftar ini harus tetap sama dengan noPkceDeviceProviders di
// src/app/api/oauth/[provider]/[action]/route.js — test
// unit/automation-device-flow.test.js mengunci kesamaan itu. "muse" dan "glm"
// ikut masuk bersama upstream v0.5.95 (Meta Muse + Z.ai OAuth). Jangan taruh
// komentar di dalam literal: helper test membaca isinya baris demi baris.
// Sync upstream v0.5.99: "nous" ditambahkan. Daftar ini WAJIB sama dengan
// noPkceProviders di api/oauth/[provider]/[action]/route.js — dijaga
// tests/unit/automation-device-flow.test.js.
export const NO_PKCE_DEVICE_PROVIDERS = new Set([
  "github",
  "kiro",
  "kimi",
  "kimi-coding",
  "kilocode",
  "codebuddy-cn",
  "codebuddy-intl",
  "qoder",
  "qoder-cn",
  "grok-cli",
  "meta-code",
  "muse",
  "glm",
  "nous",
]);

/**
 * Provider device-code yang jalur OAuth-nya belum ter-wire di
 * `OAuthModal.js`.
 *
 * `freebuff` punya `requestDeviceCode` dan `pollToken` sendiri di registry,
 * jadi alur device-code-nya jalan — tapi ia tidak ada di daftar
 * `deviceCodeProviders` milik modal, sehingga halaman Providers menolaknya
 * dengan "not wired in the OAuth modal device-code list". Menu Automation
 * memanggil registry langsung, jadi ia TIDAK terhalang batasan itu.
 *
 * Daftar ini ada supaya tes penjaga bisa membedakan "belum ter-wire, tapi
 * memang sengaja ditawarkan di sini" dari "provider yang tidak ada di mana pun"
 * — tanpa daftar ini, tes tidak bisa membedakan keduanya dan harus memilih
 * antara gagal palsu atau tidak memeriksa apa pun.
 *
 * Provider pindah ke sini HANYA kalau registry membuktikan kemampuannya:
 * `flowType === "device_code"` DAN ia punya `requestDeviceCode` + `pollToken`.
 */
export const WIRED_ONLY_IN_AUTOMATION = new Set(["freebuff"]);

/**
 * Provider yang respons device-code-nya harus dikembalikan sebagian ke
 * `pollForToken` sebagai `extraData`.
 *
 * Disalin dari `OAuthModal.js` (startPolling) — tanpa ini, Kiro kehilangan
 * clientId/clientSecret dan qoder kehilangan machineId, sehingga polling
 * gagal setelah operator sudah susah payah menyetujui di browser.
 */
export function buildExtraData(provider, data) {
  if (provider === "kiro") {
    return {
      _clientId: data._clientId,
      _clientSecret: data._clientSecret,
      _region: data._region,
      _authMethod: data._authMethod,
      _startUrl: data._startUrl,
    };
  }
  if (provider === "qoder") {
    return {
      _qoderNonce: data._qoderNonce,
      _qoderMachineId: data._qoderMachineId,
      _qoderVerifier: data.codeVerifier,
    };
  }
  if (provider === "kimi" || provider === "kimi-coding") {
    return { _kimiDeviceId: data._kimiDeviceId };
  }
  return null;
}
