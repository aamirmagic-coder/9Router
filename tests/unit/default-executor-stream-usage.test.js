// Regression: streaming requests to OpenAI-compatible providers must ask the
// upstream for usage (stream_options.include_usage). Without it, Alibaba MaaS
// omits the final usage chunk, the stream path falls back to chars/4 estimation
// (inflating prompt_tokens ~45%) and cached_tokens is lost entirely — cache hits
// get billed at the full input rate. Verified live 2026-09-21: kimi/kimi-k3
// streaming reported estimated usage; with include_usage the same request
// returns prompt_tokens 34349 with cached_tokens 32256.
import { describe, expect, it } from "vitest";

const PROVIDER = "openai-compatible-chat-69218f2f-2d75-4b7e-8cb2-f220b73153b0";

describe("DefaultExecutor stream_options injection", () => {
  it("injects include_usage for streaming chat requests", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor(PROVIDER);
    const body = { model: "kimi/kimi-k3", messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest("kimi/kimi-k3", body, true, { providerSpecificData: { apiType: "chat" } });
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("does not inject for non-streaming requests", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor(PROVIDER);
    const body = { model: "kimi/kimi-k3", messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest("kimi/kimi-k3", body, false, null);
    expect(out.stream_options).toBeUndefined();
  });

  it("does not inject for responses-api nodes (no messages[])", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor("openai-compatible-chat-responses-test");
    const body = { model: "x", input: "hi" };
    const out = ex.transformRequest("x", body, true, { providerSpecificData: { apiType: "responses" } });
    expect(out.stream_options).toBeUndefined();
  });

  it("keeps a caller-provided stream_options untouched", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor(PROVIDER);
    const body = { model: "x", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: false } };
    const out = ex.transformRequest("x", body, true, null);
    expect(out.stream_options).toEqual({ include_usage: false });
  });
});