import { describe, expect, it, vi } from "vitest";
const monitor = await import("../../src/shared/services/quotaGuardMonitor.js").catch(() => ({}));
const conn = (id, extra = {}) => ({ id, provider: "kiro", isActive: true, quotaGuard: { enabled: true, thresholdPercent: 50 }, ...extra });
const usage = (remaining) => ({ quotas: { credits: { remaining, total: 100 } } });

function setup(connections) {
  const saved = new Map(connections.map((c) => [c.id, structuredClone(c)]));
  return { saved, deps: {
    loadConnections: async () => [...saved.values()],
    readConnection: async (id) => saved.get(id),
    fetchUsage: async () => usage(40),
    saveState: async (connection, state) => {
      const current = saved.get(connection.id);
      if (JSON.stringify(current) !== JSON.stringify(connection)) return null;
      const next = { ...current, quotaGuardState: state };
      saved.set(connection.id, next);
      return next;
    },
  } };
}

describe("unattended quota monitoring", () => {
  it("checks active and automatically paused accounts, then recovers without a dashboard", async () => {
    expect(monitor.runQuotaGuardTick).toBeTypeOf("function");
    const { saved, deps } = setup([conn("a"), conn("b", { isActive: false }), conn("c", { quotaGuard: { enabled: false } })]);
    await monitor.runQuotaGuardTick(deps, {});
    expect(saved.get("a").quotaGuardState.paused).toBe(true);
    expect(saved.get("b").quotaGuardState).toBeUndefined();
    expect(saved.get("c").quotaGuardState).toBeUndefined();
    deps.fetchUsage = async () => usage(90);
    await monitor.runQuotaGuardTick(deps, {});
    expect(saved.get("a").quotaGuardState.paused).toBe(false);
    expect(saved.get("b").isActive).toBe(false);
  });

  it("isolates provider failures and retains an existing pause", async () => {
    const { saved, deps } = setup([conn("a", { quotaGuardState: { paused: true } }), conn("b")]);
    deps.fetchUsage = async (c) => { if (c.id === "a") throw new Error("provider offline"); return usage(20); };
    await monitor.runQuotaGuardTick(deps, {});
    expect(saved.get("a").quotaGuardState.paused).toBe(true);
    expect(saved.get("a").quotaGuardState.error).toBeTruthy();
    expect(saved.get("b").quotaGuardState.paused).toBe(true);
  });

  it("does not overwrite a manual resume or settings change during an in-flight check", async () => {
    const { saved, deps } = setup([conn("a")]);
    deps.fetchUsage = async () => {
      saved.set("a", { ...saved.get("a"), quotaGuardState: { paused: false, override: true } });
      return usage(10);
    };
    await monitor.runQuotaGuardTick(deps, {});
    expect(saved.get("a").quotaGuardState.override).toBe(true);
    expect(saved.get("a").quotaGuardState.paused).toBe(false);
  });

  it("does not overlap ticks", async () => {
    const { deps } = setup([conn("a")]);
    deps.loadConnections = vi.fn();
    await monitor.runQuotaGuardTick(deps, { running: true });
    expect(deps.loadConnections).not.toHaveBeenCalled();
  });

  it("checks other accounts while one provider is slow", async () => {
    const { saved, deps } = setup([conn("slow"), conn("ready")]);
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    deps.fetchUsage = async (c) => c.id === "slow" ? slow : usage(20);
    const tick = monitor.runQuotaGuardTick(deps, {});
    // Flush asynchronous loading, quota evaluation, and the save.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const readyState = saved.get("ready").quotaGuardState;
    release(usage(20));
    await tick;
    expect(readyState?.paused).toBe(true);
  });
});
