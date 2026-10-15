/**
 * Misc usage handlers (iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

export { getGlmUsage } from "./glm.js";


// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

const OLLAMA_LIMIT_WINDOWS = {
  session: "Session (5h)",
  weekly: "Weekly (7d)",
  monthly: "Monthly",
};

function addUtcMonths(date, months) {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ));
}

// Free plan: "usage resets monthly from the date you signed up" (ollama.com/pricing).
function nextMonthlyResetFromSignup(createdAt, now = new Date()) {
  const anchor = new Date(createdAt);
  if (Number.isNaN(anchor.getTime())) return null;
  const elapsedMonths = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + (now.getUTCMonth() - anchor.getUTCMonth());
  for (let i = Math.max(0, elapsedMonths); i <= elapsedMonths + 1; i++) {
    const candidate = addUtcMonths(anchor, i);
    if (candidate > now) return candidate.toISOString();
  }
  return null;
}

/**
 * Ollama Cloud Usage
 * GET https://ollama.com/api/usage — two shapes, depending on the account:
 *   * legacy plans: `limits.<window>.usage` is a 0..1 ratio (1.0 = limit
 *     reached); paid plans report session (5h) + weekly (7d), the free plan a
 *     single monthly window. Kept as-is for accounts still on that pricing.
 *   * new pricing (2026-08-31, /blog/transparent-pricing): the 5h/weekly windows
 *     no longer exist and `limits` is absent. The body carries `totals` /
 *     `buckets` for a rolling window (range=24h|7d|30d) with `usage_usd` (spend,
 *     NOT a remaining balance), `request_count` and token counts. There is no
 *     billing-period or plan-pool figure in the API, so spend is surfaced as
 *     plain "Spent (…)" rows — never a quota percentage.
 * POST https://ollama.com/api/me — plan label + CreatedAt (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 */
export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://ollama.com/api/usage", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch("https://ollama.com/api/me", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};

    // Ollama `usage` is a 0..1 ratio (1.0 = limit reached). Convert to a 0..100
    // bar. Do NOT set absolute `remaining` — QuotaTable reads remainingPercentage.
    function ratioQuota(usageRatio, resetAt = null) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
    }

    const monthlyResetAt = planRaw.toLowerCase() === "free" && me?.CreatedAt
      ? nextMonthlyResetFromSignup(me.CreatedAt)
      : null;

    const quotas = {};
    for (const [key, label] of Object.entries(OLLAMA_LIMIT_WINDOWS)) {
      const raw = limits[key]?.usage;
      if (raw === undefined || raw === null) continue;
      const ratio = Number(raw);
      if (Number.isNaN(ratio)) continue;
      quotas[label] = ratioQuota(ratio, key === "monthly" ? monthlyResetAt : null);
    }

    if (Object.keys(quotas).length === 0) {
      // New pricing: `limits` is gone. Rebuild the old "used / limit" bar from
      // rolling spend and the plan's monthly credit pool (published on the
      // pricing page — the API exposes no pool figure). The spend is a rolling
      // 30d window, the closest available proxy for a billing month; only the
      // free plan's reset date is derivable, so paid rows carry no resetAt.
      const spend = await collectOllamaSpend(apiKey, data, proxyOptions);
      const out = {};
      const pool = OLLAMA_PLAN_POOL_USD[planRaw.toLowerCase()];
      const spend30 = spend["Spent (30d)"]?.total;
      if (pool && Number.isFinite(spend30)) {
        // Named "est." on purpose: the pool comes from the pricing page, the
        // spend window is rolling, and /api/me cannot tell legacy from new
        // plans — only the Spent rows below are exact API figures.
        out[`Included usage (${plan} · est.)`] = poolQuota(spend30, pool);
      }
      Object.assign(out, spend);

      if (Object.keys(out).length > 0) return { plan, quotas: out };

      return {
        plan,
        message: "Ollama Cloud connected. No usage reported for this period.",
        quotas: {},
      };
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}

// Monthly usage credits included with each plan (ollama.com/pricing). The API
// reports the plan name but not the pool, so this mapping is the only source.
const OLLAMA_PLAN_POOL_USD = { pro: 60, max: 300, team: 1000 };

// Rolling spend windows shown when the account is on the new per-token pricing.
const OLLAMA_SPEND_RANGES = ["7d", "30d"];

// Spend vs plan pool as a familiar used/total quota: the bar and the percentage
// are what QuotaTable already renders for absolute windows (e.g. Groq/Codex).
function poolQuota(usedUsd, totalUsd, resetAt = null) {
  const used = Math.round(usedUsd * 100) / 100;
  const remainingPercentage = Math.max(
    0,
    Math.min(100, Math.round((1 - used / totalUsd) * 100)),
  );
  return { used, total: totalUsd, remainingPercentage, resetAt, unlimited: false };
}

function ollamaSpendQuota(totals) {
  const usd = Number(totals?.usage_usd);
  // Missing/negative → malformed payload, not a zero reading.
  if (!Number.isFinite(usd) || usd < 0) return null;
  const requests = Number(totals?.request_count) || 0;
  // A window with neither spend nor requests carries no information.
  if (usd === 0 && requests === 0) return null;
  return {
    // `used`/`total` are unused by the spend renderer, but keep them numeric so
    // the shared sort helpers never see undefined.
    used: 0,
    total: usd,
    requestCount: requests,
    isSpend: true,
    currency: "USD",
    resetAt: null,
  };
}

async function collectOllamaSpend(apiKey, firstResponseData, proxyOptions) {
  const spend = {};
  for (const range of OLLAMA_SPEND_RANGES) {
    // The first /api/usage call already carries the default range's totals.
    const totals = firstResponseData?.range === range
      ? firstResponseData?.totals
      : await proxyAwareFetch(`https://ollama.com/api/usage?range=${range}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => j?.totals);

    const quota = ollamaSpendQuota(totals);
    if (quota) spend[`Spent (${range})`] = quota;
  }
  return spend;
}



/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null, providerId = "qoder") {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U(providerId).url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Add-on credits (free grants / promos). Qoder emits this block only when
    // the account actually holds a grant — an account that never redeemed one,
    // or consumed it, omits the key entirely. Verified against both regions:
    // qoder CN returns it (e.g. 2200 total) after redeeming the free-credit
    // promo, while an intl account without a grant has no such key. Gating on
    // total > 0 keeps the intl/no-grant shape byte-identical to before.
    const addOnQuota = body.addOnQuota || {};
    const addOnTotal = Number(addOnQuota.total) || 0;
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total. 253402214400000 (9999-12-31T00:00:00Z)
    // is Qoder's "never expires" sentinel, returned by both regions for
    // open-ended plans — rendering a reset date in the year 9999 is noise, so
    // flag it instead and let the tracker word it as "Never expires".
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const NO_RESET_SENTINEL_MS = 253402214400000;
    const neverExpires = expiresAtMs === NO_RESET_SENTINEL_MS;
    const resetAt = expiresAtMs && !neverExpires ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
        neverExpires,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
        neverExpires,
      },
    };
    if (addOnTotal > 0) {
      quotas.addOn = {
        total: addOnTotal,
        used: Number(addOnQuota.used) || 0,
        remaining: Number(addOnQuota.remaining) || 0,
        unit: addOnQuota.unit || "credits",
        // The add-on block carries no expiry of its own in this API. Qoder's
        // web console lists every redeemed resource package with its own
        // deadline (check-in bonuses do expire, typically ~30 days), but
        // openapi only exposes the account-level `expiresAt` sentinel above,
        // which describes the plan, not the grants — reusing it here would
        // advertise "never expires" for credits that actually expire. So
        // leave the reset date unset and let the row link to Qoder's own
        // usage page (detailUrl) where the per-package dates live.
        resetAt: null,
        neverExpires: false,
        detailUrl: addOnQuota.detailUrl || null,
      };
    }
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}
