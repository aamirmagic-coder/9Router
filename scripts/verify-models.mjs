/**
 * verify-models.mjs — проверка бесплатных/рабочих моделей 9Router.
 *
 * Ключи берутся из локальной БД (providerConnections) и/или переменных окружения.
 * Значения ключей НЕ печатаются — только статус и причина.
 *
 * Запуск:
 *   node scripts/verify-models.mjs
 *   node scripts/verify-models.mjs --json report.json
 *   BASE_URL=http://localhost:20128 API_KEY=... node scripts/verify-models.mjs --via-router
 *
 * Уровни:
 *   (по умолчанию) — прямой опрос провайдеров (не зависит от сборки).
 *   --via-router   — опрос через локальный 9Router /v1/chat/completions (end-to-end).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const viaRouter = args.includes("--via-router");
const jsonOut = (() => {
  const i = args.indexOf("--json");
  return i >= 0 ? args[i + 1] : null;
})();

const DATA_DIR =
  process.env.DATA_DIR ||
  (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
    : path.join(os.homedir(), ".9router"));
const DB_FILE = path.join(DATA_DIR, "db", "data.sqlite");

// ── ключи из БД (только значения в память, наружу не печатаем) ──────────────
function loadKeys() {
  const out = {};
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    const rows = db.prepare("SELECT provider, data FROM providerConnections").all();
    for (const r of rows) {
      let d = {};
      try {
        d = JSON.parse(r.data || "{}");
      } catch {}
      const base = d?.providerSpecificData?.baseUrl || "";
      if (d.apiKey) {
        if (!out[r.provider]) out[r.provider] = d.apiKey;
        if (base.includes("routerai.ru")) out.__routerai = d.apiKey;
        if (base.includes("opencode.ai")) out.__opencode = d.apiKey;
        if (base.includes("localhost:11434")) out.__ollamaLocal = d.apiKey;
      }
    }
    db.close();
  } catch (e) {
    console.error(`[verify] не смог прочитать БД (${DB_FILE}): ${e.message}`);
  }
  const env = (k) => process.env[k];
  out.opencode = out.opencode || out.__opencode || env("PROVIDER_OPENCODE_KEY");
  out.routerai = out.__routerai || env("PROVIDER_ROUTERAI_KEY");
  out.ollamaCloud = out.ollama || env("OLLAMA_CLOUD_KEY");
  out.ollamaLocal = out.ollamaLocal || out.__ollamaLocal || "ollama";
  return out;
}

const keys = loadKeys();

// ── что проверяем ───────────────────────────────────────────────────────────
// kind: chat (OpenAI-совместимый) | gemini (native)
const TESTS = [
  { name: "OpenCode space-bunny-free", url: "https://opencode.ai/zen/v1/chat/completions", keyFrom: () => keys.opencode, model: "space-bunny-free" },
  { name: "OpenCode mimo-v2.6-flash-free", url: "https://opencode.ai/zen/v1/chat/completions", keyFrom: () => keys.opencode, model: "mimo-v2.6-flash-free" },
  { name: "RouterAI deepseek-v4-flash", url: "https://routerai.ru/api/v1/chat/completions", keyFrom: () => keys.routerai, model: "deepseek/deepseek-v4-flash-0731" },
  { name: "Ollama local qwen2.5-coder:14b", url: "http://localhost:11434/v1/chat/completions", keyFrom: () => keys.ollamaLocal || "ollama", model: "qwen2.5-coder:14b" },
  { name: "Ollama local qwen2.5vl:7b", url: "http://localhost:11434/v1/chat/completions", keyFrom: () => keys.ollamaLocal || "ollama", model: "qwen2.5vl:7b" },
  { name: "Ollama Cloud gemma4:31b-cloud", url: "https://ollama.com/v1/chat/completions", keyFrom: () => keys.ollamaCloud, model: "gemma4:31b-cloud" },
  { name: "OpenRouter deepseek-v3:free", url: "https://openrouter.ai/api/v1/chat/completions", keyFrom: () => keys.openrouter, model: "deepseek/deepseek-chat-v3-0324:free" },
  { name: "xAI grok-2", url: "https://api.x.ai/v1/chat/completions", keyFrom: () => keys.xai, model: "grok-2-latest" },
  { name: "Gemini 2.5-flash", kind: "gemini", keyFrom: () => keys.gemini, model: "gemini-2.5-flash" },
];

async function testChat({ url, key, model }) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 45000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 32 }),
    });
    clearTimeout(to);
    const txt = await r.text();
    let content = "";
    let answered = model;
    try {
      const j = JSON.parse(txt);
      content = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.delta?.content || "";
      answered = j?.model || model;
    } catch {}
    return { status: r.status, ok: r.ok && (content.length > 0 || r.ok), ms: Date.now() - t0, answered, snippet: (content || txt).replace(/\s+/g, " ").slice(0, 80) };
  } catch (e) {
    clearTimeout(to);
    return { ok: false, status: 0, ms: Date.now() - t0, reason: e.name === "AbortError" ? "timeout" : e.message };
  }
}

async function testGemini({ key, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 45000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with exactly: OK" }] }], maxOutputTokens: 32 }),
    });
    clearTimeout(to);
    const txt = await r.text();
    let content = "";
    try {
      const j = JSON.parse(txt);
      content = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    } catch {}
    return { status: r.status, ok: r.ok, ms: Date.now() - t0, answered: model, snippet: (content || txt).replace(/\s+/g, " ").slice(0, 80) };
  } catch (e) {
    clearTimeout(to);
    return { ok: false, status: 0, ms: Date.now() - t0, reason: e.name === "AbortError" ? "timeout" : e.message };
  }
}

async function testViaRouter({ model }) {
  const base = process.env.BASE_URL || "http://localhost:20128";
  const key = process.env.API_KEY;
  if (!key) return { ok: false, status: 0, reason: "API_KEY не задан" };
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 60000);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: ac.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 32 }),
    });
    clearTimeout(to);
    const txt = await r.text();
    let content = "", answered = model;
    try {
      const j = JSON.parse(txt);
      content = j?.choices?.[0]?.message?.content || "";
      answered = j?.model || model;
    } catch {}
    return { status: r.status, ok: r.ok, ms: Date.now() - t0, answered, snippet: (content || txt).replace(/\s+/g, " ").slice(0, 80) };
  } catch (e) {
    clearTimeout(to);
    return { ok: false, status: 0, ms: Date.now() - t0, reason: e.name === "AbortError" ? "timeout" : e.message };
  }
}

(async () => {
  console.log(`[verify] режим: ${viaRouter ? "через 9Router" : "прямой опрос провайдеров"}`);
  console.log(`[verify] БД: ${DB_FILE}\n`);
  const results = [];
  for (const t of TESTS) {
    const key = t.keyFrom?.();
    let res;
    if (viaRouter) res = await testViaRouter({ model: t.model });
    else if (!key) res = { ok: false, status: 0, reason: "нет ключа" };
    else if (t.kind === "gemini") res = await testGemini({ key, model: t.model });
    else res = await testChat({ url: t.url, key, model: t.model });
    const mark = res.ok ? "OK  " : "FAIL";
    const detail = res.ok ? `${res.status} ${res.ms}ms → ${res.answered} | ${res.snippet}` : `${res.status || ""} ${res.reason || res.snippet || ""}`.trim();
    console.log(`${mark} ${t.name.padEnd(36)} ${detail}`);
    results.push({ name: t.name, model: t.model, ...res });
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\nИтог: ${ok}/${results.length} работают.`);
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), viaRouter, results }, null, 2));
    console.log(`Отчёт: ${jsonOut}`);
  }
})();