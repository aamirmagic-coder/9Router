import crypto from "node:crypto";

/**
 * Gerbang password untuk menu Automation.
 *
 * ── Kenapa ini ada, dan apa batasnya ────────────────────────────────────────
 *
 * Ini BUKAN pengganti sesi dashboard; ia lapisan kedua di atasnya. Seluruh
 * halaman /dashboard/* sudah butuh login dashboard untuk dilihat sama sekali,
 * jadi password ini menjaga dari orang yang SUDAH bisa membuka dashboard —
 * misalnya orang lain di jaringan yang sama kalau `requireLogin` dimatikan,
 * atau siapa pun yang memakai browser yang sudah login.
 *
 * Karena itu ia tidak boleh disamakan dengan autentikasi sungguhan: password
 * yang sama dipakai untuk semua orang, tidak ada identitas per pengguna, tidak
 * ada audit siapa yang membuka. Yang ia beli hanyalah "tidak sengaja terbuka".
 *
 * ── Soal password yang di-hardcode ──────────────────────────────────────────
 *
 * Pemilik produk memilih hardcode, dengan sadar. Password di bawah terbaca
 * siapa pun yang bisa membaca repositori ini — dan repositori ini di-push ke
 * GitHub. Itu keputusan yang boleh diambil untuk mesin lokal satu pemakai,
 * tapi bukan hal yang boleh disembunyikan: kalau repo ini jadi publik, gerbang
 * ini tidak lagi berarti apa-apa. `AUTOMATION_PASSWORD` menang atas nilai
 * bawaan, jadi mengubahnya cukup lewat .env tanpa menyentuh kode.
 */
const FALLBACK_PASSWORD = "123abc789";

function expectedPassword() {
  const fromEnv = process.env.AUTOMATION_PASSWORD;
  return fromEnv && fromEnv.length > 0 ? fromEnv : FALLBACK_PASSWORD;
}

/**
 * Cookie penanda bahwa gerbang sudah dibuka.
 *
 * Hash, bukan password itu sendiri: cookie ikut terkirim di setiap request dan
 * tersimpan di browser, jadi menaruh password di sana sama dengan menaruhnya
 * di tempat yang paling banyak dibaca. Hash-nya terikat ke JWT_SECRET, yang
 * sudah ada dan tidak ikut ke repositori — sehingga cookie dari mesin lain
 * tidak berlaku di sini.
 */
const COOKIE_NAME = "automation_gate";

function gateToken() {
  const secret = process.env.JWT_SECRET || process.env.MACHINE_ID_SALT || "9router-automation-local";
  return crypto
    .createHmac("sha256", String(secret))
    .update(`automation-gate:${expectedPassword()}`)
    .digest("hex");
}

/**
 * Perbandingan waktu-tetap. Perbandingan string biasa berhenti di karakter
 * pertama yang berbeda, sehingga waktu jawabnya membocorkan berapa banyak
 * huruf awal yang benar. Untuk gerbang berpassword pendek bedanya kecil, tapi
 * ini satu baris dan menghapus seluruh kelas masalahnya.
 */
export function checkPassword(input) {
  const a = Buffer.from(String(input ?? ""));
  const b = Buffer.from(expectedPassword());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function issueGateCookie() {
  return {
    name: COOKIE_NAME,
    value: gateToken(),
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Tidak ada `secure`: dashboard ini lazim dibuka lewat http://localhost,
    // dan cookie ber-`secure` tidak akan terkirim di sana — gerbangnya akan
    // tampak rusak ("password benar tapi tetap diminta"). Ini konsisten dengan
    // cara dashboardSession menentukan secure dari proto permintaan.
  };
}

export function clearGateCookie() {
  return { name: COOKIE_NAME, value: "", httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 };
}

/** Apakah permintaan ini membawa cookie gerbang yang sah. */
export function isGateOpen(request) {
  const raw = request?.cookies?.get?.(COOKIE_NAME)?.value;
  if (!raw) return false;
  const expected = gateToken();
  if (raw.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Bungkus handler API: tolak dengan 401 kalau gerbang belum dibuka.
 *
 * Dipakai sebagai satu baris di setiap route automation, supaya tidak ada
 * route yang lupa memeriksa — route baru yang ditambahkan tanpa gerbang adalah
 * cara paling mudah membuat gerbang ini tidak berguna.
 */
export function requireGate(handler) {
  return async (request, ...rest) => {
    if (!isGateOpen(request)) {
      return Response.json(
        { error: "Automation gate locked", code: "GATE_LOCKED" },
        { status: 401 },
      );
    }
    return handler(request, ...rest);
  };
}

export const AUTOMATION_COOKIE_NAME = COOKIE_NAME;
