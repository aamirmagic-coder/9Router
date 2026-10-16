/**
 * Muse (Meta Model API) — endpoint/format agreement.
 *
 * Break caught: every muse model pins `targetFormat: "openai-responses"`, but the
 * registry used to advertise `/v1/chat/completions` as the default transport.
 * chatCore's per-model guard (chatCore.js:107-119) rejects the sourceFormat-matched
 * transport whenever the model declares `supportedFormats: ["openai-responses"]`,
 * so the body was translated to Responses and then POSTed to the chat URL —
 * Meta answers 400 `unknown parameter 'input'`.
 *
 * Reproduced against api.meta.ai on 3 Oct 2026:
 *   /v1/responses       + body Responses → 200
 *   /v1/chat/completions + body Responses → 400 unknown parameter `input`
 *   /v1/responses       + `max_tokens`    → 400 unknown parameter `max_tokens`
 *   /v1/responses       + top-level `reasoning_effort` → 400 (needs reasoning.effort)
 *
 * A request body and its endpoint must agree on the wire format. `meta-code`
 * ships the same trio (settings, not a special executor) and works; this pins
 * `muse` to the identical shape so the bug cannot come back through a registry
 * edit.
 */
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS, getModelTargetFormat, getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const PROVIDER = "muse";
const CONTRIBUTOR = "muse-spark-1.3-contributor";
const MODELS = [
  "muse-spark-1.3",
  "muse-spark-1.2",
  "muse-spark-1.1",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
];

// Mirror of chatCore's per-model transport guard + targetFormat preference.
function pickTarget(provider, sourceFormat, alias, model) {
  const supported = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const useTransport = (!supported || supported.includes(sourceFormat)) ? runtimeTransport : null;
  return {
    useTransport,
    targetFormat: useTransport?.format || getModelTargetFormat(alias, model) || PROVIDERS[provider]?.format,
  };
}

describe("muse transport agrees with the Responses body it sends", () => {
  it("points the default transport at /v1/responses", () => {
    expect(PROVIDERS.muse.baseUrl).toBe("https://api.meta.ai/v1/responses");
    expect(PROVIDERS.muse.format).toBe("openai-responses");
  });

  it("forces streaming and folds top-level reasoning_effort, like meta-code", () => {
    expect(PROVIDERS.muse.forceStream).toBe(true);
    expect(PROVIDERS.muse.quirks?.foldReasoningEffort).toBe(true);
  });

  it("resolves every model to the openai-responses target", () => {
    for (const model of MODELS) {
      expect(getModelTargetFormat(PROVIDER, model)).toBe(FORMATS.OPENAI_RESPONSES);
      expect(getModelSupportedFormats(PROVIDER, model)).toEqual([FORMATS.OPENAI_RESPONSES]);
    }
  });

  // The regression cell: an OpenAI-format client (Claude Code, the dashboard
  // probe) must still resolve to the Responses target — never to the chat
  // transport, which would carry a Responses body to the chat URL.
  it("never selects the chat transport for an openai-format client", () => {
    for (const model of MODELS) {
      const { useTransport, targetFormat } = pickTarget(PROVIDER, FORMATS.OPENAI, PROVIDER, model);
      expect(useTransport).toBeNull();
      expect(targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
    }
  });

  it("keeps the zero-translation lane for a responses-format client", () => {
    const { useTransport, targetFormat } = pickTarget(PROVIDER, FORMATS.OPENAI_RESPONSES, PROVIDER, CONTRIBUTOR);
    expect(useTransport?.baseUrl).toBe("https://api.meta.ai/v1/responses");
    expect(targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
  });

  it("translates an OpenAI chat body into a Responses body (input[], no max_tokens)", () => {
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, CONTRIBUTOR, {
      model: `${PROVIDER}/${CONTRIBUTOR}`,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 64,
    }, true, {}, PROVIDER);

    // The exact field that triggered Meta's 400 when sent to /chat/completions
    expect(Array.isArray(translated.input)).toBe(true);
    expect(translated.input.length).toBeGreaterThan(0);
    expect(translated).not.toHaveProperty("messages");
    expect(translated).not.toHaveProperty("max_tokens");
    expect(translated.max_output_tokens).toBe(64);
    expect(translated.stream).toBe(true);
  });

  it("keeps every catalogue model on the responses lane", () => {
    const ids = (PROVIDER_MODELS[PROVIDER] || []).map((m) => m.id);
    for (const model of MODELS) expect(ids).toContain(model);
    // Non-muse Meta models (muse-image-1.0, sam-3.1, …) are media, not chat —
    // they are absent by design, so passthrough ids must not silently inherit
    // a chat transport either.
    expect(getModelTargetFormat(PROVIDER, "muse-spark-1.3")).toBe(FORMATS.OPENAI_RESPONSES);
  });
});
