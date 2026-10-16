/**
 * Logika menu "Choose Interface" — dipisah dari cli.js supaya bisa diuji.
 *
 * cli.js menjalankan dirinya di module scope (startServer, bahkan
 * process.exit kalau standalone build tidak ada), jadi mengimpornya dari test
 * akan menjalankan CLI sungguhan. Fungsi-fungsi di sini murni: tidak menyentuh
 * proses, jaringan, atau berkas.
 */

/**
 * Susun daftar item menu.
 *
 * Setiap item membawa `action`-nya sendiri, dan aksi dibaca dari array ini —
 * bukan dari konstanta offset yang dihitung manual.
 *
 * Bug yang dihilangkan (v0.5.113): dulu pembacaannya memakai `offset + N`
 * hardcoded dan TIDAK ADA cabang yang menangani indeks "Exit". Memilih Exit
 * mengembalikan "back" — menu muncul lagi, server tetap hidup, dan opsi itu
 * tampak tidak berfungsi. Bug yang sama mengintai setiap kali item ditambah
 * atau diurutkan ulang, karena nomornya harus diperbarui manual di dua tempat.
 *
 * @param {string|null} latestVersion
 * @param {string} currentVersion
 * @returns {Array<{label:string, icon:string, action:string}>}
 */
function buildInterfaceMenuItems(latestVersion, currentVersion) {
  const items = [];

  if (latestVersion) {
    items.push({
      label: `Update to v${latestVersion} (current: v${currentVersion})`,
      icon: "⬆",
      action: "update",
    });
  }

  items.push(
    { label: "Web UI (Open in Browser)", icon: "🌐", action: "web" },
    { label: "Terminal UI (Interactive CLI)", icon: "💻", action: "terminal" },
    { label: "Hide to Tray (Background)", icon: "🔔", action: "hide" },
    { label: "Exit", icon: "🚪", action: "exit" }
  );

  return items;
}

/**
 * Terjemahkan indeks pilihan menu menjadi aksi.
 *
 * @param {number} selected  indeks dari selectMenu; -1 = ESC / bukan TTY
 * @param {string|null} latestVersion
 * @param {string} currentVersion
 * @returns {"update"|"web"|"terminal"|"hide"|"exit"|"back"}
 */
function resolveMenuAction(selected, latestVersion, currentVersion) {
  // `selectMenu` mengembalikan -1 untuk dua hal yang SAMA SEKALI BUKAN "exit":
  //   - ESC ditekan (input.js: resolve(-1))
  //   - stdin bukan TTY, mis. CLI dijalankan dari skrip / terminal tanpa TTY
  //
  // Dulu keduanya jatuh ke `return "exit"`, dan pemanggilnya menjalankan
  // cleanup() yang MEMBUNUH server. Akibatnya menekan ESC sekali saja sudah
  // cukup untuk mematikan gateway — inilah keluhan "tiba-tiba berhenti".
  // Sekarang: batalkan saja, jangan sentuh server.
  if (selected === -1) return "back";

  const items = buildInterfaceMenuItems(latestVersion, currentVersion);
  const item = items[selected];
  // Indeks tak dikenal: jangan pernah menafsirkannya sebagai perintah mematikan
  // server. Lebih baik tampilkan menu lagi.
  return item?.action || "back";
}

module.exports = { buildInterfaceMenuItems, resolveMenuAction };
