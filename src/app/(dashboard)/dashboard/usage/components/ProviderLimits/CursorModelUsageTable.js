"use client";

/**
 * Compact per-model token + billed-cost table for Cursor aggregated usage.
 * costUsd is Cursor's billed amount (from totalCents), not a local estimate.
 */

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}K`;
  return String(v);
}

function formatCost(usd) {
  const v = Number(usd) || 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export default function CursorModelUsageTable({ modelUsage = [] }) {
  if (!Array.isArray(modelUsage) || modelUsage.length === 0) return null;

  const sorted = [...modelUsage].sort(
    (a, b) => (b.costUsd || 0) - (a.costUsd || 0) || String(a.model).localeCompare(String(b.model)),
  );

  return (
    <div className="mt-2 border-t border-black/5 pt-2 dark:border-white/5">
      <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
        API tokens (this cycle)
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] border-collapse text-[10px] tabular-nums">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="px-1 py-0.5 font-medium">Model</th>
              <th className="px-1 py-0.5 text-right font-medium">In</th>
              <th className="px-1 py-0.5 text-right font-medium">Out</th>
              <th className="px-1 py-0.5 text-right font-medium">Cache R</th>
              <th className="px-1 py-0.5 text-right font-medium">Cache W</th>
              <th className="px-1 py-0.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.model}
                className="border-t border-black/5 text-text-primary dark:border-white/5"
              >
                <td className="max-w-[8rem] truncate px-1 py-0.5 font-medium" title={row.model}>
                  {row.model}
                </td>
                <td className="px-1 py-0.5 text-right text-text-muted">
                  {formatTokens(row.inputTokens)}
                </td>
                <td className="px-1 py-0.5 text-right text-text-muted">
                  {formatTokens(row.outputTokens)}
                </td>
                <td className="px-1 py-0.5 text-right text-text-muted">
                  {formatTokens(row.cacheReadTokens)}
                </td>
                <td className="px-1 py-0.5 text-right text-text-muted">
                  {formatTokens(row.cacheWriteTokens)}
                </td>
                <td className="px-1 py-0.5 text-right font-medium">
                  {formatCost(row.costUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
