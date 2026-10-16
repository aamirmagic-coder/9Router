/**
 * Filter seleksi akun untuk menu Automation — MURNI, tanpa import server.
 *
 * Dipakai langsung oleh komponen klien (ProviderPanel) DAN diekspor ulang oleh
 * `operations.js` untuk tes. Alasannya: `operations.js` mengimpor `@/lib/localDb`
 * (SQLite) sehingga tidak bisa diimpor komponen klien; logika seleksi di sini
 * hanya membaca objek koneksi/hasil yang sudah ada di tangan klien.
 *
 * Semua aturan disalin dari skrip Python sumbernya, dengan dua pengecualian
 * yang disengaja (lihat operations.js): "tidak terbaca" tidak pernah berarti
 * habis, dan kesalahan jaringan tidak pernah masuk daftar hapus.
 */

/** Nama provider yang bisa dibaca — versi ringan dari operations.js. */
function labelOf(c) {
  const node = c?.providerSpecificData?.nodeName;
  if (node && node !== c.provider && !/^openai-compatible-chat-/.test(node)) return node;
  return c?.provider || c?.providerLabel || "?";
}

/**
 * Pilih rentang indeks ala skrip `ag` menu 5: "50", "1,5,12", "1-10", "all".
 * `items` = daftar berurutan yang terlihat di layar (1-based seperti skrip).
 * Mengembalikan subset — indeks di luar rentang diabaikan diam-diam.
 */
export function selectByIndex(items, raw) {
  const list = Array.isArray(items) ? items : [];
  const q = String(raw || "").trim().toLowerCase();
  if (!q || q === "all") return list;
  const picked = new Set();
  for (const part of q.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (part.includes("-")) {
      const [a, b] = part.split("-", 2).map((v) => Number(v.trim()));
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.max(1, Math.min(a, b));
      const hi = Math.min(list.length, Math.max(a, b));
      for (let i = lo; i <= hi; i++) picked.add(i - 1);
    } else {
      const n = Number(part);
      if (Number.isFinite(n) && n >= 1 && n <= list.length) picked.add(n - 1);
    }
  }
  return [...picked].sort((a, b) => a - b).map((i) => list[i]);
}

/**
 * Kandidat hapus Antigravity per mode grup (menu 7 skrip `ag`).
 *
 * `results` = hasil job kuota (tiap baris membawa `groups: {gemini, claudeGpt}`
 * dari classifyUsage). Ambang "0%" = `< 1`, persis seperti skrip — TAPI grup
 * `null` (tidak terbaca) tidak pernah lolos, tidak seperti skrip yang
 * menghilangkan sentinel -1.
 *
 * mode: "claude" | "gemini" | "both".
 */
export function selectAgGroupDepleted(results, mode) {
  const picked = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!r) continue;
    const g = r.groups || {};
    const c0 = typeof g.claudeGpt === "number" && g.claudeGpt < 1;
    const g0 = typeof g.gemini === "number" && g.gemini < 1;
    const hit = mode === "claude" ? c0 : mode === "gemini" ? g0 : c0 && g0;
    if (hit) {
      picked.push({
        ...r,
        deleteReason:
          mode === "claude" ? "Claude & GPT habis (< 1%)"
          : mode === "gemini" ? "Gemini habis (< 1%)"
          : "Keduanya habis (< 1%)",
      });
    }
  }
  return picked;
}

/**
 * Kategori akun Cline ala skrip (menu 5: MATI / LIMIT / ERROR / EXPIRED).
 *
 * Dibaca dari baris koneksi yang sudah diklasifikasi server (`errorState`,
 * `lastError`, `expiresAt`) — bukan dari hasil pemindaian, karena kategori ini
 * justru untuk akun yang gagal sebelum sempat dipindai.
 */
export function clineCategory(row, nowMs = Date.now()) {
  if (!row) return null;
  const exp = row.expiresAt ? Date.parse(row.expiresAt) : NaN;
  if (Number.isFinite(exp) && exp <= nowMs) return "expired";
  if (row.errorState === "invalid") return "mati";
  if (row.errorState === "rate_limited") return "limit";
  if (row.errorState === "transient" || row.errorState === "other") return "error";
  return null;
}

export const CLINE_CATEGORY_LABEL = {
  mati: "MATI (kredensial ditolak)",
  limit: "LIMIT (429 laju)",
  error: "ERROR (jaringan/server)",
  expired: "EXPIRED (token kedaluwarsa)",
};

export function selectClineByCategory(rows, category, nowMs = Date.now()) {
  const picked = [];
  for (const c of rows || []) {
    if (clineCategory(c, nowMs) !== category) continue;
    picked.push({
      ...c,
      id: c.id,
      email: c.email,
      name: c.name,
      provider: labelOf(c),
      state: category,
      deleteReason: CLINE_CATEGORY_LABEL[category] || category,
    });
  }
  return picked;
}

/**
 * Akun TokenHarbor yang kedaluwarsa (menu 5-6 skrip tokenharbor).
 *
 * `expiresAt` dibaca dari kolom koneksi ATAU `data.expiresAt` (skrip menulisnya
 * di `data.expiresAt` + `data.expireHours`). Gagal parse = permanen, tidak
 * pernah dipilih — aturan `_parse_iso` di skrip. Yang sudah nonaktif diabaikan.
 */
export function selectExpiredConnections(connections, { hoursAhead = 0, nowMs = Date.now() } = {}) {
  const picked = [];
  for (const c of connections || []) {
    if (!c) continue;
    if (c.isActive === false) continue;
    const raw = c.expiresAt ?? c?.data?.expiresAt ?? c?.providerSpecificData?.expiresAt;
    if (raw == null || raw === "" || raw === "None" || raw === "null") continue;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) continue;
    const remainingMs = t - nowMs;
    if (remainingMs <= hoursAhead * 3_600_000) {
      picked.push({
        ...c,
        id: c.id,
        email: c.email,
        name: c.name,
        provider: labelOf(c),
        state: remainingMs <= 0 ? "expired" : "expiring",
        expiresAt: new Date(t).toISOString(),
        remainingMs,
        deleteReason: remainingMs <= 0 ? "Masa berlaku habis" : "Segera kedaluwarsa",
      });
    }
  }
  picked.sort((a, b) => a.remainingMs - b.remainingMs);
  return picked;
}

/**
 * Klasifikasi alasan nonaktif ala `classify_inactive_account` skrip `ag`:
 * invalid_grant, domain_dead:<domain>, auth_401, error_status, lainnya,
 * tanpa_alasan.
 */
export function classifyInactiveAccount(connection) {
  const raw = String(connection?.lastError || "");
  const code = Number(connection?.errorCode);
  if (/invalid_grant|revoked/i.test(raw)) return "invalid_grant";
  const dm = /domain_dead:([^\s,;]+)/i.exec(raw);
  if (dm) return `domain_dead:${dm[1]}`;
  if (code === 401 || /\b401\b/.test(raw)) return "auth_401";
  if (connection?.testStatus === "error" || code >= 400) return "error_status";
  if (raw) return "lainnya";
  return "tanpa_alasan";
}

/**
 * Akun nonaktif (menu 12 skrip `ag`).
 *
 * Fail-safe DITIRU persis: hanya `isActive === false` (identitas ketat) yang
 * dianggap nonaktif; key absen/null dihitung AKTIF.
 */
export function selectInactiveConnections(connections) {
  const picked = [];
  for (const c of connections || []) {
    if (!c) continue;
    if (c.isActive !== false) continue;
    const reason = classifyInactiveAccount(c);
    picked.push({
      ...c,
      id: c.id,
      email: c.email,
      name: c.name,
      provider: labelOf(c),
      state: "inactive",
      inactiveReason: reason,
      deleteReason: `Nonaktif (${reason})`,
    });
  }
  return picked;
}

/** Sebaran domain dari SEMUA koneksi — ala skrip AG (`dead` = 0 aktif). */
export function domainBreakdown(connections) {
  const map = {};
  for (const c of connections || []) {
    const email = String(c?.email || "");
    const domain = email.includes("@") ? email.split("@").pop().toLowerCase() : "(tanpa email)";
    const row = (map[domain] ||= { domain, total: 0, active: 0, inactive: 0 });
    row.total++;
    if (c.isActive === false) row.inactive++;
    else row.active++;
  }
  const rows = Object.values(map).sort((a, b) => b.total - a.total);
  for (const r of rows) r.dead = r.total > 0 && r.active === 0;
  return rows;
}
