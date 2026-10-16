import { describe, expect, it } from "vitest";
import { removeComboModels } from "@/shared/components/ComboFormModal.js";

describe("removeComboModels", () => {
  it("removes an account-pinned model selected in a batch while retaining untouched entry identity", () => {
    const pinned = { model: "provider/remove-me", connectionId: "account-1" };
    const retained = { model: "provider/keep-me", connectionId: "account-2" };
    const models = [pinned, retained, "provider/also-keep"];

    const remaining = removeComboModels(models, new Set(["provider/remove-me"]));

    expect(remaining).toEqual([retained, "provider/also-keep"]);
    expect(remaining[0]).toBe(retained);
  });
});
