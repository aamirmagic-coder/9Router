// Add cachedQuotas column to providerConnections table for quota-aware routing.
export default {
  version: 2,
  name: "add-cached-quotas",
  up(db) {
    const existing = db.all("PRAGMA table_info(providerConnections)");
    if (!existing.some((c) => c.name === "cachedQuotas")) {
      db.exec("ALTER TABLE providerConnections ADD COLUMN cachedQuotas TEXT");
    }
  },
};
