export default {
  version: 6,
  name: "usage-request-identity",
  up(db) {
    const columns = new Set(db.all(`PRAGMA table_info(usageHistory)`).map((column) => column.name));
    if (!columns.has("requestId")) db.exec(`ALTER TABLE usageHistory ADD COLUMN requestId TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_request_id ON usageHistory(requestId)`);
  },
};
