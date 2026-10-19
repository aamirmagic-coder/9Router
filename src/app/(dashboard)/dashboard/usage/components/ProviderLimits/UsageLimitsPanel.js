"use client";

import { formatResetTime, getQuotaVisibilityKey } from "./utils";

// Segmented gauge: 24 tiles, filled = consumed. Sized to read like a 12-step
// gauge without ever drawing a "half tile".
const SEGMENTS = 24;

// Command Code names its rows Credits / Session (5h) / Weekly. Show the window
// order a user thinks in, and say which rows count down and which land on a date.
const ROW_DISPLAY = {
  "session (5h)": { label: "5-hour limit", order: 0, countdown: true },
  weekly: { label: "weekly limit", order: 1, countdown: true },
  credits: { label: "monthly limit", order: 2, countdown: false },
};

function rowDisplay(name) {
  return ROW_DISPLAY[String(name || "").trim().toLowerCase()]
    || { label: name, order: 99, countdown: true };
}

function formatResetLine({ countdown, resetAt }) {
  const remaining = formatResetTime(resetAt);
  if (remaining === "-") return null;
  if (countdown) return `Resets in ${remaining}`;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return `Resets on ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export default function UsageLimitsPanel({ quotas = [], onHideQuota = null }) {
  if (quotas.length === 0) return null;

  const rows = quotas
    .map((quota, index) => {
      const display = rowDisplay(quota.name);
      const unlimited = quota.unlimited === true;
      const balance = quota.isCreditBalance === true;
      // The gauge and the number agree with each other and with the provider's
      // own dashboard: they report consumption, not headroom. A row with no known
      // cap shows what is left instead of pretending the limit is unlimited.
      const total = Number(quota.total) || 0;
      const consumed = Math.max(0, Number(quota.used) || 0);
      const usedPercent = unlimited || balance || total <= 0
        ? 0
        : Math.min(100, Math.round((consumed / total) * 100));
      return {
        quota,
        key: `${getQuotaVisibilityKey(quota) || quota.name}-${index}`,
        label: display.label,
        order: display.order,
        unlimited,
        balance,
        usedPercent,
        value: balance
          ? `${total.toLocaleString(undefined, { maximumFractionDigits: 2 })} left`
          : unlimited
            ? "Unlimited"
            : `${usedPercent}%`,
        filled: Math.round((usedPercent / 100) * SEGMENTS),
        reset: formatResetLine({ countdown: display.countdown, resetAt: quota.resetAt }),
      };
    })
    .sort((a, b) => a.order - b.order);

  const hideable = typeof onHideQuota === "function";

  return (
    <div className="flex flex-col gap-3 px-2 py-2">
      <div className="flex items-center gap-1.5">
        <span className="material-symbols-outlined fill-1 text-[16px] text-brand-600 dark:text-brand-400">
          verified_user
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
          Usage limits
        </span>
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.key} className="group flex min-w-0 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                {row.label}
              </span>
              <span className="flex shrink-0 items-baseline gap-1">
                <span
                  className={`text-[11px] font-semibold tabular-nums ${
                    !row.balance && !row.unlimited && row.usedPercent >= 100
                      ? "text-red-600 dark:text-red-400"
                      : "text-text-primary"
                  }`}
                >
                  {row.value}
                </span>
                {hideable && (
                  <button
                    type="button"
                    onClick={() => onHideQuota(row.quota)}
                    title="Hide this quota row"
                    aria-label={`Hide quota ${row.label}`}
                    className="rounded-md text-text-subtle opacity-0 transition-opacity hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <span className="material-symbols-outlined text-[13px]">visibility_off</span>
                  </button>
                )}
              </span>
            </div>

            {!row.unlimited && !row.balance && (
              <div
                role="img"
                aria-label={`${row.usedPercent}% used`}
                className="flex h-[18px] gap-[3px]"
              >
                {Array.from({ length: SEGMENTS }, (_, segment) => (
                  <span
                    key={segment}
                    className={`flex-1 rounded-[3px] ${
                      segment < row.filled
                        ? "bg-brand-500"
                        : "bg-brand-100 dark:bg-brand-500/20"
                    }`}
                  />
                ))}
              </div>
            )}

            {row.reset && (
              <span className="truncate text-[11px] text-text-muted">{row.reset}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
