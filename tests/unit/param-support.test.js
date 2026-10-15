import { describe, it, expect } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

describe("stripUnsupportedParams", () => {
  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("still drops unsupported GitHub model params", () => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", "gpt-5.4", body);

    expect(body).toEqual({ top_p: 1 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });

  it("drops replayed reasoning fields from assistant messages for strict providers", () => {
    const makeBody = () => ({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          reasoning_content: "thinking...",
          reasoning: "thinking...",
          reasoning_details: [{ text: "thinking..." }],
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "user", content: "again", reasoning_content: "user-side field stays" },
      ],
    });

    for (const [provider, model] of [
      ["groq", "openai/gpt-oss-120b"],
      ["mistral", "codestral-latest"],
      ["cerebras", "gpt-oss-120b"],
    ]) {
      const body = makeBody();
      stripUnsupportedParams(provider, model, body);
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: "hello",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      });
      // only assistant turns are touched
      expect(body.messages[2].reasoning_content).toBe("user-side field stays");
    }
  });

  it("leaves reasoning fields alone for providers that accept or require them", () => {
    const body = {
      messages: [{ role: "assistant", content: "hello", reasoning_content: "thinking..." }],
    };

    stripUnsupportedParams("deepseek", "deepseek-reasoner", body);
    stripUnsupportedParams("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", body);

    expect(body.messages[0].reasoning_content).toBe("thinking...");
  });

  // Claude Code sends output_config.task_budget (task budgets beta) on its requests.
  // OpenCode Go's Claude lane rejects that field even with its own task-budgets-2026-03-13
  // flag, so it is stripped; context_management is NOT stripped because the upstream does
  // support context editing once default.js forwards the paired anthropic-beta flag.
  // Only claude-* models are touched — deepseek/minimax on the same endpoint accept both.
  it("drops task_budget but keeps context_management on OpenCode Go's Claude lane only", () => {
    const claude = {
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      output_config: { effort: "high", task_budget: { type: "tokens", total: 5000 } },
    };
    stripUnsupportedParams("opencode-go", "claude-haiku-5-5", claude);
    // context editing is supported upstream when its beta flag travels along
    expect(claude.context_management).toEqual({ edits: [{ type: "clear_tool_uses_20250919" }] });
    // effort is what the upstream needs for adaptive thinking — it must survive
    expect(claude.output_config).toEqual({ effort: "high" });

    const other = {
      context_management: { edits: [] },
      output_config: { effort: "high", task_budget: { type: "tokens", total: 5000 } },
    };
    stripUnsupportedParams("opencode-go", "deepseek-v4-pro", other);
    expect(other.context_management).toEqual({ edits: [] });
    expect(other.output_config.task_budget).toBeDefined();

    // An output_config left empty is removed rather than sent as {}
    const empty = { output_config: { task_budget: { type: "tokens", total: 1 } } };
    stripUnsupportedParams("opencode-go", "claude-haiku-5-5", empty);
    expect(empty).not.toHaveProperty("output_config");

    // Other providers keep both fields untouched
    const foreign = { context_management: { edits: [] }, output_config: { effort: "high" } };
    stripUnsupportedParams("deepseek", "deepseek-v4-pro", foreign);
    expect(foreign.context_management).toEqual({ edits: [] });
    expect(foreign.output_config).toEqual({ effort: "high" });
  });
});
