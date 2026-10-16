/**
 * Domain breaker — regresi untuk false-positive yang mematikan 60 akun sehat.
 *
 * Kejadian nyata (2026-09-18): satu penjual mengirim DUA batch di domain yang
 * sama — 60 akun `hww*` yang sudah dihapus Google, dan 60 akun `zvc*` yang
 * baru dan berfungsi. Ambang rasio 30% terlewati oleh batch yang mati, lalu
 * breaker menyapu seluruh domain termasuk batch yang hidup.
 *
 * Diverifikasi sesudahnya dengan menukar refresh token SETIAP akun langsung
 * ke Google: 60/60 akun yang "dinonaktifkan" mengembalikan access_token sah.
 *
 * Inti perbaikan: ambang rasio hanya memicu PEMERIKSAAN. Yang menentukan siapa
 * yang mati adalah Google, lewat penukaran refresh token per akun.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = { connections: [] };

// `rowToConn` di connectionsRepo me-flatten kolom `data` ke level atas, jadi
// refreshToken ada di `c.refreshToken` — bukan `c.data.refreshToken`. Mock ini
// meniru bentuk itu supaya test menguji jalur yang sama dengan produksi.
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async ({ provider, isActive } = {}) => {
    if (provider && provider !== "antigravity") return [];
    let list = store.connections.filter((c) => c.provider === "antigravity");
    if (isActive === true) list = list.filter((c) => c.isActive !== false);
    return list.map((c) => ({ ...c, ...c.data }));
  },
  updateProviderConnection: async (id, patch) => {
    const c = store.connections.find((x) => x.id === id);
    if (c) {
      Object.assign(c, patch);
      // Produksi menulis isActive ke KOLOM, bukan ke dalam blob data —
      // jaga mock tetap setia supaya assertion isActive bermakna.
      if (patch.data) c.data = { ...c.data, ...patch.data };
    }
    return c;
  },
  getSettings: async () => ({}),
}));

const {
  maybeBreakAntigravityDomain,
  verifyAccountsAlive,
  isAntigravityEntitlementError,
  isPermanentAntigravityAuthFailure,
  _resetBreakerForTest,
} = await import("../../src/sse/services/antigravityDomainBreaker.js");

/**
 * Bentuk kondisi nyata: batch mati sudah ter-disable lebih dulu (itulah yang
 * menaikkan hitungan di atas ambang), lalu batch hidup masih aktif.
 *
 * `alreadyDisabled` penting — breaker menghitung `alreadyDisabled + 1`, jadi
 * tanpa batch yang sudah ter-disable ambang rasio tidak akan pernah terlewati
 * dan test tidak menguji jalur yang dimaksud.
 */
function seed(domain, aliveCount, alreadyDisabledCount) {
  store.connections = [];
  const mk = (prefix, n, opts = {}) => {
    for (let i = 1; i <= n; i++) {
      store.connections.push({
        id: `${prefix}${i}`,
        provider: "antigravity",
        email: `${prefix}${i}@${domain}`,
        isActive: opts.active !== false,
        data: { refreshToken: `rt-${prefix}${i}` },
      });
    }
  };
  // Batch mati: sudah dinonaktifkan oleh kegagalan sebelumnya.
  mk("hww", alreadyDisabledCount, { active: false });
  // Batch hidup: masih aktif, inilah yang harus dilindungi.
  mk("zvc", aliveCount, { active: true });
}

// refreshFn tiruan: akun dengan _dead=true ditolak seperti Google, sisanya
// mengembalikan access_token. Ini meniru perilaku nyata tanpa jaringan.
function fakeRefresh(creds) {
  if (String(creds.refreshToken).startsWith("rt-hww")) {
    return Promise.reject(new Error("invalid_grant: Account has been deleted"));
  }
  return Promise.resolve({ accessToken: "ya29.fresh", expiresIn: 3600 });
}

describe("verifyAccountsAlive", () => {
  it("menandai akun mati dan membiarkan akun hidup", async () => {
    seed("contoh.com", 3, 2);
    const accounts = store.connections.map((c) => ({
      id: c.id, email: c.email, refreshToken: c.data.refreshToken,
    }));
    const verdicts = await verifyAccountsAlive(accounts, fakeRefresh);

    expect(verdicts.get("hww1")).toBe(true);
    expect(verdicts.get("hww2")).toBe(true);
    expect(verdicts.get("zvc1")).toBe(false);
    expect(verdicts.get("zvc3")).toBe(false);
  });

  it("akun tanpa refreshToken tidak dihakimi (absent, bukan mati)", async () => {
    const verdicts = await verifyAccountsAlive(
      [{ id: "x1", email: "x@y.com" }],
      fakeRefresh
    );
    expect(verdicts.has("x1")).toBe(false);
  });

  it("error jaringan tidak dianggap mati", async () => {
    const flaky = () => Promise.reject(new Error("ECONNRESET"));
    const verdicts = await verifyAccountsAlive(
      [{ id: "n1", email: "n@y.com", refreshToken: "rt-zvc1" }],
      flaky
    );
    // Absent = tidak dihakimi; caller memperlakukannya sebagai tetap aktif.
    expect(verdicts.has("n1")).toBe(false);
  });
});

describe("maybeBreakAntigravityDomain — regresi batch sehat", () => {
  beforeEach(() => _resetBreakerForTest());

  it("TIDAK mematikan batch hidup di domain yang sama", async () => {
    // Kejadian nyata, direproduksi pada titik breaker terpicu:
    //   domain punya 120 akun — 60 hww* (dihapus Google) + 60 zvc* (baru, hidup)
    //   hww* gagal satu per satu; 35 sudah ter-disable saat hitungan menyentuh
    //   ambang (36/120 = 30%), jadi 25 hww* masih aktif bersama 60 zvc*.
    //
    // Breaker lama menyapu KETIGA-nya (85 akun). Yang benar: 25 hww* mati,
    // 60 zvc* tetap hidup.
    store.connections = [];
    for (let i = 1; i <= 60; i++) {
      store.connections.push({
        id: `hww${i}`, provider: "antigravity", email: `hww${i}@gmotie.com`,
        isActive: i > 35,                       // 35 sudah ter-disable
        data: { refreshToken: `rt-hww${i}` },
      });
    }
    for (let i = 1; i <= 60; i++) {
      store.connections.push({
        id: `zvc${i}`, provider: "antigravity", email: `zvc${i}@gmotie.com`,
        isActive: true,                          // batch baru, semua hidup
        data: { refreshToken: `rt-zvc${i}` },
      });
    }

    const verdict = await maybeBreakAntigravityDomain(
      "hww36@gmotie.com", "antigravity", { refreshFn: fakeRefresh }
    );

    const zvcAktif = store.connections.filter(
      (c) => c.email.startsWith("zvc") && c.isActive !== false
    );
    const hwwAktif = store.connections.filter(
      (c) => c.email.startsWith("hww") && c.isActive !== false
    );

    // Batch hidup harus utuh — inilah regresi yang dijaga test ini.
    expect(zvcAktif.length).toBe(60);
    // Sisa batch mati yang masih aktif harus dinonaktifkan.
    expect(hwwAktif.length).toBe(0);
    expect(verdict.deadCount).toBe(25);
    expect(verdict.aliveCount).toBe(60);
  });

  it("tidak menonaktifkan apa pun kalau verifikasi menemukan semua hidup", async () => {
    // Ambang rasio terlewati (30 sudah ter-disable, 40 aktif), tapi verifikasi
    // membuktikan SEMUA masih hidup — termasuk yang dianggap mati. Karena itu
    // 30 yang nonaktif harus DIBIARKAN seperti adanya (bukan diaktifkan —
    // breaker tidak punya wewenang reaktivasi), dan 40 yang aktif tetap aktif.
    seed("sehat.com", 40, 30);
    const allAlive = () => Promise.resolve({ accessToken: "ya29.ok" });
    const verdict = await maybeBreakAntigravityDomain(
      "hww1@sehat.com", "antigravity", { refreshFn: allAlive }
    );

    const aktif = store.connections.filter((c) => c.isActive !== false);
    expect(aktif.length).toBe(40);
    expect(verdict.broken).toBe(false);
    expect(verdict.disabledCount).toBe(0);
  });

  it("mematikan akun mati dan MENGABAIKAN yang sudah nonaktif", async () => {
    // 30 hww mati yang SUDAH nonaktif + 30 zvc hidup yang masih aktif.
    // Semua yang AKTIF lolos verifikasi, jadi breaker tidak mematikan apa pun
    // dan keluar lebih awal — tidak ada akun hidup yang boleh tersentuh.
    seed("campur.com", 30, 30);
    const verdict = await maybeBreakAntigravityDomain(
      "hww1@campur.com", "antigravity", { refreshFn: fakeRefresh }
    );

    const aktif = store.connections.filter((c) => c.isActive !== false);
    expect(aktif.length).toBe(30);
    expect(aktif.every((c) => c.email.startsWith("zvc"))).toBe(true);
    // Tidak ada yang mati di antara yang aktif -> early return, tanpa disabledCount.
    expect(verdict.broken).toBe(false);
    expect(verdict.disabledCount).toBe(0);
  });

  it("domain whitelist (gmail.com) tidak pernah di-break", async () => {
    seed("gmail.com", 5, 5);
    const verdict = await maybeBreakAntigravityDomain(
      "hww1@gmail.com", "antigravity", { refreshFn: fakeRefresh }
    );
    expect(verdict.broken).toBe(false);
    // Breaker tidak menyentuh apa pun; 5 yang aktif tetap aktif.
    const aktif = store.connections.filter((c) => c.isActive !== false);
    expect(aktif.length).toBe(5);
  });

  it("provider selain antigravity diabaikan", async () => {
    seed("lain.com", 5, 5);
    const verdict = await maybeBreakAntigravityDomain(
      "hww1@lain.com", "gemini", { refreshFn: fakeRefresh }
    );
    expect(verdict.broken).toBe(false);
  });
});

/**
 * Regresi 2026-09-20: burst 403 SUBSCRIPTION_REQUIRED (#3501) di Antigravity.
 *
 * Kejadian nyata: beberapa akun sehat kena 403 "You do not have a valid license
 * of this product" beruntun. Google mengirim reason SUBSCRIPTION_REQUIRED di
 * bawah status PERMISSION_DENIED — enum yang SAMA dengan akun yang benar-benar
 * dihapus. Karena itu breaker tidak bisa membedakannya, dan berpotensi
 * mem-bulk-disable seluruh domain.
 *
 * Ketiga bug ini diperbaiki; test di bawah mengunci masing-masing.
 */
describe("entitlement 403 (#3501) TIDAK dianggap kematian akun", () => {
  const BODY_3501 = JSON.stringify({
    error: {
      code: 403,
      message: "You do not have a valid license of this product. Please contact your administrator to request a license. (#3501)",
      status: "PERMISSION_DENIED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SUBSCRIPTION_REQUIRED", domain: "cloudaicompanion.googleapis.com" },
        { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Learn more", url: "https://cloud.google.com/gemini/docs/codeassist/request-license" }] },
      ],
    },
  });

  it("mengenali body #3501 sebagai entitlement error", () => {
    expect(isAntigravityEntitlementError(403, BODY_3501)).toBe(true);
    expect(isAntigravityEntitlementError(403, "SUBSCRIPTION_REQUIRED")).toBe(true);
    expect(isAntigravityEntitlementError(403, "You do not have a valid license of this product")).toBe(true);
    // Bukan entitlement
    expect(isAntigravityEntitlementError(403, "Account has been deleted")).toBe(false);
    expect(isAntigravityEntitlementError(429, BODY_3501)).toBe(false);
  });

  it("TIDAK mengklasifikasikan #3501 sebagai permanent auth failure", () => {
    // Inti regresi: dulu /PERMISSION_DENIED/i membuat ini true -> bulk-disable.
    expect(isPermanentAntigravityAuthFailure(403, BODY_3501)).toBe(false);
  });

  it("tetap mendeteksi kematian akun yang sebenarnya", () => {
    expect(isPermanentAntigravityAuthFailure(401, "whatever")).toBe(true);
    expect(isPermanentAntigravityAuthFailure(403, '{"error":{"message":"Account has been deleted"}}')).toBe(true);
    expect(isPermanentAntigravityAuthFailure(400, "invalid_grant")).toBe(true);
    expect(isPermanentAntigravityAuthFailure(403, "unauthorized_client")).toBe(true);
  });

  it("tidak lagi cocok pada pola terlalu luas (Bad Request / 401 / unauthorized)", () => {
    // Dulu ini semua true -> akun sehat ikut mati.
    expect(isPermanentAntigravityAuthFailure(400, "Bad Request: malformed body")).toBe(false);
    expect(isPermanentAntigravityAuthFailure(403, '{"requestId":"req_401_abc"}')).toBe(false);
    expect(isPermanentAntigravityAuthFailure(403, "unauthorized")).toBe(false);
  });
});

describe("verifyAccountsAlive — kegagalan refresh transien bukan kematian", () => {
  it("mengembalikan error non-definitif = tidak dihakimi (bukan mati)", async () => {
    // refreshGoogleToken RETURN {error}, tidak throw. Dulu !accessToken => mati.
    const transient = () => Promise.resolve({ error: "server_error", message: "500 Internal" });
    const v = await verifyAccountsAlive(
      [{ id: "a1", email: "a@x.com", refreshToken: "rt-a1" }],
      transient
    );
    expect(v.has("a1")).toBe(false);   // absent = tetap aktif
  });

  it("mengembalikan invalid_grant = mati (definitif)", async () => {
    const dead = () => Promise.resolve({ error: "invalid_grant", message: "Account has been deleted" });
    const v = await verifyAccountsAlive(
      [{ id: "d1", email: "d@x.com", refreshToken: "rt-d1" }],
      dead
    );
    expect(v.get("d1")).toBe(true);
  });

  it("mengembalikan accessToken = hidup (terbukti)", async () => {
    const alive = () => Promise.resolve({ accessToken: "ya29.x", expiresIn: 3600 });
    const v = await verifyAccountsAlive(
      [{ id: "l1", email: "l@x.com", refreshToken: "rt-l1" }],
      alive
    );
    expect(v.get("l1")).toBe(false);
  });

  it("return null (5xx/network) = tidak dihakimi", async () => {
    const nulled = () => Promise.resolve(null);
    const v = await verifyAccountsAlive(
      [{ id: "n1", email: "n@x.com", refreshToken: "rt-n1" }],
      nulled
    );
    expect(v.has("n1")).toBe(false);
  });
});

describe("ambang breaker memakai ukuran DOMAIN, bukan sisa aktif", () => {
  beforeEach(() => _resetBreakerForTest());

  it("domain yang hampir terkuras tidak terpicu oleh satu 403", async () => {
    // 59 dari 61 sudah nonaktif, 2 aktif. Dulu: total=2 <3 -> threshold=1 ->
    // satu 403 memicu sweep. Sekarang: domainSize=61 -> threshold=19, dan
    // minDead=5 -> tidak terpicu.
    store.connections = [];
    for (let i = 1; i <= 59; i++) {
      store.connections.push({
        id: `dead${i}`, provider: "antigravity", email: `dead${i}@ratchet.com`,
        isActive: false, data: { refreshToken: `rt-dead${i}` },
      });
    }
    for (let i = 1; i <= 2; i++) {
      store.connections.push({
        id: `live${i}`, provider: "antigravity", email: `live${i}@ratchet.com`,
        isActive: true, data: { refreshToken: `rt-live${i}` },
      });
    }
    const verdict = await maybeBreakAntigravityDomain(
      "live1@ratchet.com", "antigravity", { refreshFn: () => Promise.resolve({ accessToken: "ya29.ok" }) }
    );
    expect(verdict.broken).toBe(false);
    const aktif = store.connections.filter((c) => c.isActive !== false);
    expect(aktif.length).toBe(2);
  });
});
