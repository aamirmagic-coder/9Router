/**
 * Katalog provider menu Automation.
 *
 * ── Tujuh provider, sesuai tujuh skrip ────────────────────────────────────
 *
 *   antigravity  ←  add-account-ag-9router.py
 *   b.ai         ←  add-account-bai-9router.py
 *   cline        ←  add-account-cline-oauth-...py
 *   grok-cli     ←  add-account-grok-9router.py
 *   kilocode     ←  add-account-kilocode-9router.py
 *   kiro         ←  add-account-kiro-9router.py
 *   tokenharbour ←  add-account-tokenharbor-...py
 *
 * Katalog ini MENENTUKAN bentuk menu: provider yang tidak ada di sini tidak
 * muncul, dan fitur yang tidak dicentang tidak ditawarkan. Itu disengaja —
 * menu yang menawarkan tombol yang selalu gagal lebih buruk daripada menu
 * pendek.
 *
 * ── `kinds` menentukan operasi apa saja yang benar-benar didukung ───────────
 *
 * Tiap nilai di sini punya alasan yang bisa ditunjukkan, bukan tebakan:
 *
 *   quota   → provider punya handler di `open-sse/services/usage.js`
 *   test    → provider punya entri di `api/providers/[id]/test/testUtils.js`
 *   prompt  → bisa diuji lewat `/v1/chat/completions` dengan `x-connection-id`
 *   import  → ada format berkas token yang jelas (dari skripnya)
 *   calls   → skripnya bisa MEMBUAT akun baru lewat browser (TIDAK dibangun;
 *             sebagai gantinya tiap panel punya panduan perintah script)
 *   script  → nama berkas skrip + perintah tambah + format file, untuk panel
 *             panduan "Tambah akun baru via script" (cara kerja: salin perintah
 *             + file email:password → script jalan lokal → akun muncul di sini
 *             karena DB-nya sama)
 *
 * `quota: false` bukan berarti providernya buruk — hanya berarti 9Router belum
 * punya cara membaca kuotanya, dan menawarkan tombolnya akan berbohong.
 */

/** Akun kustom dengan id panjang; dipakai untuk menemukannya di database. */
export const CUSTOM_PROVIDER_IDS = {
  bai: "openai-compatible-chat-7665141b-a127-4995-9278-94eaec46f1b6",
  tokenharbour: "openai-compatible-chat-d6371244-0ef9-4eca-91f7-2acf38219814",
};

/**
 * Panduan "tambah akun baru via script" per provider.
 *
 * Cara kerjanya SAMA di ketujuh provider: salin perintah + siapkan berkas
 * `email:password` → jalankan script Python di terminal sendiri → script
 * membuka browser dan login otomatis → token masuk DB 9Router yang sama →
 * akun langsung muncul di menu ini tanpa impor ulang.
 *
 * `file` = nama berkas default yang ditulis generator TXT; `format` = bentuk
 * baris yang dimakan script itu; `extra` = flag khas yang berguna (dari
 * argparse tiap script).
 */
export const AUTOMATION_CATALOGUE = [
  {
    id: "antigravity",
    label: "Antigravity",
    source: "add-account-ag-9router.py",
    accountKind: "oauth",
    kinds: { quota: true, test: true, prompt: true, import: "token", calls: "browser", refresh: true, selective: true, inactive: true },
    /** Grup kuota dari skrip, dipakai untuk menamai baris di tabel. */
    note: "Kuota per grup model (Gemini / Claude & GPT). Reset time tersedia.",
    script: {
      file: "add-account-ag-9router.py",
      accountsFile: "accounts_antigravity.txt",
      format: "email:password",
      command: "python add-account-ag-9router.py -f accounts_antigravity.txt",
      extra: "--workers 3 --headed (paralel, browser terlihat; --fresh-profile untuk isolasi per akun)",
    },
  },
  {
    id: "bai",
    label: "B.AI",
    providerId: CUSTOM_PROVIDER_IDS.bai,
    source: "add-account-bai-9router.py",
    accountKind: "apikey",
    keyPrefix: "sk-",
    kinds: { quota: false, test: true, prompt: true, import: "key", calls: "browser", verify: true },
    note: "Kuota diperiksa lewat inferensi nyata (tidak ada endpoint saldo).",
    script: {
      file: "add-account-bai-9router.py",
      accountsFile: "accounts_bai.txt",
      format: "email:password (atau email|password)",
      command: "python add-account-bai-9router.py -f accounts_bai.txt",
      extra: "--headed --engine camoufox (batch besar disarankan headed)",
    },
  },
  {
    id: "cline",
    label: "Cline",
    source: "add-account-cline-oauth-9router.py",
    accountKind: "oauth",
    kinds: { quota: false, test: true, prompt: true, import: "token", calls: "browser", refresh: true, cleanup: true },
    refreshable: true,
    note: "Token berumur 1 jam; refresh proaktif ambang 300 detik.",
    script: {
      file: "add-account-cline-oauth-9router.py",
      accountsFile: "akun.txt",
      format: "email:password (atau email|password)",
      command: "python add-account-cline-oauth-9router.py --batch akun.txt",
      extra: "--headless untuk batch tanpa layar (fallback headed otomatis bila gagal)",
    },
  },
  {
    id: "grok-cli",
    label: "Grok CLI",
    source: "add-account-grok-9router.py",
    accountKind: "oauth",
    kinds: { quota: true, test: true, prompt: true, import: "token", calls: "browser", refresh: true, selective: true, patternDelete: true, blocked: true, deviceBulk: true },
    note: "Kuota billing + deteksi team_blocked langsung ke xAI.",
    script: {
      file: "add-account-grok-9router.py",
      accountsFile: "grok_accounts.txt",
      format: "email:password",
      command: "python add-account-grok-9router.py -f grok_accounts.txt",
      extra: "--headed -w 3 (device-code + browser; login diserialkan otomatis)",
    },
  },
  {
    id: "kilocode",
    label: "Kilo Code",
    source: "add-account-kilocode-9router.py",
    accountKind: "oauth",
    kinds: { quota: false, test: true, prompt: true, import: false, calls: "browser", refresh: false, selective: true, deviceBulk: true },
    note: "Device-code + browser (429/terlalu banyak pending ditangani skrip). Hapus error dari menu.",
    script: {
      file: "add-account-kilocode-9router.py",
      accountsFile: "accounts.txt",
      format: "email:password",
      command: "python add-account-kilocode-9router.py -f accounts.txt",
      extra: "--headed (device-code + browser; auto-retry gagal)",
    },
  },
  {
    id: "tokenharbour",
    label: "TokenHarbor",
    providerId: CUSTOM_PROVIDER_IDS.tokenharbour,
    source: "add-account-tokenharbor-9router.py",
    accountKind: "apikey",
    keyPrefix: "thk_",
    kinds: { quota: false, test: true, prompt: true, import: "key", calls: "browser", verify: true, expiryOps: true },
    /** Akun bisa diberi masa berlaku saat diimpor. */
    expiry: true,
    note: "Mendukung masa berlaku akun (expire hours) dan pembersihan otomatis.",
    script: {
      file: "add-account-tokenharbor-9router.py",
      accountsFile: "accounts_tokenharbor.txt",
      format: "email:password",
      command: "python add-account-tokenharbor-9router.py -f accounts_tokenharbor.txt",
      extra: "--headed --expire-hours 168 (hybrid cepat; full untuk UI penuh)",
    },
  },
  {
    id: "kiro",
    label: "Kiro",
    source: "add-account-kiro-9router.py",
    accountKind: "oauth",
    kinds: { quota: true, test: true, prompt: true, import: "token", calls: "browser", refresh: true, deviceBulk: true },
    refreshable: true,
    /** Impor bulk refreshToken (format skrip: email|refreshToken) lewat
        POST oauth/kiro/import yang memvalidasi via refresh — token mati
        langsung ditolak saat impor, bukan sesudahnya. */
    note: "Pool kuota credits + tanggal reset. Impor refreshToken tervalidasi.",
    script: {
      file: "add-account-kiro-9router.py",
      accountsFile: "accounts_kiro.txt",
      format: "email:password (atau email|password)",
      command: "python add-account-kiro-9router.py",
      extra: "interaktif: pilih sumber file/paste, headed y/n, workers 1-4",
    },
  },
];

export function getCatalogueEntry(id) {
  return AUTOMATION_CATALOGUE.find((p) => p.id === id) || null;
}

/**
 * Provider id sesungguhnya di database untuk sebuah entri katalog.
 *
 * `b.ai` dan `tokenharbour` disimpan sebagai provider kustom ber-id UUID, dan
 * id itu ditentukan saat provider dibuat — di mesin lain id-nya bisa berbeda.
 * Karena itu entri katalog menyimpan id yang diketahui, dan pemanggil harus
 * memakai fungsi ini alih-alih menulis `entry.id` langsung.
 */
export function resolveProviderId(entry) {
  return entry?.providerId || entry?.id || null;
}

/** Semua provider id yang mungkin, untuk menyaring daftar koneksi. */
export function catalogueProviderIds() {
  return AUTOMATION_CATALOGUE.map((p) => resolveProviderId(p)).filter(Boolean);
}

/**
 * Cocokkan sebuah koneksi ke entri katalog.
 *
 * Pencocokan memakai provider id ATAU `prefix` di `providerSpecificData`.
 * Alasannya: pada instalasi nyata, `b.ai` dan `tokenharbour` dibuat skrip
 * Python di waktu berbeda, dan id-nya tidak selalu sama dengan yang tertulis di
 * skrip — sedangkan `prefix` (`bai`, `tokenharbor`) stabil karena itu yang
 * dipakai model alias di 9Router.
 */
export function matchCatalogueEntry(connection) {
  if (!connection) return null;
  const direct = AUTOMATION_CATALOGUE.find((p) => resolveProviderId(p) === connection.provider);
  if (direct) return direct;

  const prefix = connection.providerSpecificData?.prefix;
  if (!prefix) return null;
  return (
    AUTOMATION_CATALOGUE.find((p) => p.keyPrefix === prefix || p.id === prefix) ||
    AUTOMATION_CATALOGUE.find(
      (p) => p.id.startsWith(prefix) || prefix.startsWith(p.id.replace(/-/g, "")),
    ) ||
    null
  );
}
