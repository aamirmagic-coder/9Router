// Best-effort temp-dir removal for tests.
// On Windows the SQLite file of the DB under test can still be held open by the
// adapter (the db layer exposes no close()), so rmSync throws EPERM/EBUSY. That
// is an environment artefact, not a product failure: retry, then give up quietly
// and leave the folder to the OS temp cleaner.
import fs from "node:fs";

export function removeTempDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (err) {
    if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(err?.code)) throw err;
  }
}
