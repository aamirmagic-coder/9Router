import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(testDir, "../..");
const read = (relativePath) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("compatible provider UI contract", () => {
  it("posts the explicit replay policy and warns about post-dispatch retries", () => {
    const addModal = read("src/app/(dashboard)/dashboard/providers/components/AddCompatibleModal.js");
    const editModal = read("src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js");

    for (const source of [addModal, editModal]) {
      expect(source).toContain("replayPolicy");
      expect(source).toContain("non-replayable");
      expect(source).toContain("stops account and combo retries after native dispatch begins");
    }
    expect(addModal).toContain("body: JSON.stringify({");
    expect(editModal).toContain("payload.replayPolicy = formData.replayPolicy");
  });

  it("keeps model discovery driven by the configured provider prefix", () => {
    const modelsRoute = read("src/app/api/v1/models/route.js");
    expect(modelsRoute).toContain("conn?.providerSpecificData?.prefix");
    expect(modelsRoute).toContain("fetchCompatibleModelIds(conn)");
    expect(modelsRoute).toContain("id: `${outputAlias}/${modelId}`");
  });

  it("blocks unsafe fusion selection while retaining ordinary combo strategies", () => {
    const combosPage = read("src/app/(dashboard)/dashboard/combos/page.js");
    expect(combosPage).toContain("findNonReplayableMember");
    expect(combosPage).toContain("Fusion is unavailable");
    expect(combosPage).toContain('nextStrategy === "fusion"');
    expect(combosPage).toContain('value: "fallback"');
  });
});
