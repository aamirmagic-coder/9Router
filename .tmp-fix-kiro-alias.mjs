import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = path.join(os.homedir(), "AppData", "Roaming", "9router");
const dbPath = path.join(dataDir, "db", "data.sqlite");
const cachePath = path.join(dataDir, "mitm", "aliases.json");

const db = new DatabaseSync(dbPath);

// Read current kiro mapping
const row = db.prepare("SELECT value FROM kv WHERE scope = 'mitmAlias' AND key = 'kiro'").get();
const current = row ? JSON.parse(row.value) : {};
console.log("BEFORE:", JSON.stringify(current, null, 2));

// Apply requested changes:
// - qwen3-coder-next → rv/moonshotai/Kimi-K3 (options A)
// - simple-task → "" (passthrough, editable from dashboard)
const next = {
  ...current,
  "qwen3-coder-next": "rv/moonshotai/Kimi-K3",
  "simple-task": "",
};

db.prepare(
  "INSERT INTO kv(scope, key, value) VALUES('mitmAlias', 'kiro', ?) " +
  "ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value"
).run(JSON.stringify(next));

const verify = JSON.parse(
  db.prepare("SELECT value FROM kv WHERE scope = 'mitmAlias' AND key = 'kiro'").get().value
);
console.log("\nAFTER (DB):", JSON.stringify(verify, null, 2));
db.close();

// Sync every mitmAlias tool into the MITM JSON cache (same logic as syncToJson)
const db2 = new DatabaseSync(dbPath, { readOnly: true });
const allRows = db2.prepare("SELECT key, value FROM kv WHERE scope = 'mitmAlias'").all();
const cache = {};
for (const r of allRows) cache[r.key] = JSON.parse(r.value);
db2.close();

fs.mkdirSync(path.dirname(cachePath), { recursive: true });
const tmp = `${cachePath}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
fs.renameSync(tmp, cachePath);

console.log("\nAFTER (cache file):");
console.log(fs.readFileSync(cachePath, "utf8"));
