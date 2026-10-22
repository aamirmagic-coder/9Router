import { normalizeAllowList } from "@/shared/utils/keyAccess.js";

export default {
  version: 5,
  name: "canonical-key-policy",
  up(db) {
    const columns = new Set(db.all(`PRAGMA table_info(apiKeys)`).map((column) => column.name));
    if (!columns.has("accessRestricted")) db.exec(`ALTER TABLE apiKeys ADD COLUMN accessRestricted INTEGER DEFAULT 0`);
    if (!columns.has("accessAllow")) db.exec(`ALTER TABLE apiKeys ADD COLUMN accessAllow TEXT`);
    const rows = db.all(`SELECT id, allowedModels FROM apiKeys WHERE (accessRestricted = 0 OR accessRestricted IS NULL) AND allowedModels IS NOT NULL`);
    for (const row of rows) {
      let entries;
      try {
        entries = normalizeAllowList(JSON.parse(row.allowedModels));
      } catch {
        continue;
      }
      if (!entries.length) continue;
      db.run(`UPDATE apiKeys SET accessRestricted = 1, accessAllow = ? WHERE id = ? AND (accessRestricted = 0 OR accessRestricted IS NULL)`,
        [JSON.stringify(entries), row.id]);
    }
  },
};
