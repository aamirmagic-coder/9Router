import { describe, expect, it } from "vitest";
import { resolveQuotaForModel } from "../../src/sse/services/antigravityQuota.js";

// Antigravity meters quota per POOL, not per model. A free-tier account reports
// only the two weekly buckets — there are no per-model entries — so an exact
// `quotas[model]` lookup missed and an exhausted pool looked "unknown".
const WEEKLY_ONLY = {
  gemini_weekly: { remainingPercentage: 0, resetAt: "2026-09-24T22:58:59Z" },
  claude_gpt_weekly: { remainingPercentage: 100, resetAt: "2026-09-24T22:58:59Z" },
};

describe("resolveQuotaForModel — pool-aware lookup", () => {
  it("maps gemini models onto the gemini weekly bucket", () => {
    expect(resolveQuotaForModel(WEEKLY_ONLY, "gemini-3.8-flash-high")).toBe(WEEKLY_ONLY.gemini_weekly);
    expect(resolveQuotaForModel(WEEKLY_ONLY, "gemini-3.1-pro-low")).toBe(WEEKLY_ONLY.gemini_weekly);
  });

  it("maps claude and gpt models onto the shared 3p weekly bucket", () => {
    expect(resolveQuotaForModel(WEEKLY_ONLY, "claude-sonnet-4-6")).toBe(WEEKLY_ONLY.claude_gpt_weekly);
    expect(resolveQuotaForModel(WEEKLY_ONLY, "claude-opus-4-6-thinking")).toBe(WEEKLY_ONLY.claude_gpt_weekly);
    expect(resolveQuotaForModel(WEEKLY_ONLY, "gpt-oss-120b-medium")).toBe(WEEKLY_ONLY.claude_gpt_weekly);
  });

  it("prefers an exact per-model entry when one exists", () => {
    const quotas = { ...WEEKLY_ONLY, "gemini-3.8-flash-high": { remainingPercentage: 42 } };
    expect(resolveQuotaForModel(quotas, "gemini-3.8-flash-high")).toEqual({ remainingPercentage: 42 });
  });

  it("recognises the 3p bucket name used for Claude/GPT pools", () => {
    expect(resolveQuotaForModel({ "3p-weekly": { remainingPercentage: 7 } }, "claude-opus-4-6-thinking"))
      .toEqual({ remainingPercentage: 7 });
  });

  it("returns undefined instead of guessing for unknown models", () => {
    expect(resolveQuotaForModel(WEEKLY_ONLY, "muse-spark-1.3")).toBeUndefined();
    expect(resolveQuotaForModel(WEEKLY_ONLY, "")).toBeUndefined();
    expect(resolveQuotaForModel({}, "gemini-3.8-flash-high")).toBeUndefined();
    expect(resolveQuotaForModel(null, "gemini-3.8-flash-high")).toBeUndefined();
  });
});
