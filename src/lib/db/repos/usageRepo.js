import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const trimmed = key.trim();
  if (trimmed.length <= 12) return trimmed.charAt(0) + "***";
  // Keep the tail: keys sharing a machine-id prefix (team keys) must not collide.
  return trimmed.slice(0, 8) + "***" + trimmed.slice(-4);
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
// Per-instance metadata parallel to _pendingRequests (same keys): startedAt +
// live token estimates. Counts alone can't answer "running how long" or "how
// many tokens so far", so they live here — pushed on start, shifted on finish,
// cleared together with the count on timeout.
if (!global._pendingMeta) global._pendingMeta = { byAccount: {} };
// Last SSE-push timestamps per pending key, so per-chunk progress updates from
// the stream don't fan out to every dashboard client on every token.
if (!global._pendingProgressEmit) global._pendingProgressEmit = {};
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingRequests = global._pendingRequests;
const pendingMeta = global._pendingMeta;
const pendingProgressEmit = global._pendingProgressEmit;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart — see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

// Arms (or re-arms) the stuck-request timeout for one pending key. Extracted so
// both the start path and the per-chunk progress path share one watchdog: a
// stream that keeps emitting chunks must not be reaped mid-request.
function armPendingTimeout(connectionId, modelKey, timerKey) {
  clearTimeout(pendingTimers[timerKey]);
  pendingTimers[timerKey] = setTimeout(() => {
    delete pendingTimers[timerKey];
    if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
    if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
      pendingRequests.byAccount[connectionId][modelKey] = 0;
    }
    // The timeout drops the count — the metadata must go with it, otherwise a
    // stuck entry would read as "running" forever in the live panel.
    if (connectionId && pendingMeta.byAccount[connectionId]?.[modelKey]) {
      delete pendingMeta.byAccount[connectionId][modelKey];
      if (Object.keys(pendingMeta.byAccount[connectionId]).length === 0) {
        delete pendingMeta.byAccount[connectionId];
      }
    }
    delete pendingProgressEmit[timerKey];
    scheduleStatsEvent("pending");
  }, PENDING_TIMEOUT_MS);
  pendingTimers[timerKey]?.unref?.();
}

export function trackPendingRequest(model, provider, connectionId, started, error = false, details = null) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  // Per-instance metadata (startedAt + token estimates), keyed like the counts.
  // Shifted FIFO on finish so each live row in the dashboard maps to one real
  // request instance instead of an aggregated counter.
  if (connectionId) {
    if (started) {
      const byConn = (pendingMeta.byAccount[connectionId] ||= {});
      const list = (byConn[modelKey] ||= []);
      list.push({
        startedAt: Number(details?.startedAt) > 0 ? Number(details.startedAt) : Date.now(),
        estimatedInput: Math.max(0, Number(details?.estimatedInputTokens) || 0),
        inputTokens: 0, // replaced by real upstream usage once chunks arrive
        outputTokens: 0,
        outputReal: false, // true once upstream reported real completion tokens
        updatedAt: Date.now(),
      });
      if (list.length > 20) list.splice(0, list.length - 20);
    } else {
      const list = pendingMeta.byAccount[connectionId]?.[modelKey];
      if (list?.length) list.shift();
      if (list && list.length === 0) {
        delete pendingMeta.byAccount[connectionId][modelKey];
        if (Object.keys(pendingMeta.byAccount[connectionId]).length === 0) {
          delete pendingMeta.byAccount[connectionId];
        }
      }
      delete pendingProgressEmit[timerKey];
    }
  }

  if (started) {
    armPendingTimeout(connectionId, modelKey, timerKey);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

// Live token progress for one running request, called per stream chunk.
// Updates the newest instance's output estimate; fans out to dashboard clients
// at most once per second — the panel ticks elapsed time locally from
// startedAt, so per-token pushes would only multiply SSE traffic.
const PROGRESS_EMIT_THROTTLE_MS = 1000;

export function reportPendingProgress(model, provider, connectionId, progress = {}) {
  if (!connectionId) return;
  const modelKey = provider ? `${model} (${provider})` : model;
  const list = pendingMeta.byAccount[connectionId]?.[modelKey];
  if (!list?.length) return;
  const last = list[list.length - 1];
  const u = progress?.usage || {};
  const realIn = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const realOut = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (realIn > 0) last.inputTokens = realIn;
  if (realOut > 0) {
    // Real upstream counts always beat the char-based estimate, even downward.
    last.outputTokens = realOut;
    last.outputReal = true;
  } else if (!last.outputReal) {
    const est = Math.ceil(Math.max(0, Number(progress?.outputChars) || 0) / 4);
    if (est > (last.outputTokens || 0)) last.outputTokens = est;
  }
  last.updatedAt = Date.now();

  const timerKey = `${connectionId}|${modelKey}`;
  const now = Date.now();
  // Re-arm the stuck-request watchdog: a stream that keeps emitting chunks is
  // alive by definition and must not be reaped mid-request. Done before the
  // emit throttle so even throttled (non-emitted) chunks keep it alive.
  try { armPendingTimeout(connectionId, modelKey, timerKey); } catch {}
  if (now - (pendingProgressEmit[timerKey] || 0) < PROGRESS_EMIT_THROTTLE_MS) return;
  pendingProgressEmit[timerKey] = now;
  scheduleStatsEvent("pending");
}

// One live row per running request instance (model/provider/account/startedAt +
// token progress). Shared by getActiveRequests and getUsageStats so both answer
// the same thing. Instances without metadata (started before metadata existed)
// fall back to one aggregate row with no fake timestamps.
function buildActiveRequestRows(connectionMap) {
  const rows = [];
  const now = Date.now();
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (!(count > 0)) continue;
      const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
      const match = modelKey.match(/^(.*) \((.*)\)$/);
      const model = match ? match[1] : modelKey;
      const provider = match ? match[2] : "unknown";
      const instances = pendingMeta.byAccount[connectionId]?.[modelKey] || [];
      for (const inst of instances.slice(0, count)) {
        rows.push({
          model, provider, account: accountName, count: 1,
          startedAt: new Date(inst.startedAt).toISOString(),
          elapsedMs: Math.max(0, now - inst.startedAt),
          inputTokens: inst.inputTokens > 0 ? inst.inputTokens : (inst.estimatedInput || 0),
          inputEstimated: !(inst.inputTokens > 0),
          outputTokens: inst.outputTokens || 0,
        });
      }
      if (instances.length < count) {
        rows.push({
          model, provider, account: accountName, count: count - instances.length,
          startedAt: null, elapsedMs: null,
          inputTokens: 0, inputEstimated: true, outputTokens: 0,
        });
      }
    }
  }
  return rows;
}

export async function getActiveRequests() {
  const connectionMap = await getConnectionMapCached();
  const activeRequests = buildActiveRequestRows(connectionMap);

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      const promptTokens = t.prompt_tokens || t.input_tokens || 0;
      const completionTokens = t.completion_tokens || t.output_tokens || 0;
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        account: e.connectionId ? (connectionMap[e.connectionId] || `Account ${String(e.connectionId).slice(0, 8)}...`) : "",
        promptTokens,
        completionTokens,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        totalTokens: promptTokens + completionTokens,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    let inserted = false;

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      const existing = db.get(
        `SELECT id, endpoint FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND COALESCE(apiKey, '') = COALESCE(?, '')
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null,
          promptTokens, completionTokens,
        ]
      );

      if (existing) {
        if (!existing.endpoint && entry.endpoint) {
          db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
        }
        return;
      }

      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({}),
        ]
      );

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
      inserted = true;
    });

    if (inserted) {
      pushToRing(entry);
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ${where} ORDER BY id ASC`, params);

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`, [cutoffKey]);
}

export async function getUsageStats(period = "all") {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) {
    if (k.key) apiKeyMap[k.key.trim()] = { name: k.name, id: k.id, createdAt: k.createdAt };
  }

  // recentRequests from live history (last 100 entries enough for 20 deduped)
  const recentRows = db.all(`SELECT timestamp, provider, model, connectionId, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100`);
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      const promptTokens = t.prompt_tokens || t.input_tokens || 0;
      const completionTokens = t.completion_tokens || t.output_tokens || 0;
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        account: r.connectionId ? (connectionMap[r.connectionId] || `Account ${String(r.connectionId).slice(0, 8)}...`) : "",
        promptTokens,
        completionTokens,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        totalTokens: promptTokens + completionTokens,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests — same per-instance rows as getActiveRequests() so the
  // stack header and the /api/usage/stream payload never disagree.
  stats.activeRequests = buildActiveRequestRows(connectionMap);

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [tenMinutesAgo.toISOString(), now.toISOString()]
  );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCachedTokens += day.cachedTokens || 0;
      stats.totalCost += day.cost || 0;

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
        stats.byProvider[prov].cost += p.cost || 0;
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        const provider = ak.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const apiKeyVal = ak.apiKey ? ak.apiKey.trim() : null;
        const keyInfo = apiKeyVal ? apiKeyMap[apiKeyVal] : null;
        const apiKeyMasked = maskApiKey(apiKeyVal);
        const keyName = keyInfo?.name || (apiKeyVal ? (apiKeyMasked || apiKeyVal.slice(0, 8) + "...") : "Local (No API Key)");
        const apiKeyKey = apiKeyMasked || "local-no-key";
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey, lastUsed: dateKey };
        }
        stats.byApiKey[akKey].requests += ak.requests || 0;
        stats.byApiKey[akKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[akKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[akKey].cachedTokens += ak.cachedTokens || 0;
        stats.byApiKey[akKey].cost += ak.cost || 0;
        if (dateKey > (stats.byApiKey[akKey].lastUsed || "")) stats.byApiKey[akKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        const provider = ep.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
        stats.byEndpoint[epKey].cost += ep.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history.
    // ponytail: overlay scans only a recent window; entries older than that keep
    // day-level lastUsed from usageDaily. Upgrade to a materialized per-key
    // MAX(timestamp) table if exact old timestamps ever matter.
    const OVERLAY_WINDOW_MS = 2 * 86400000;
    const overlayCutoff = Math.max(
      maxDays ? Date.now() - maxDays * 86400000 : 0,
      Date.now() - OVERLAY_WINDOW_MS
    );
    const histRows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint FROM usageHistory WHERE timestamp >= ?`,
      [new Date(overlayCutoff).toISOString()]
    );
    for (const e of histRows) {
      const ts = e.timestamp;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      const apiKeyKey = (e.apiKey && typeof e.apiKey === "string")
        ? `${e.apiKey}|${e.model}|${e.provider || "unknown"}`
        : "local-no-key";
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed)) stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
      [cutoff]
    );

    for (const r of filtered) {
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = tokens.prompt_tokens || tokens.input_tokens || r.promptTokens || 0;
      const completionTokens = tokens.completion_tokens || tokens.output_tokens || r.completionTokens || 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = r.cost || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      if (r.apiKey && typeof r.apiKey === "string") {
        const apiKeyVal = r.apiKey.trim();
        const keyInfo = apiKeyMap[apiKeyVal];
        const apiKeyMasked = maskApiKey(apiKeyVal);
        const keyName = keyInfo?.name || apiKeyMasked || r.apiKey.slice(0, 8) + "...";
        // Key by the FULL api key (same as the daily rollup + lastUsed overlay)
        // — masking here collided all keys sharing a prefix into one bucket.
        const akKey = `${r.apiKey}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: apiKeyMasked, lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}

export async function getChartData(period = "7d") {
  const db = await getAdapter();
  const now = Date.now();

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].cost += r.cost || 0;
        buckets[idx].requests += 1;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
      buckets[idx].requests += 1;
    }
    return buckets;
  }

  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  if (period === "all") {
    const dayRows = loadDaysInRange(db, null);
    if (!dayRows.length) return [];
    const dayMap = {};
    for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

    const earliest = new Date(dayRows[0].dateKey + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.max(1, Math.round((today - earliest) / 86400000) + 1);

    return Array.from({ length: diffDays }, (_, i) => {
      const d = new Date(earliest);
      d.setDate(d.getDate() + i);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dayData = dayMap[dateKey];
      return {
        label: labelFn(d),
        tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
        cost: dayData ? (dayData.cost || 0) : 0,
        requests: dayData ? (dayData.requests || 0) : 0,
      };
    });
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
      requests: dayData ? (dayData.requests || 0) : 0,
    };
  });
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}
/**
 * Export usage records (usageDaily, usageHistory, totalRequestsLifetime)
 * @param {object} options
 * @param {boolean} [options.historyOnly] - export only history
 * @returns {Promise<object>}
 */
export async function exportUsageData() {
  const db = await getAdapter();
  const daily = db.all("SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC");
  const history = db.all(
    "SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory ORDER BY id ASC"
  );
  const meta = db.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");

  return {
    version: 1,
    type: "9router_usage_backup",
    exportedAt: new Date().toISOString(),
    totalRequestsLifetime: meta?.value ? parseInt(meta.value, 10) : 0,
    daily,
    history,
  };
}

/**
 * Import usage records with merge support
 * @param {object} payload
 * @param {string} [mode="merge"] - "merge" or "replace"
 */
export async function importUsageData(payload, mode = "merge") {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid usage backup payload");
  }

  const db = await getAdapter();
  const daily = Array.isArray(payload.daily) ? payload.daily : [];
  const history = Array.isArray(payload.history) ? payload.history : [];
  const incomingLifetime = typeof payload.totalRequestsLifetime === "number" ? payload.totalRequestsLifetime : 0;

  db.transaction(() => {
    if (mode === "replace") {
      db.run("DELETE FROM usageDaily");
      db.run("DELETE FROM usageHistory");
      db.run(
        "INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [String(incomingLifetime)]
      );

      for (const d of daily) {
        if (d.dateKey && d.data) {
          db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [d.dateKey, stringifyJson(d.data)]);
        }
      }

      for (const h of history) {
        db.run(
          "INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            h.timestamp,
            h.provider || null,
            h.model || null,
            h.connectionId || null,
            h.apiKey || null,
            h.endpoint || null,
            h.promptTokens || 0,
            h.completionTokens || 0,
            h.cost || 0,
            h.status || "ok",
            stringifyJson(h.tokens || {}),
            stringifyJson(h.meta || {}),
          ]
        );
      }
    } else {
      // Merge mode: insert non-duplicate history entries and merge daily summaries
      for (const d of daily) {
        if (!d.dateKey || !d.data) continue;
        const incomingData = parseJson(d.data, null);
        if (!incomingData) continue;

        const row = db.get("SELECT data FROM usageDaily WHERE dateKey = ?", [d.dateKey]);
        if (!row) {
          db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [d.dateKey, stringifyJson(incomingData)]);
        } else {
          const existing = parseJson(row.data, {});
          existing.requests = (existing.requests || 0) + (incomingData.requests || 0);
          existing.promptTokens = (existing.promptTokens || 0) + (incomingData.promptTokens || 0);
          existing.completionTokens = (existing.completionTokens || 0) + (incomingData.completionTokens || 0);
          existing.cachedTokens = (existing.cachedTokens || 0) + (incomingData.cachedTokens || 0);
          existing.cost = (existing.cost || 0) + (incomingData.cost || 0);

          for (const grp of ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"]) {
            existing[grp] ||= {};
            for (const [k, v] of Object.entries(incomingData[grp] || {})) {
              if (!existing[grp][k]) {
                existing[grp][k] = { ...v };
              } else {
                existing[grp][k].requests = (existing[grp][k].requests || 0) + (v.requests || 0);
                existing[grp][k].promptTokens = (existing[grp][k].promptTokens || 0) + (v.promptTokens || 0);
                existing[grp][k].completionTokens = (existing[grp][k].completionTokens || 0) + (v.completionTokens || 0);
                existing[grp][k].cachedTokens = (existing[grp][k].cachedTokens || 0) + (v.cachedTokens || 0);
                existing[grp][k].cost = (existing[grp][k].cost || 0) + (v.cost || 0);
              }
            }
          }
          db.run("UPDATE usageDaily SET data = ? WHERE dateKey = ?", [stringifyJson(existing), d.dateKey]);
        }
      }

      // Merge history entries, skipping exact duplicates
      let addedHistoryCount = 0;
      for (const h of history) {
        if (!h.timestamp) continue;
        const dup = db.get(
          `SELECT id FROM usageHistory
           WHERE timestamp = ?
             AND COALESCE(provider, '') = COALESCE(?, '')
             AND COALESCE(model, '') = COALESCE(?, '')
             AND promptTokens = ?
             AND completionTokens = ?
           LIMIT 1`,
          [h.timestamp, h.provider || null, h.model || null, h.promptTokens || 0, h.completionTokens || 0]
        );

        if (!dup) {
          db.run(
            "INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              h.timestamp,
              h.provider || null,
              h.model || null,
              h.connectionId || null,
              h.apiKey || null,
              h.endpoint || null,
              h.promptTokens || 0,
              h.completionTokens || 0,
              h.cost || 0,
              h.status || "ok",
              stringifyJson(h.tokens || {}),
              stringifyJson(h.meta || {}),
            ]
          );
          addedHistoryCount++;
        }
      }

      // Increment lifetime counter by new entries added
      if (addedHistoryCount > 0) {
        const cur = db.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");
        const currentCount = cur ? parseInt(cur.value, 10) : 0;
        const newTotal = Math.max(currentCount + addedHistoryCount, incomingLifetime);
        db.run(
          "INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [String(newTotal)]
        );
      }
    }
  });

  // Re-seed ring & notify all live clients
  recentRing.initialized = false;
  await ensureRingInitialized();
  scheduleStatsEvent("update", 50);
}
