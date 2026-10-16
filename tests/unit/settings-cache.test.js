// Guards the getSettings() read cache added to settingsRepo.
//
// The risk this covers: if the cache were not invalidated on write, a settings
// edit would be invisible for up to the TTL. Each test therefore POPULATES the
// cache first (a getSettings read), then writes, then reads again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-settings-cache-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(async () => {
  // Close the SQLite handle first — on Windows an open DB file cannot be removed.
  try {
    const { getAdapterSync } = await import("@/lib/db/driver.js");
    getAdapterSync().close();
  } catch {}
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("settings read cache", () => {
  it("updateSettings is visible immediately after a cached read", async () => {
    const before = await db.getSettings(); // populates the cache
    expect(before.cloudEnabled).toBe(false);
    await db.updateSettings({ cloudEnabled: true });
    const after = await db.getSettings(); // must NOT be the stale cached row
    expect(after.cloudEnabled).toBe(true);
  });

  it("repeated reads stay correct and keep the default merge", async () => {
    const a = await db.getSettings();
    const b = await db.getSettings();
    expect(a.cloudEnabled).toBe(true);
    expect(b.cloudEnabled).toBe(true);
    expect(b.requireLogin).toBeDefined();
    expect(b.stickyRoundRobinLimit).toBeDefined();
    expect(b.observabilityBatchSize).toBeDefined();
  });

  it("exportSettings stays point-in-time (bypasses the cache)", async () => {
    await db.getSettings(); // cache says cloudEnabled=true
    await db.updateSettings({ cloudEnabled: false });
    const exported = await db.exportSettings();
    expect(exported.cloudEnabled).toBe(false);
  });

  it("importDb invalidates the cache", async () => {
    await db.getSettings(); // populate cache
    const dump = await db.exportDb();
    dump.settings = { ...dump.settings, cloudEnabled: true };
    await db.importDb(dump);
    const s = await db.getSettings();
    expect(s.cloudEnabled).toBe(true);
  });
});
