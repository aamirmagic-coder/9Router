import { describe, expect, it } from "vitest";

// Import dynamically so the first run reports the missing behavior as assertions.
const guard = await import("../../src/shared/services/quotaGuard.js").catch(() => ({}));
const now = Date.parse("2026-10-16T10:00:00Z");
const resetAt = "2026-10-16T12:00:00Z";
const account = (provider = "codex", state = {}) => ({
  id: "account-1", provider, isActive: true,
  quotaGuard: { enabled: true, thresholdPercent: 50 }, quotaGuardState: state,
});
const usage = (remaining = 50, weekly = 80) => ({ quotas: {
  session: { used: 100 - remaining, total: 100, remaining, resetAt },
  weekly: { used: 100 - weekly, total: 100, remaining: weekly, resetAt: "2026-10-20T12:00:00Z" },
} });

describe("per-account quota guard", () => {
  it("pauses at the boundary and resumes only when every blocking window recovers", () => {
    expect(guard.evaluateQuotaGuard).toBeTypeOf("function");
    const paused = guard.evaluateQuotaGuard(account(), usage(), now);
    expect(paused.paused).toBe(true);
    expect(paused.remainingPercent).toBe(50);
    expect(guard.evaluateQuotaGuard(account("codex", paused), usage(90, 40), now).paused).toBe(true);
    expect(guard.evaluateQuotaGuard(account("codex", paused), usage(51, 80), now).paused).toBe(false);
  });

  it("uses each account's threshold and absolute units for any provider", () => {
    const conn = account("kiro");
    conn.quotaGuard.thresholdPercent = 20;
    const state = guard.evaluateQuotaGuard(conn, { quotas: { credits: { used: 81, total: 100 } } }, now);
    expect(state.paused).toBe(true);
    expect(state.remainingPercent).toBe(19);
    expect(guard.evaluateQuotaGuard(account("other"), { quotas: { credits: { remaining: 60, total: 200 } } }, now).remainingPercent).toBe(30);
  });

  it("ignores unrelated Codex and Claude model quotas", () => {
    const data = usage(80, 80);
    data.quotas.review_weekly = { remaining: 0, total: 100 };
    data.quotas.spark_session = { remaining: 0, total: 100 };
    expect(guard.evaluateQuotaGuard(account(), data, now).paused).toBe(false);
    expect(guard.evaluateQuotaGuard(account("claude"), { quotas: {
      "session (5h)": { remainingPercentage: 80 },
      "weekly (7d)": { remainingPercentage: 80 },
      "weekly fable (7d)": { remainingPercentage: 0 },
    } }, now).paused).toBe(false);
  });

  it("never recovers from failed, malformed, unlimited-only, or missing window data", () => {
    const paused = guard.evaluateQuotaGuard(account(), usage(40), now);
    for (const data of [{}, { message: "Unauthorized" }, { ...usage(90), stale: true }, { quotas: {} }, { quotas: { session: { unlimited: true } } },
      { quotas: { session: { remaining: null, total: 100 } } },
      { quotas: { session: { remainingPercentage: 101 } } },
      { quotas: { session: { remaining: 90, total: 100 } } }]) {
      expect(guard.evaluateQuotaGuard(account("codex", paused), data, now).paused).toBe(true);
    }
  });

  it("holds a manual resume until recovery or a confirmed reset", () => {
    const paused = guard.evaluateQuotaGuard(account(), usage(40), now);
    const resumed = guard.resumeQuotaGuard(paused, now);
    expect(resumed.paused).toBe(false);
    expect(guard.evaluateQuotaGuard(account("codex", resumed), usage(35), now).paused).toBe(false);
    // A timer reaching resetAt alone is not evidence of a successful reset.
    expect(guard.evaluateQuotaGuard(account("codex", resumed), usage(35), now + 3 * 3600000).paused).toBe(false);
    const reset = usage(40);
    reset.quotas.session.resetAt = "2026-10-16T17:00:00Z";
    const checked = guard.evaluateQuotaGuard(account("codex", resumed), reset, now + 3 * 3600000);
    expect(checked.override).toBe(false);
    expect(checked.paused).toBe(true);
    expect(guard.evaluateQuotaGuard(account("codex", resumed), usage(90), now).override).toBe(false);
  });

  it("validates percentage settings without accepting client-supplied pause state", () => {
    for (const value of [-1, 100, null, "50", Infinity]) {
      expect(() => guard.normalizeQuotaGuard({ enabled: true, thresholdPercent: value })).toThrow();
    }
    expect(guard.normalizeQuotaGuard({ enabled: true, thresholdPercent: 50, paused: false })).toEqual({ enabled: true, thresholdPercent: 50 });
    expect(guard.normalizeQuotaGuard({ enabled: false, thresholdPercent: 0 }).thresholdPercent).toBe(0);
  });

  it("treats overdrawn quotas as exhausted rather than unavailable", () => {
    const state = guard.evaluateQuotaGuard(account("kiro"), { quotas: { credits: { used: 120, total: 100, remaining: -20 } } }, now);
    expect(state.paused).toBe(true);
    expect(state.remainingPercent).toBe(0);
  });

  it("pauses on a known low window even when another window is missing", () => {
    const active = guard.evaluateQuotaGuard(account(), usage(80, 80), now);
    const state = guard.evaluateQuotaGuard(account("codex", active), { quotas: { session: { remaining: 20, total: 100 } } }, now);
    expect(state.paused).toBe(true);
    expect(state.windows.weekly).toEqual(active.windows.weekly);
  });
});
