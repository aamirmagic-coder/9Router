/**
 * Cursor IDE usage — DashboardService Connect JSON on api2.cursor.sh.
 *
 * Pro / Team / Ultra: POST GetCurrentPeriodUsage (Cursor/Other model %).
 * Per-model tokens + billed cost: POST GetAggregatedUsageEvents (fail-open).
 * Enterprise request buckets: GET /auth/usage as fallback.
 * Plan label: POST GetPlanInfo (fail-open).
 * No Plan (USD) progress bar — spend lives in modelUsage cost column.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";
import { buildCursorHeaders } from "../../utils/cursorChecksum.js";

const CURSOR_USAGE = U("cursor");

function centsToUsd(cents) {
  return Number((toFiniteNumber(cents, 0) / 100).toFixed(2));
}

function remainingFromPercentUsed(percentUsed) {
  const used = Math.max(0, Math.min(100, toFiniteNumber(percentUsed, 0)));
  return Math.max(0, 100 - used);
}

function connectJsonHeaders(accessToken, machineId) {
  return {
    ...buildCursorHeaders(accessToken, machineId || null, true),
    "content-type": "application/json",
    accept: "application/json",
  };
}

async function postConnectJson(url, accessToken, machineId, proxyOptions) {
  return proxyAwareFetch(
    url,
    {
      method: "POST",
      headers: connectJsonHeaders(accessToken, machineId),
      body: "{}",
    },
    proxyOptions,
  );
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function addPlanSpendQuotas(quotas, data) {
  const planUsage = data?.planUsage;
  if (!planUsage || typeof planUsage !== "object") return false;

  // Match Cursor's Plan & Usage page: percent bars for Cursor Models /
  // Other Models only — no Plan (USD) progress bar (spend is in modelUsage).
  const resetAt = parseResetTime(data.billingCycleEnd);

  if (planUsage.autoPercentUsed != null) {
    const used = toFiniteNumber(planUsage.autoPercentUsed, 0);
    quotas["Cursor Models (%)"] = {
      used,
      total: 100,
      remainingPercentage: remainingFromPercentUsed(used),
      resetAt,
    };
  }
  if (planUsage.apiPercentUsed != null) {
    const used = toFiniteNumber(planUsage.apiPercentUsed, 0);
    quotas["Other Models (%)"] = {
      used,
      total: 100,
      remainingPercentage: remainingFromPercentUsed(used),
      resetAt,
    };
  }

  // Fallback when Cursor only returns a combined percent (no auto/api split).
  if (
    Object.keys(quotas).length === 0 &&
    planUsage.totalPercentUsed != null
  ) {
    const used = toFiniteNumber(planUsage.totalPercentUsed, 0);
    quotas["Included usage (%)"] = {
      used,
      total: 100,
      remainingPercentage: remainingFromPercentUsed(used),
      resetAt,
    };
  }

  return Object.keys(quotas).length > 0;
}

function addOnDemandQuota(quotas, data) {
  const spend = data?.spendLimitUsage;
  if (!spend || typeof spend !== "object") return;

  const individualLimit = toFiniteNumber(spend.individualLimit, 0);
  const pooledLimit = toFiniteNumber(spend.pooledLimit, 0);
  const resetAt = parseResetTime(data.billingCycleEnd);

  if (individualLimit > 0) {
    const used = centsToUsd(spend.individualUsed);
    const total = centsToUsd(individualLimit);
    const remainingUsd = centsToUsd(
      spend.individualRemaining ?? Math.max(0, individualLimit - toFiniteNumber(spend.individualUsed, 0)),
    );
    quotas["On-demand (USD)"] = {
      used,
      total,
      remainingPercentage: total > 0 ? (remainingUsd / total) * 100 : 0,
      resetAt,
    };
    return;
  }

  if (pooledLimit > 0) {
    const used = centsToUsd(spend.pooledUsed);
    const total = centsToUsd(pooledLimit);
    const remainingUsd = centsToUsd(
      spend.pooledRemaining ?? Math.max(0, pooledLimit - toFiniteNumber(spend.pooledUsed, 0)),
    );
    quotas["Team on-demand (USD)"] = {
      used,
      total,
      remainingPercentage: total > 0 ? (remainingUsd / total) * 100 : 0,
      resetAt,
    };
  }
}

function addAuthUsageQuotas(quotas, data) {
  if (!data || typeof data !== "object") return false;
  const resetAt = parseResetTime(data.startOfMonth);
  let added = false;

  for (const [key, bucket] of Object.entries(data)) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    const total = toFiniteNumber(bucket.maxRequestUsage, 0);
    if (total <= 0) continue;
    const used = toFiniteNumber(bucket.numRequests, 0);
    quotas[`${key} requests`] = {
      used,
      total,
      remainingPercentage: total > 0 ? Math.max(0, ((total - used) / total) * 100) : 0,
      resetAt,
    };
    added = true;
  }

  return added;
}

function parseTokenCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return 0;
}

/**
 * Map GetAggregatedUsageEvents aggregations into modelUsage rows.
 * costUsd is Cursor's billed amount (totalCents/100), not a local $/1M estimate.
 */
export function mapAggregatedUsageEvents(data) {
  const rows = Array.isArray(data?.aggregations) ? data.aggregations : [];
  const modelUsage = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const model = typeof row.modelIntent === "string" ? row.modelIntent.trim() : "";
    if (!model) continue;

    modelUsage.push({
      model,
      inputTokens: parseTokenCount(row.inputTokens),
      outputTokens: parseTokenCount(row.outputTokens),
      cacheReadTokens: parseTokenCount(row.cacheReadTokens),
      cacheWriteTokens: parseTokenCount(row.cacheWriteTokens),
      costUsd: Number((toFiniteNumber(row.totalCents, 0) / 100).toFixed(4)),
    });
  }

  modelUsage.sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
  return modelUsage;
}

async function fetchModelUsage(aggregatedUrl, token, machineId, proxyOptions) {
  if (!aggregatedUrl) return [];
  try {
    const response = await postConnectJson(aggregatedUrl, token, machineId, proxyOptions);
    if (!response?.ok) return [];
    return mapAggregatedUsageEvents(await readJson(response));
  } catch {
    return [];
  }
}

export async function getCursorUsage(accessToken, providerSpecificData = {}, proxyOptions = null) {
  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    return { message: "Cursor access token not available. Reconnect Cursor to view quota." };
  }

  const token = accessToken.trim();
  const machineId = providerSpecificData?.machineId || null;
  const periodUrl = CURSOR_USAGE.url;
  const planInfoUrl = CURSOR_USAGE.planInfoUrl;
  const authUsageUrl = CURSOR_USAGE.authUsageUrl;
  const aggregatedUrl = CURSOR_USAGE.aggregatedUrl;

  if (!periodUrl) {
    return { message: "Cursor usage endpoint is not configured." };
  }

  try {
    const periodResponse = await postConnectJson(periodUrl, token, machineId, proxyOptions);

    if (periodResponse.status === 401 || periodResponse.status === 403) {
      return {
        plan: "Cursor",
        message: "Cursor authentication failed. Reconnect the Cursor provider.",
      };
    }

    const quotas = {};
    let periodData = null;
    let modelUsage = [];

    if (periodResponse.ok) {
      periodData = await readJson(periodResponse);
      addPlanSpendQuotas(quotas, periodData);
      addOnDemandQuota(quotas, periodData);
      // Fail-open: period quota still returned if aggregate call fails.
      modelUsage = await fetchModelUsage(aggregatedUrl, token, machineId, proxyOptions);
    }

    if (Object.keys(quotas).length === 0 && authUsageUrl) {
      const authResponse = await proxyAwareFetch(
        authUsageUrl,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token.includes("::") ? token.split("::")[1] : token}`,
            Accept: "application/json",
          },
        },
        proxyOptions,
      );
      if (authResponse.ok) {
        addAuthUsageQuotas(quotas, await readJson(authResponse));
      } else if (!periodResponse.ok) {
        const errText = await periodResponse.text().catch(() => "");
        return {
          plan: "Cursor",
          message: `Cursor usage API error (${periodResponse.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
        };
      }
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan: "Cursor",
        message: periodData?.displayMessage || "Cursor connected. No quota data returned for this plan.",
      };
    }

    let plan = "Cursor";
    if (planInfoUrl) {
      const planResponse = await postConnectJson(planInfoUrl, token, machineId, proxyOptions).catch(() => null);
      if (planResponse?.ok) {
        const planData = await readJson(planResponse);
        const planName = planData?.planInfo?.planName;
        if (typeof planName === "string" && planName.trim()) {
          plan = `Cursor ${planName.trim()}`;
        }
      }
    }

    const result = { plan, quotas };
    if (modelUsage.length > 0) result.modelUsage = modelUsage;
    return result;
  } catch (error) {
    return { message: `Cursor error: ${error.message}` };
  }
}
