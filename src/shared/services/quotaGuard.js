// Shared by the server monitor and both account toolbars. No credentials here.
export const DEFAULT_QUOTA_GUARD = { enabled: false, thresholdPercent: 50 };
export const QUOTA_GUARD_INTERVAL_MS = 60_000;

export function normalizeQuotaGuard(value) {
  if (!value || typeof value.enabled !== "boolean"
    || typeof value.thresholdPercent !== "number" || !Number.isFinite(value.thresholdPercent)
    || value.thresholdPercent < 0 || value.thresholdPercent >= 100) {
    throw new Error("Quota guard requires enabled and a remaining percentage from 0 to less than 100");
  }
  return { enabled: value.enabled, thresholdPercent: value.thresholdPercent };
}

function percentage(quota) {
  if (!quota || quota.unlimited === true) return null;
  let result = quota.remainingPercentage;
  if (result == null && typeof quota.total === "number" && quota.total > 0) {
    if (typeof quota.remaining === "number") result = quota.remaining / quota.total * 100;
    else if (typeof quota.used === "number") result = (quota.total - quota.used) / quota.total * 100;
  }
  return typeof result === "number" && Number.isFinite(result) && result <= 100 ? Math.max(0, result) : null;
}

export function isQuotaGuardPaused(connection) {
  return connection.quotaGuard?.enabled === true && connection.quotaGuardState?.paused === true;
}

export function resumeQuotaGuard(state = {}, now = Date.now()) {
  return { ...state, paused: false, override: true, overrideStartedAt: new Date(now).toISOString(),
    overrideResets: Object.fromEntries(Object.entries(state.windows || {}).map(([key, window]) => [key, window.resetAt])) };
}

export function evaluateQuotaGuard(connection, usage, now = Date.now()) {
  const previous = connection.quotaGuardState || {};
  const checkedAt = new Date(now).toISOString();
  if (!connection.quotaGuard?.enabled) return { paused: false, override: false, checkedAt };

  const windows = {};
  for (const [name, quota] of Object.entries(usage?.quotas || {})) {
    // These providers also report unrelated review/model budgets. Protect the
    // account's shared session/weekly allowance, not a separate product's quota.
    if (connection.provider === "codex" && !["session", "weekly"].includes(name)) continue;
    if (connection.provider === "claude" && !["session (5h)", "weekly (7d)"].includes(name)) continue;
    const remainingPercent = percentage(quota);
    if (remainingPercent === null) continue;
    const resetMs = Date.parse(quota.resetAt);
    windows[name] = { remainingPercent, resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null };
  }

  const entries = Object.entries(windows);
  const incomplete = Object.keys(previous.windows || {}).some((name) => !windows[name]);
  if (!entries.length || usage?.error || usage?.message || usage?.stale) {
    return { ...previous, checkedAt, error: "Quota monitoring unavailable or incomplete; previous state retained" };
  }

  const remainingPercent = Math.min(...entries.map(([, window]) => window.remainingPercent));
  const belowThreshold = remainingPercent <= connection.quotaGuard.thresholdPercent;
  if (incomplete && !belowThreshold) {
    return { ...previous, checkedAt, error: "Quota monitoring incomplete; previous state retained" };
  }
  const resetConfirmed = Object.entries(previous.overrideResets || {}).some(([name, resetAt]) => (
    resetAt && Date.parse(resetAt) <= now && windows[name]?.resetAt
    && Date.parse(windows[name].resetAt) > Date.parse(resetAt)
  ));
  const override = previous.override === true && belowThreshold && !resetConfirmed;
  return {
    paused: belowThreshold && !override, override, checkedAt, remainingPercent,
    windows: incomplete ? { ...previous.windows, ...windows } : windows,
    ...(incomplete ? { error: "Quota monitoring incomplete" } : {}),
    ...(override ? { overrideResets: previous.overrideResets, overrideStartedAt: previous.overrideStartedAt } : {}),
  };
}
