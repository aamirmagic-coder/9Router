/**
 * modelPolicy.js — политика разрешённых моделей (free-only).
 *
 * Жёсткие правила:
 *  1. RouterAI — ТОЛЬКО deepseek/deepseek-v4-flash-0731. Всё остальное запрещено,
 *     включая образные модели (rai-img/flux) и любые другие провайдеры RouterAI.
 *  2. Платные per-token модели запрещены — в том числе в чате, в картинках,
 *     в ping-all, в backgroundScanner и в авто-конфиге: все они идут через
 *     эти точки входа.
 *  3. Подписочные OAuth-провайдеры (Claude Code, Codex, Gemini CLI и т.п.) НЕ
 *     блокируются: у них цена в каталоге есть, а платит подписка.
 *
 * Отключить глобальный запрет платных: MODEL_POLICY_BLOCK_PAID=0
 */
import { getPricingForModel } from "../providers/pricing.js";

export const BLOCK_PAID = process.env.MODEL_POLICY_BLOCK_PAID !== "0";

/** RouterAI: единственная разрешённая модель. */
const ROUTERAI_ALLOW = new Set([
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4-flash",
]);

/** id узла RouterAI — provider может прийти как openai-compatible-<nodeId>. */
const ROUTERAI_HINTS = ["routerai", "fa3cc1b2-47e9-47b3-ad53-973b5862ef90"];

/** Подписочные (OAuth) провайдеры — платные per-token модели у них не блокируем. */
const SUBSCRIPTION_PROVIDERS = [
  "claude", "codex", "gemini-cli", "antigravity", "github", "github-copilot",
  "kiro", "cline", "clinepass", "qwen", "iflow", "glm", "glm-cn", "kilocode",
  "qoder", "qoder-cn", "cursor", "windsurf", "grok-cli", "grok-web", "zed",
  "trae", "codebuddy", "kimchi", "muse", "kimi-coding", "opencode-go", "kilo",
];

/** Пространства имён, которые апстрим тарифицирует как $0. */
const FREE_NAMESPACES = ["cline-free/", "ollama/", "lm-studio/", "local/"];

/** Локальные/self-hosted рантаймы — всегда $0, даже если паттерн прайсинга совпал. */
const SELF_HOSTED_PROVIDERS = [
  "ollama", "lm-studio", "llama-cpp", "vllm", "localai", "llamacpp", "localhost",
];

function isRouterAi(provider) {
  const p = String(provider || "").toLowerCase();
  return ROUTERAI_HINTS.some((h) => p === h || p.includes(h));
}

function isSelfHosted(provider) {
  const p = String(provider || "").toLowerCase();
  if (!p) return false;
  return SELF_HOSTED_PROVIDERS.some((s) => p === s || p.startsWith(s + "-"));
}

function isSubscription(provider) {
  const p = String(provider || "").toLowerCase();
  if (!p) return false;
  return SUBSCRIPTION_PROVIDERS.some((s) => p === s || p.startsWith(s + "-"));
}

/** Свой детектор бесплатных: namespace, суффиксы -free, теги :free. */
function isFreeId(model) {
  const m = String(model || "").toLowerCase();
  if (FREE_NAMESPACES.some((ns) => m.startsWith(ns))) return true;
  if (m.includes(":free")) return true;
  if (/(^|[/:._-])free([/:._-]|$)/.test(m)) return true;
  return false;
}

/** Есть ли ненулевая цена в каталоге. null/unknown — неизвестно, разрешаем. */
function hasPaidPrice(provider, model) {
  const pr = getPricingForModel(provider, model);
  if (!pr) return false;
  const { input = 0, output = 0, cached = 0, reasoning = 0, cache_creation = 0 } = pr;
  return input > 0 || output > 0 || cached > 0 || reasoning > 0 || cache_creation > 0;
}

/**
 * @returns {boolean} true — модель можно использовать.
 */
export function isModelAllowed(provider, model) {
  if (!provider || !model) return true;

  // 1. RouterAI — жёсткий allowlist.
  if (isRouterAi(provider)) return ROUTERAI_ALLOW.has(String(model));

  // 2. Глобальный запрет платных (кроме подписок и локальных рантаймов).
  if (!BLOCK_PAID) return true;
  if (isSubscription(provider)) return true;
  if (isSelfHosted(provider)) return true;
  if (isFreeId(model)) return true;

  return !hasPaidPrice(provider, model);
}

export function modelBlockedMessage(provider, model) {
  return `Модель заблокирована политикой 9Router (free-only): ${provider}/${model}. Разрешены только бесплатные модели; для RouterAI — только deepseek/deepseek-v4-flash-0731.`;
}

/** Фильтр для сканеров/ping-all: возвращает только разрешённые модели. */
export function filterAllowedModels(entries) {
  return (entries || []).filter((e) => isModelAllowed(e.provider, e.model));
}
