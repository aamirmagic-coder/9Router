import { deleteProviderConnection, updateProviderConnection } from "@/lib/localDb";
import { createJob, runJob } from "./jobs.js";

/**
 * Operasi massal untuk menu Automation.
 *
 * ── Prinsip yang mengikat seluruh berkas ini ────────────────────────────────
 *
 * **MEMBACA KUOTA MEMAKAI MESIN 9ROUTER, BUKAN MENYALINNYA.**
 *
 * Skrip terminal menghitung kuota sendiri: panggil upstream, parse
 * `remainingFraction`, kelompokkan per model. 9Router sudah mengerjakan itu
 * untuk 25 provider lewat `open-sse/services/usage/`, dan hasilnya LEBIH BAIK:
 * ia menyimpan `resetAt` (skrip membuangnya), memakai daftar model yang lebih
 * lengkap, dan menangani refresh token sendiri. Menyalin logika skrip berarti
 * membangun sumber kebenaran kedua yang akan menyimpang — persis kesalahan yang
 * sudah terjadi di repo ini pada daftar provider.
 *
 * Karena itu setiap pemeriksaan kuota di sini memanggil
 * `GET /api/usage/{connectionId}` lewat mesin yang sama.
 *
 * ── Tiga bug skrip yang SENGAJA TIDAK ditiru ────────────────────────────────
 *
 * 1. `ag`: ambang hapus `pct < 1` tidak mengecualikan sentinel `-1` ("kuota
 *    tidak terbaca"), dan `-1 < 1` bernilai benar — akun yang kuotanya gagal
 *    dibaca ikut terhapus. Di sini "tidak terbaca" adalah keadaan tersendiri
 *    dan TIDAK PERNAH memicu penghapusan.
 * 2. `bai`: penghapusan otomatis memakai `not ok` mentah, sehingga akun sehat
 *    yang sekadar gagal jaringan saat pemindaian ikut terhapus. Di sini hanya
 *    keadaan yang benar-benar final (kredensial mati / kuota habis) yang masuk
 *    daftar usulan hapus; kesalahan jaringan tidak.
 * 3. `tokenharbor`: dedup membaca kolom yang salah (`row[2]` adalah `name`,
 *    bukan `data`), sehingga selalu menyisipkan baris baru dan duplikat
 *    menumpuk. Dedup di sini dikerjakan di satu tempat, oleh pemanggil, dengan
 *    kunci yang benar.
 *
 * Yang juga tidak ditiru: skrip mencetak 25 karakter pertama API key ke layar.
 * Di sini hanya awalan pendek yang ditampilkan, dan hanya kalau perlu.
 */

/**
 * Provider yang punya handler kuota di 9Router.
 *
 * Disalin dari `open-sse/services/usage.js` — dan itu disengaja: berkas ini
 * harus bisa memberi tahu operator "provider ini belum punya cek kuota" tanpa
 * memanggil handler yang tidak ada. Yang penting, daftarnya di sini hanya untuk
 * MEMUTUSKAN apakah menawarkan tombol; angka kuotanya tetap datang dari mesin
 * 9Router.
 */
export const PROVIDERS_WITH_USAGE = new Set([
  "github", "gemini-cli", "antigravity", "claude", "codex", "kiro", "qoder",
  "iflow", "ollama", "glm", "glm-cn", "minimax", "minimax-cn",
  "vercel-ai-gateway", "codebuddy-cn", "codebuddy-intl", "grok-cli", "kimi",
  "opencode-go", "deepseek", "freebuff", "zed", "meta-code",
]);

/**
 * Samakan bentuk `quotas` dari semua handler menjadi daftar baris.
 *
 * Handler 9Router TIDAK sepakat bentuknya: sebagian mengembalikan array
 * (`[{modelId, remainingPercentage}]`), sebagian objek
 * (`{label: {used, total, remainingPercentage?}}` — kiro, grok-cli,
 * antigravity, freebuff). Keduanya diterima di sini supaya "Cek kuota" tidak
 * buta untuk provider objek — tanpanya, kiro selalu menjawab "tidak terbaca"
 * padahal datanya ada.
 *
 * Baris tanpa `remainingPercentage` tapi punya `used`/`total` (kiro) dihitung
 * persennya di sini; baris tanpa keduanya tetap "tidak terukur", bukan nol.
 */
function normalizeQuotaRows(usage) {
  const q = usage?.quotas;
  let rows = [];
  if (Array.isArray(q)) {
    rows = q.map((e, i) => ({
      label: e?.displayName || e?.modelId || e?.model || `#${i + 1}`,
      ...(e || {}),
    }));
  } else if (q && typeof q === "object") {
    rows = Object.entries(q).map(([name, e]) => ({
      label: e?.displayName || e?.modelId || name,
      ...((e && typeof e === "object") ? e : {}),
    }));
  }
  return rows.map((e) => {
    let pct = typeof e.remainingPercentage === "number" ? e.remainingPercentage : null;
    if (pct == null || !Number.isFinite(pct)) {
      const used = Number(e.used);
      const total = Number(e.total);
      const rem = Number(e.remaining);
      if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
        pct = (Math.max(0, total - used) / total) * 100;
      } else if (Number.isFinite(rem) && Number.isFinite(total) && total > 0) {
        pct = (Math.max(0, rem) / total) * 100;
      } else {
        pct = null;
      }
    }
    return { ...e, remainingPercentage: pct };
  });
}

/**
 * Persentase terendah satu keluarga model, atau null bila tidak ada barisnya.
 *
 * Ini cara skrip `ag` membaca kuota: DUA grup (Gemini vs Claude & GPT), bukan
 * satu angka global. Baris mingguan ("Gemini (Weekly)") ikut karena labelnya
 * cocok polanya. `null` berarti "tidak terbaca" — dan TIDAK PERNAH dihitung
 * sebagai 0 (itu bug skrip yang menghilangkan sentinel -1).
 */
function groupPct(measured, re) {
  const fam = measured.filter((q) => re.test(String(q.label || "")));
  if (!fam.length) return null;
  return Math.min(...fam.map((q) => q.remainingPercentage));
}

/**
 * Ubah payload `GET /api/usage/{id}` menjadi keadaan yang bisa dipakai UI.
 *
 * Bentuk payloadnya berbeda antar provider — ada yang mengembalikan `quotas[]`,
 * ada yang mengembalikan objek `quotas{}`, ada yang mengembalikan `message`,
 * ada yang mengembalikan `plan` saja. Yang TIDAK boleh terjadi: menyimpulkan
 * "habis" dari ketiadaan data.
 *
 * `remaining` adalah persentase sisa TERENDAH di antara kuota yang terbaca —
 * model yang paling habis menentukan kesehatan akun, karena satu model yang
 * habis sudah cukup membuat request ke model itu gagal.
 */
export function classifyUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { state: "unknown", reason: "Tidak ada data kuota", remaining: null };
  }

  // Pesan tanpa angka: provider belum terhubung, atau handler-nya tidak ada.
  if (usage.message && !usage.quotas) {
    const msg = String(usage.message);
    const missing = /not implemented|not available|credential not available/i.test(msg);
    return {
      state: missing ? "unsupported" : "unknown",
      reason: msg,
      remaining: null,
    };
  }

  const rows = normalizeQuotaRows(usage);

  // Kuota yang punya angka. `unlimited` sengaja tidak dihitung sebagai "sisa":
  // akun tanpa batas tidak sedang menipis.
  const measured = rows.filter(
    (q) => typeof q?.remainingPercentage === "number" && Number.isFinite(q.remainingPercentage) && !q.unlimited,
  );

  if (!measured.length) {
    // Akun tanpa kuota terukur bukan akun yang habis. Ini keadaan yang harus
    // ditampilkan apa adanya, bukan dipaksa jadi angka.
    return {
      state: rows.length ? "unlimited" : "unknown",
      reason: rows.length ? "Tanpa batas kuota terukur" : "Kuota tidak terbaca",
      remaining: null,
    };
  }

  const remaining = Math.min(...measured.map((q) => q.remainingPercentage));
  const worst = measured.reduce((a, b) =>
    a.remainingPercentage <= b.remainingPercentage ? a : b,
  );

  let state;
  if (remaining <= 0) state = "depleted";
  else if (remaining <= 5) state = "critical";
  else if (remaining <= 30) state = "low";
  else state = "healthy";

  // Grup keluarga model ala skrip `ag`: Gemini vs Claude & GPT. Label mingguan
  // ("Gemini (Weekly)") ikut karena polanya cocok; polanya juga cocok untuk
  // label modelKey mentah ("gemini-3.8-flash-high") dari handler 9Router.
  // `null` = tidak terbaca (tidak pernah 0 — itu bug sentinel skrip).
  const groups = {
    gemini: groupPct(measured, /gemini/i),
    claudeGpt: groupPct(measured, /claude|gpt/i),
  };

  // Pool Kiro: jumlahkan used/total semua baris AGENTIC_REQUEST — persis kolom
  // "TOTAL POOL KUOTA" di skrip kiro.
  let pool = null;
  const poolRows = measured.filter((q) => Number.isFinite(Number(q.used)) && Number.isFinite(Number(q.total)) && Number(q.total) > 0);
  if (poolRows.length) {
    const used = poolRows.reduce((s, q) => s + Number(q.used), 0);
    const total = poolRows.reduce((s, q) => s + Number(q.total), 0);
    pool = {
      used,
      total,
      remaining: Math.max(0, total - used),
      remainingPercentage: total > 0 ? (Math.max(0, total - used) / total) * 100 : null,
    };
  }

  return {
    state,
    // Nama kuota terburuk ikut dibawa: "Gemini 2.5 Pro: 0%" jauh lebih berguna
    // daripada "0%" tanpa konteks.
    reason: worst?.displayName || worst?.modelId || worst?.model || worst?.label || null,
    remaining: Math.round(remaining * 10) / 10,
    resetAt: worst?.resetAt || null,
    groups,
    pool,
    quotas: measured.map((q) => ({
      label: q.displayName || q.modelId || q.model || q.label || "?",
      remainingPercentage: Math.round((q.remainingPercentage || 0) * 10) / 10,
      resetAt: q.resetAt || null,
      unlimited: !!q.unlimited,
      ...(Number.isFinite(Number(q.used)) ? { used: Number(q.used) } : {}),
      ...(Number.isFinite(Number(q.total)) ? { total: Number(q.total) } : {}),
    })),
  };
}

/**
 * Nama provider yang bisa dibaca manusia.
 *
 * Provider kustom ber-id UUID ("openai-compatible-chat-7665141b-a127-…"), dan
 * UUID terpotong tidak berarti apa-apa bagi operator yang mengenalinya sebagai
 * "b.ai" atau "tokenharbour". `nodeName` di dalam `providerSpecificData` berisi
 * nama yang dipasang saat provider itu dibuat.
 *
 * Dua provider di mesin ini menyimpan `nodeName` yang BUKAN nama melainkan id
 * node ("b.ai" dibuat oleh skrip yang menulis nodeName = id); karena itu nilainya
 * dipakai hanya kalau memang bukan id provider itu sendiri.
 */
function providerLabel(connection) {
  const node = connection?.providerSpecificData?.nodeName;
  if (node && node !== connection.provider && !/^openai-compatible-chat-/.test(node)) {
    return node;
  }
  return connection.provider;
}

/**
 * Apakah `lastError` sebuah koneksi menandakan AKUNNYA bermasalah.
 *
 * ── Mengapa ini tidak boleh sekadar memeriksa ada/tidaknya ──────────────────
 *
 * Terukur pada instalasi nyata: 146 dari 156 koneksi `grok-cli` punya
 * `lastError` berisi
 *
 *   [400] invalid-argument: Failed to start sampling: [input_too_large]
 *   The prompt is too long for this model's context window
 *
 * Semuanya sehat. Yang salah adalah REQUEST-nya (prompt melebihi jendela
 * konteks), bukan kredensialnya — dan error itu akan hilang sendiri pada
 * request berikutnya yang lebih pendek. Menandai akun "bermasalah" hanya karena
 * `lastError` ada isinya akan melaporkan 146 akun sehat sebagai rusak, dan
 * operator yang mempercayainya akan menghapus akun yang tidak pernah salah.
 *
 * Jadi yang diperiksa adalah MAKNA-nya, bukan keberadaannya:
 *   · 401/403            → kredensial ditolak; tidak akan pulih sendiri
 *   · 402 + kuota/kredit → habis; pulih saat diisi atau reset
 *   · 400 / prompt terlalu panjang / parameter salah → MASALAH REQUEST, abaikan
 *   · 429                → laju; sementara, jangan pernah dihapus
 *   · 5xx / jaringan     → bisa hilang sendiri, jangan pernah dihapus
 */
export function classifyConnectionError(connection) {
  const code = Number(connection?.errorCode);
  const raw = String(connection?.lastError || "");
  const lower = raw.toLowerCase();

  if (!raw && !code) return { state: "none", reason: null };

  // Kredensial mati. Satu-satunya kategori yang aman untuk diusulkan hapus.
  //
  // `invalid_grant` dan `revoked` ikut dikenali TANPA kode HTTP: refresh token
  // yang dicabut sering dilaporkan sebagai error OAuth di badan respons dengan
  // status 200, sehingga kodenya tidak pernah muncul. Kalau hanya bergantung
  // pada 401/403, akun yang jelas-jelas sudah dicabut akan terbaca "lainnya"
  // dan tidak pernah masuk daftar.
  const revoked = /invalid_grant|revoked|unauthenticated|re-authorize/i.test(raw);
  if (code === 401 || code === 403 || /\b(401|403)\b/.test(raw) || revoked) {
    return {
      state: "invalid",
      reason: revoked ? "Kredensial dicabut" : "Ditolak provider (401/403)",
    };
  }

  // Kuota habis. Soft-fail: kredensialnya baik, hanya tidak ada sisa.
  if (
    code === 402 ||
    /\b402\b/.test(raw) ||
    /insufficient|balance|credit|quota|spending.?limit|blocked/i.test(lower)
  ) {
    return { state: "depleted", reason: "Kuota / kredit habis" };
  }

  if (code === 429 || /\b429\b/.test(raw) || /rate.?limit|too many/i.test(lower)) {
    return { state: "rate_limited", reason: "Kena laju sementara" };
  }

  // MASALAH REQUEST — bukan masalah akun. Ini yang paling mudah salah.
  if (
    /input_too_large|prompt is too long|context window|invalid.?argument|invalid.?request/i.test(lower)
  ) {
    return { state: "request_too_large", reason: "Prompt melebihi konteks (bukan akun)" };
  }

  if (code >= 500 || /fetch|timeout|econn|network|socket/i.test(lower)) {
    return { state: "transient", reason: "Gangguan jaringan / server" };
  }

  return { state: "other", reason: raw.slice(0, 120) };
}

/**
 * Status efektif sebuah koneksi, mengikuti aturan yang sudah dipakai dashboard.
 *
 * `testStatus === "unavailable"` BUKAN berarti akunnya rusak: nilai itu ditulis
 * jalur fallback runtime saat satu request gagal, bersama `modelLock_<model>`.
 * Setelah cooldown-nya lewat, akun itu aktif kembali. Dashboard 9Router sendiri
 * memperlakukannya begitu (`ConnectionsCard.js`: `unavailable` + cooldown lewat
 * → tampilkan aktif). Menampilkan nilai mentahnya akan melabeli 146 dari 156
 * akun sebagai rusak di instalasi nyata.
 */
export function effectiveStatus(connection) {
  if (connection?.isActive === false) return "inactive";

  const raw = connection?.testStatus;
  if (raw === "active" || raw === "success") return "active";

  if (raw === "unavailable" || raw === "error" || raw === "expired") {
    // Kalau masih ada model-lock yang belum lewat, memang sedang tidak bisa
    // dipakai. Kalau sudah lewat, statusnya tinggal catatan sejarah.
    const now = Date.now();
    const locked = Object.entries(connection || {}).some(([k, v]) => {
      if (!k.startsWith("modelLock_")) return false;
      const t = typeof v === "number" ? v : Date.parse(v);
      return Number.isFinite(t) && t > now;
    });
    return locked ? "cooling" : "active";
  }

  return "active";
}

/**
 * Ambil kuota satu koneksi lewat API 9Router sendiri.
 *
 * `origin` diperlukan karena pekerjaan berjalan di server yang sama — memanggil
 * URL relatif tidak mungkin dari sini, dan memanggil `127.0.0.1` secara
 * hardcode akan salah di deployment yang port-nya bukan default.
 */
async function fetchUsageFor(origin, connectionId, cookie, { force = false } = {}) {
  const url = `${origin}/api/usage/${connectionId}${force ? "?force=1" : ""}`;
  const res = await fetch(url, {
    headers: { Cookie: cookie },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { message: data?.error || `HTTP ${res.status}` };
  }
  return data;
}

/**
 * Cek kuota sekumpulan koneksi. Mengembalikan job; kemajuannya dipantau klien.
 *
 * `concurrency` kecil (4) dan sengaja tidak lebih: setiap item melakukan
 * permintaan keluar ke provider yang sama, dan 4 sudah cukup untuk membuat
 * pemindaian ratusan akun terasa cepat tanpa terlihat seperti serangan.
 */
export async function startQuotaCheck({ origin, cookie, connections, provider = null, ids = null }) {
  // `ids` = cek kuota akun tertentu ala skrip `ag` menu 5 ("50", "1-10").
  // Klien menerjemahkan pilihannya menjadi id; server hanya memfilter — tidak
  // ada parsing rentang di sini, dan id yang tidak ada diabaikan diam-diam.
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const targets = connections.filter((c) => {
    if (provider && c.provider !== provider) return false;
    if (wanted && !wanted.has(c.id)) return false;
    return true;
  });

  const job = createJob({
    kind: "quota",
    label: provider ? `Cek kuota ${provider}` : "Cek kuota semua akun",
    total: targets.length,
    meta: { provider },
  });

  // Tidak ditunggu: klien memantau lewat /status. `runJob` menangkap errornya
  // sendiri dan menuliskannya ke job, jadi tidak ada penolakan yang lepas.
  void runJob(
    job,
    targets,
    async (conn) => {
      const label = providerLabel(conn);
      const supported = PROVIDERS_WITH_USAGE.has(conn.provider);

      if (!supported) {
        return {
          ok: true,
          id: conn.id,
          name: conn.name,
          email: conn.email,
          provider: label,
          state: "unsupported",
          reason: "Provider ini belum punya cek kuota di 9Router",
        };
      }

      const usage = await fetchUsageFor(origin, conn.id, cookie);
      if (!usage) {
        return {
          ok: false,
          id: conn.id,
          name: conn.name,
          email: conn.email,
          provider: label,
          error: "Koneksi tidak ditemukan",
        };
      }

      const info = classifyUsage(usage);
      return {
        ok: true,
        id: conn.id,
        name: conn.name,
        email: conn.email,
        provider: label,
        ...info,
      };
    },
    { concurrency: 4 },
  );

  return job;
}

/**
 * Uji kelayakan kredensial sekumpulan koneksi, memakai endpoint uji 9Router.
 *
 * Berbeda dari cek kuota: ini tidak memanggil provider satu per satu dengan
 * logika sendiri, melainkan memakai `POST /api/providers/{id}/test` yang sudah
 * tahu cara menguji 18 provider, termasuk refresh token dan proxy.
 */
export async function startConnectionTest({ origin, cookie, connections, provider = null, ids = null }) {
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const targets = connections.filter((c) => {
    if (provider && c.provider !== provider) return false;
    if (wanted && !wanted.has(c.id)) return false;
    return true;
  });

  const job = createJob({
    kind: "test",
    label: provider ? `Test koneksi ${provider}` : "Test koneksi semua akun",
    total: targets.length,
    meta: { provider },
  });

  void runJob(
    job,
    targets,
    async (conn) => {
      const res = await fetch(`${origin}/api/providers/${conn.id}/test`, {
        method: "POST",
        headers: { Cookie: cookie },
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      return {
        ok: !!data?.valid,
        id: conn.id,
        name: conn.name,
        email: conn.email,
        provider: providerLabel(conn),
        latencyMs: data?.latencyMs ?? null,
        error: data?.valid ? null : data?.error || `HTTP ${res.status}`,
      };
    },
    { concurrency: 3 },
  );

  return job;
}

/**
 * Refresh token sekumpulan koneksi (fitur menu 6 skrip `cline`: semua/satu akun,
 * tanpa login ulang).
 *
 * Memakai `refreshProviderCredentials` dari mesin 9Router — handler per provider
 * sudah tahu endpoint refresh-nya (cline → api.cline.bot/auth/refresh, kiro →
 * AWS OIDC/sosial, grok-cli → xai, antigravity → Google). Akun tanpa
 * refreshToken dilewati sebagai gagal yang jelas, bukan dicoba buta.
 *
 * Hasil refresh ditulis ke DB oleh pemanggil test (`testSingleConnection` sudah
 * melakukannya), dan di sini juga — supaya tombol ini berdiri sendiri tanpa
 * harus dilanjutkan test koneksi.
 */
const REFRESHABLE_PROVIDERS = new Set(["cline", "kiro", "grok-cli", "xai", "antigravity", "gemini-cli"]);

export async function startRefresh({ connections, provider = null }) {
  const targets = connections.filter((c) => {
    if (provider && c.provider !== provider) return false;
    return REFRESHABLE_PROVIDERS.has(c.provider) && !!c.refreshToken;
  });

  const job = createJob({
    kind: "refresh",
    label: provider ? `Refresh token ${provider}` : "Refresh token semua akun",
    total: targets.length,
    meta: { provider },
  });

  const { refreshProviderCredentials } = await import("open-sse/services/oauthCredentialManager.js");

  void runJob(
    job,
    targets,
    async (conn) => {
      try {
        const credentials = {
          accessToken: conn.accessToken,
          refreshToken: conn.refreshToken,
          idToken: conn.idToken,
          expiresAt: conn.expiresAt,
          lastRefreshAt: conn.lastRefreshAt,
          connectionId: conn.id,
          providerSpecificData: conn.providerSpecificData,
        };
        const merged = await refreshProviderCredentials(conn.provider, credentials, console);
        if (!merged?.accessToken) {
          return {
            ok: false, id: conn.id, name: conn.name, email: conn.email,
            provider: providerLabel(conn),
            error: merged?.error || "Refresh gagal — token mungkin dicabut",
          };
        }
        const updateData = {
          accessToken: merged.accessToken,
          lastRefreshAt: merged.lastRefreshAt || new Date().toISOString(),
        };
        if (merged.refreshToken) updateData.refreshToken = merged.refreshToken;
        if (merged.idToken) updateData.idToken = merged.idToken;
        if (merged.expiresAt) updateData.expiresAt = merged.expiresAt;
        else if (merged.expiresIn) {
          updateData.expiresAt = new Date(Date.now() + Number(merged.expiresIn) * 1000).toISOString();
        }
        if (merged.providerSpecificData) {
          updateData.providerSpecificData = {
            ...(conn.providerSpecificData || {}),
            ...merged.providerSpecificData,
          };
        }
        await updateProviderConnection(conn.id, { ...updateData, testStatus: "active", lastError: null, errorCode: null });
        return {
          ok: true, id: conn.id, name: conn.name, email: conn.email,
          provider: providerLabel(conn),
          state: "refreshed",
          reason: "Token diperbarui",
        };
      } catch (err) {
        return {
          ok: false, id: conn.id, name: conn.name, email: conn.email,
          provider: providerLabel(conn),
          error: err?.message || "Refresh gagal",
        };
      }
    },
    { concurrency: 3 },
  );

  return job;
}

/**
 * Hapus sekumpulan koneksi berdasarkan id.
 *
 * Dipanggil HANYA setelah operator menekan tombol hapus di UI, dan UI wajib
 * menampilkan daftar sasaran lebih dulu. Tidak ada jalur "hapus otomatis saat
 * pemindaian" seperti di skrip: pemindaian dan penghapusan adalah dua tindakan
 * terpisah, sehingga kesalahan klasifikasi tidak langsung berakibat hilangnya
 * akun. Itu satu-satunya pertahanan yang benar-benar bekerja terhadap bug
 * seperti sentinel `-1` di `ag`.
 */
export async function startDelete({ connections, ids, reason = "manual" }) {
  const wanted = new Set(ids);
  const targets = connections.filter((c) => wanted.has(c.id));

  const job = createJob({
    kind: "delete",
    label: `Hapus ${targets.length} akun`,
    total: targets.length,
    meta: { reason },
  });

  void runJob(job, targets, async (conn) => {
    try {
      await deleteProviderConnection(conn.id);
      return {
        ok: true,
        id: conn.id,
        name: conn.name,
        email: conn.email,
        provider: providerLabel(conn),
      };
    } catch (err) {
      return {
        ok: false,
        id: conn.id,
        name: conn.name,
        email: conn.email,
        provider: providerLabel(conn),
        error: err?.message || "Gagal menghapus",
      };
    }
  });

  return job;
}

/**
 * Kandidat hapus, DENGAN alasan yang bisa diperiksa operator.
 *
 * Fungsi ini hanya MENYARING; ia tidak menghapus apa pun. Pemisahannya penting:
 * daftar yang salah masih bisa dibatalkan oleh operator, sedangkan penghapusan
 * otomatis tidak.
 *
 * Aturan penyaringan, dan alasan tiap pengecualian:
 *   · `depleted`  → kuota benar-benar habis (angka terbaca, bukan sentinel)
 *   · `invalid`   → kredensial ditolak provider (401/403), tidak akan pulih
 *   · `unsupported`/`unknown` → TIDAK PERNAH masuk daftar
 *   · kesalahan jaringan → TIDAK PERNAH masuk daftar
 */
export function selectDeleteCandidates(results, { includeDepleted = true, includeInvalid = true } = {}) {
  const picked = [];
  // Daftar kosong/null berarti "tidak ada yang dipindai", bukan "hapus semua".
  // Iterasi atas null akan melempar; yang lebih berbahaya, pemanggil yang
  // menangkapnya lalu jatuh ke cabang "hapus semua" akan menghapus seluruh akun.
  for (const r of Array.isArray(results) ? results : []) {
    if (!r) continue;
    if (includeDepleted && r.state === "depleted") {
      picked.push({ ...r, deleteReason: "Kuota habis" });
      continue;
    }
    if (includeInvalid && r.state === "invalid") {
      picked.push({ ...r, deleteReason: "Kredensial ditolak provider" });
    }
  }
  return picked;
}

/**
 * Usulan hapus dari DAFTAR KONEKSI (bukan dari hasil pemindaian kuota).
 *
 * Dipakai untuk akun yang gagal sebelum sempat dipindai — mis. kredensialnya
 * sudah ditolak sehingga permintaan kuota tidak pernah sampai. Sumber
 * kebenarannya adalah `lastError` yang sudah diklasifikasi, BUKAN keberadaan
 * `lastError` itu sendiri.
 */
export function candidatesFromConnections(connections) {
  const picked = [];
  for (const c of connections || []) {
    const cls = classifyConnectionError(c);
    if (cls.state === "invalid" || cls.state === "depleted") {
      picked.push({
        ...c,
        id: c.id,
        email: c.email,
        name: c.name,
        provider: providerLabel(c),
        state: cls.state,
        deleteReason: cls.reason,
      });
    }
  }
  return picked;
}

// ── Re-ekspor filter client-safe ────────────────────────────────────────────
// `filters.js` tidak mengimpor modul server apa pun, jadi aman dipakai komponen
// klien DAN tes. Re-ekspor di sini supaya pemakaian lama
// (`operations.selectExpiredConnections`, …) tetap jalan.
export {
  selectByIndex,
  selectAgGroupDepleted,
  clineCategory,
  CLINE_CATEGORY_LABEL,
  selectClineByCategory,
  selectExpiredConnections,
  classifyInactiveAccount,
  selectInactiveConnections,
  domainBreakdown,
} from "./filters.js";

/**
 * Nonaktifkan (bukan hapus) sekumpulan koneksi — perilaku default cleanup
 * expired skrip tokenharbor: 9Router hanya memakai `isActive=1`, jadi
 * menonaktifkan tanpa menghapus baris sudah cukup mengeluarkan akun dari
 * rotasi, dan masih bisa diaktifkan lagi.
 */
export async function startDeactivate({ connections, ids, reason = "expired" }) {
  const wanted = new Set(ids);
  const targets = connections.filter((c) => wanted.has(c.id));

  const job = createJob({
    kind: "deactivate",
    label: `Nonaktifkan ${targets.length} akun`,
    total: targets.length,
    meta: { reason },
  });

  void runJob(job, targets, async (conn) => {
    try {
      await updateProviderConnection(conn.id, { isActive: false });
      return {
        ok: true, id: conn.id, name: conn.name, email: conn.email,
        provider: providerLabel(conn),
      };
    } catch (err) {
      return {
        ok: false, id: conn.id, name: conn.name, email: conn.email,
        provider: providerLabel(conn),
        error: err?.message || "Gagal menonaktifkan",
      };
    }
  });

  return job;
}

/**
 * Verifikasi API key kustom (b.ai `sk-…`, tokenharbor `thk_…`) via inferensi
 * nyata — persis `check_key_quota_live` di kedua skrip.
 *
 * Mengirim chat minimal ("say ok", max_tokens kecil, timeout 30 dtk) langsung
 * ke `baseUrl` provider dengan key itu. Hasilnya tiga keadaan, sama seperti
 * skrip: ACTIVE (200/valid JSON) → `healthy`; 401/invalid → `invalid`;
 * 402/insufficient/credit/balance/quota → `depleted`; 429 → `rate_limited`;
 * sisanya `unknown` (tidak pernah dihapus).
 *
 * Berbeda dari "Tes koneksi" (yang memanggil baseUrl/models): endpoint models
 * hanya membuktikan key dikenal, bukan bisa chat. Skrip memakai inferensi
 * karena key b.ai/tokenharbor yang "dikenal tapi habis" lolos models tapi
 * gagal chat — dan itulah yang perlu dibedakan.
 */
/**
 * baseUrl bawaan untuk verify-key bila koneksi tidak menyimpannya.
 *
 * Koneksi dari skrip menyimpan `baseUrl` di `providerSpecificData`, tapi
 * koneksi lama/tangan mungkin tidak. Tanpa fallback, tombol "Verifikasi key"
 * akan melewati semua akunnya diam-diam (targets kosong) — lebih buruk
 * daripada mencoba endpoint yang benar.
 */
const VERIFY_BASE_URL_FALLBACK = {
  bai: "https://api.b.ai/v1",
  tokenharbour: "https://tokenharbor.ai/v1",
};

export async function startKeyVerify({ connections, provider = null }) {
  // Fallback node: baseUrl juga bisa hidup di node provider kustom (UUID),
  // bukan di tiap koneksi. Dibaca sekali sebelum filter supaya koneksi tanpa
  // baseUrl sendiri tetap ikut selama node-nya punya.
  let nodeBaseByProvider = {};
  try {
    const { getProviderNodes } = await import("@/lib/localDb");
    const nodes = await getProviderNodes().catch(() => []);
    for (const n of nodes || []) {
      if (n?.baseUrl) {
        nodeBaseByProvider[n.id] = String(n.baseUrl).replace(/\/$/, "");
        if (n.name) nodeBaseByProvider[n.name] = String(n.baseUrl).replace(/\/$/, "");
      }
    }
  } catch { /* tanpa node pun fallback bawaan di bawah masih ada */ }

  const resolveBaseUrl = (conn) => {
    const own = conn?.providerSpecificData?.baseUrl;
    if (own) return String(own).replace(/\/$/, "");
    const nodeBase = nodeBaseByProvider[conn.provider];
    if (nodeBase) return nodeBase;
    const prefix = conn?.providerSpecificData?.prefix;
    if (prefix === "bai") return VERIFY_BASE_URL_FALLBACK.bai;
    if (prefix === "tokenharbor") return VERIFY_BASE_URL_FALLBACK.tokenharbour;
    return null;
  };

  const targets = connections.filter((c) => {
    if (provider && c.provider !== provider) return false;
    const key = c.apiKey || c.accessToken;
    return !!(resolveBaseUrl(c) && key);
  });

  const job = createJob({
    kind: "verify",
    label: provider ? `Verifikasi key ${provider}` : "Verifikasi key semua akun",
    total: targets.length,
    meta: { provider },
  });

  void runJob(
    job,
    targets,
    async (conn) => {
      const baseUrl = resolveBaseUrl(conn);
      const key = conn.apiKey || conn.accessToken;
      const label = providerLabel(conn);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: conn.defaultModel || "default",
            messages: [{ role: "user", content: "say ok" }],
            max_tokens: 5,
            stream: false,
          }),
          signal: controller.signal,
        });
        const text = await res.text().catch(() => "");
        let okJson = false;
        try {
          const d = JSON.parse(text);
          okJson = !!(d?.choices || d?.data || d?.id);
        } catch { /* bukan JSON = bukan jawaban chat yang sah */ }
        const lower = text.toLowerCase();
        if (res.ok && okJson) {
          return {
            ok: true, id: conn.id, name: conn.name, email: conn.email, provider: label,
            state: "healthy", reason: "Key valid (inferensi OK)",
          };
        }
        if (res.status === 401 || res.status === 403 || /invalid|unauthorized|forbidden|revoked/.test(lower)) {
          return {
            ok: true, id: conn.id, name: conn.name, email: conn.email, provider: label,
            state: "invalid", reason: "Key ditolak (401/403)",
          };
        }
        if (res.status === 402 || /insufficient|credit|balance|quota|spending.?limit|depleted/.test(lower)) {
          return {
            ok: true, id: conn.id, name: conn.name, email: conn.email, provider: label,
            state: "depleted", reason: "Key habis (402/kuota)",
          };
        }
        if (res.status === 429 || /rate.?limit|too many/.test(lower)) {
          return {
            ok: true, id: conn.id, name: conn.name, email: conn.email, provider: label,
            state: "rate_limited", reason: "Kena laju sementara",
          };
        }
        return {
          ok: false, id: conn.id, name: conn.name, email: conn.email, provider: label,
          error: `HTTP ${res.status}: ${text.slice(0, 120) || "respons tak dikenal"}`,
        };
      } catch (err) {
        return {
          ok: true, id: conn.id, name: conn.name, email: conn.email, provider: label,
          state: "transient", reason: `Jaringan/timeout: ${err?.message || "gagal"}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    { concurrency: 6 },
  );

  return job;
}
