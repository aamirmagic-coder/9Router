import { ensureDirs, DATA_FILE, BACKUPS_DIR } from "./paths.js";
import { openStateDatabase } from "./integrity.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

async function initAdapter() {
  ensureDirs();

  // The adapter chain itself now lives in adapterChain.js (it is shared with
  // the corrupt-DB recovery path, which validates backup candidates with the
  // same ordering). openStateDatabase() opens the healthy/missing file
  // unchanged, and for a damaged state DB it preserves the bytes, restores the
  // newest usable backup and reports loudly — a corrupt file never surfaces as
  // "[DB] No SQLite driver available …" any more. See integrity.js.
  const adapter = await openStateDatabase({ dataFile: DATA_FILE, backupsDir: BACKUPS_DIR });

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
