// Credential-free HTTP boundary regression: node --test tests/unit/minimax-flash-wire.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

// Install before proxyFetch captures fetch. No request can reach a real provider.
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), ...options, json: JSON.parse(options.body) });
  return new Response("{}", { headers: { "content-type": "application/json" } });
};
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { PROVIDERS } = await import("../../open-sse/providers/index.js");
const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");
const { prepareClaudeRequest } = await import("../../open-sse/translator/formats/claude.js");
const { filterToOpenAIFormat } = await import("../../open-sse/translator/formats/openai.js");
const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
const { getThinkingLevels } = await import("../../open-sse/providers/thinkingLevels.js");
const { currentMiniMaxChoices } = await import("../../open-sse/providers/models/minimaxChoices.js");
const { getDefaultModel, getModelsByProviderId, isValidModel, getModelUpstreamId } = await import("../../open-sse/config/providerModels.js");
const FLASH = "MiniMax-M3.1-Flash";

async function wire(provider, format, model, fields = {}, content = "hello") {
  let body = { model, max_tokens: 524288, messages: [{ role: "user", content }], ...fields };
  applyThinking(format, model, body, provider);
  if (format === "claude") body = prepareClaudeRequest(body, provider);
  else body = filterToOpenAIFormat(body, { preserveVideo: ["minimax", "minimax-cn"].includes(provider) && model === FLASH });
  const executor = new DefaultExecutor(provider);
  // Same source-format transport selection used by chatCore for multi-transport providers.
  const transport = PROVIDERS[provider].transports.find((entry) => entry.format === format);
  await executor.execute({ model, body, stream: false, credentials: { apiKey: "offline-fixture", runtimeTransport: transport } });
  return requests.at(-1);
}

for (const provider of ["minimax", "minimax-cn"]) {
  test(`${provider}: ordinary choices, saved legacy metadata, and direct limits`, () => {
    assert.equal(getDefaultModel(provider), FLASH);
    assert.deepEqual(getModelsByProviderId(provider).filter((m) => !m.kind).map((m) => m.id), [FLASH, "MiniMax-M3"]);
    for (const model of ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1"]) {
      assert.equal(isValidModel(provider, model), true);
      assert.equal(getModelUpstreamId(provider, model), model);
    }
    assert.equal(getModelUpstreamId(provider, "custom-private-model"), "custom-private-model");
    const caps = getCapabilitiesForModel(provider, FLASH);
    assert.equal(caps.contextWindow, 1000000);
    assert.equal(caps.maxOutput, 524288);
    assert.equal(caps.vision, true);
    assert.equal(caps.videoInput, true);
    assert.deepEqual(getThinkingLevels(provider, FLASH), ["low", "medium", "high", "xhigh", "max"]);
  });

  for (const format of ["openai", "claude"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max", "none", "auto"]) {
      test(`${provider}/${format}: serializes ${effort} at fetch boundary`, async () => {
        const fields = { reasoning_effort: effort, service_tier: "priority", reasoning_split: false };
        const request = await wire(provider, format, FLASH, fields);
        assert.match(request.url, format === "claude" ? /\/anthropic\/v1\/messages/ : /\/v1\/chat\/completions/);
        assert.equal(request.json.model, FLASH);
        assert.equal(request.json.max_tokens, 524288);
        assert.equal(request.json.thinking.type, "adaptive");
        const expected = effort === "none" ? "low" : effort === "auto" ? "max" : effort;
        assert.equal(format === "claude" ? request.json.output_config.effort : request.json.reasoning_effort, expected);
        assert.equal(format === "claude" ? request.json.reasoning_effort : request.json.output_config, undefined);
        assert.equal(request.json.service_tier, undefined);
        assert.equal(request.json.reasoning_split, undefined);
        assert.equal(request.headers[format === "claude" ? "x-api-key" : "Authorization"], format === "claude" ? "offline-fixture" : "Bearer offline-fixture");
      });
    }
    test(`${provider}/${format}: Flash cannot disable thinking; M3 still can`, async () => {
      const flash = await wire(provider, format, FLASH, { thinking: { type: "disabled" } });
      assert.equal(flash.json.thinking.type, "adaptive");
      assert.equal(format === "claude" ? flash.json.output_config.effort : flash.json.reasoning_effort, "low");
      const m3 = await wire(provider, format, "MiniMax-M3", { thinking: { type: "disabled" } });
      assert.equal(m3.json.thinking.type, "disabled");
      assert.equal(m3.json.output_config, undefined);
      assert.equal(m3.json.reasoning_effort, undefined);
    });
    test(`${provider}/${format}: defaults and explicit legacy/custom IDs survive serialization`, async () => {
      for (const model of [getDefaultModel(provider), "MiniMax-M3", "MiniMax-M2.7", "custom-private-model"]) {
        const request = await wire(provider, format, model);
        assert.equal(request.json.model, model);
        assert.equal(request.json.output_config, undefined);
        assert.equal(request.json.reasoning_effort, undefined);
      }
    });
    test(`${provider}/${format}: image and video payloads survive serialization`, async () => {
      const content = format === "claude"
        ? [{ type: "text", text: "describe" }, { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } }, { type: "video", source: { type: "url", url: "https://example.invalid/video.mp4" } }]
        : [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "https://example.invalid/image.png" } }, { type: "video_url", video_url: { url: "https://example.invalid/video.mp4" } }];
      const request = await wire(provider, format, FLASH, { reasoning_effort: "max" }, content);
      assert.deepEqual(request.json.messages[0].content, content);
    });
  }
}

test("gateway choices retain catalog-proven IDs, media and non-MiniMax entries", () => {
  const models = [
    { id: "other-model" }, { id: "minimax/minimax-m3", contextLength: 1048576 },
    { id: "minimax/minimax-m2.7" }, { id: "minimax/minimax-m3.1-flash:free", price: 0 },
    { id: "MiniMax-Hailuo-2.3", kind: "video" }, { id: "minimax-image-01", kind: "image" },
  ];
  const original = structuredClone(models);
  assert.deepEqual(currentMiniMaxChoices(models), [models[0], models[3], models[1], models[4], models[5]]);
  assert.deepEqual(models, original);
  assert.deepEqual(currentMiniMaxChoices([{ id: "minimax-m3" }, { id: "minimax-m2.7" }]), [{ id: "minimax-m3" }]);
  assert.deepEqual(currentMiniMaxChoices([{ id: "minimax-m3.1-flash-free" }]), [{ id: "minimax-m3.1-flash-free" }]);
});
