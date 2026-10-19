/**
 * CommandCode prompt-cache continuity.
 *
 * Upstream `/alpha/generate` keys its prompt cache on the session identity the
 * client sends (`x-session-id` header + envelope `threadId`). 9router already
 * derives one conversation-stable UUID in prepareRequestCredentials and reuses it
 * in both places; these tests pin that contract plus the cache-read mapping.
 *
 * The accounting delta ported from 9router#5006 is the top-level
 * `cachedInputTokens` alias; the nested `inputTokenDetails.cacheReadTokens`
 * shape was already mapped (and is verified live here).
 */

import { describe, it, expect } from "vitest";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";
import { CommandCodeExecutor } from "../../open-sse/executors/commandcode.js";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = "deepseek/deepseek-v4.1-flash";

function conversation(turns) {
  return {
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Fix the failing test." },
      ...turns,
    ],
  };
}

describe("commandcode usage — cache reads are reported", () => {
  it("maps top-level cachedInputTokens to prompt_tokens_details.cached_tokens", () => {
    const usage = toOpenAIUsage(
      { inputTokens: 2043, outputTokens: 15, totalTokens: 2058, cachedInputTokens: 1984 },
      "commandcode",
    );
    expect(usage.prompt_tokens).toBe(2043);
    expect(usage.completion_tokens).toBe(15);
    expect(usage.prompt_tokens_details.cached_tokens).toBe(1984);
  });

  it("maps the nested inputTokenDetails.cacheReadTokens shape", () => {
    const usage = toOpenAIUsage(
      { inputTokens: 500, outputTokens: 4, totalTokens: 504, inputTokenDetails: { cacheReadTokens: 128 } },
      "commandcode",
    );
    expect(usage.prompt_tokens_details.cached_tokens).toBe(128);
  });

  it("prefers the nested shape and keeps cache writes", () => {
    const usage = toOpenAIUsage(
      { inputTokens: 500, outputTokens: 4, totalTokens: 504, cachedInputTokens: 0, inputTokenDetails: { cacheReadTokens: 128, cacheWriteTokens: 5 } },
      "commandcode",
    );
    expect(usage.prompt_tokens_details.cached_tokens).toBe(128);
    expect(usage.prompt_tokens_details.cache_creation_tokens).toBe(5);
  });

  it("omits the details object when upstream reports no cache read", () => {
    const usage = toOpenAIUsage({ inputTokens: 100, outputTokens: 2, totalTokens: 102 }, "commandcode");
    expect(usage.prompt_tokens_details).toBeUndefined();
  });
});

describe("commandcode session continuity", () => {
  it("keeps the header equal to the envelope threadId across turns", () => {
    const executor = new CommandCodeExecutor();
    const first = executor.prepareRequestCredentials({
      credentials: { apiKey: "user_test", connectionId: "conn-1" },
      providerSessionId: "conversation-42",
    });
    const firstBody = openaiToCommandCodeRequest(MODEL, conversation([]), true, first);
    const firstHeaders = executor.buildHeaders(first, true);

    const second = executor.prepareRequestCredentials({
      credentials: { apiKey: "user_test", connectionId: "conn-1" },
      providerSessionId: "conversation-42",
    });
    const secondBody = openaiToCommandCodeRequest(
      MODEL,
      conversation([{ role: "assistant", content: "Done." }, { role: "user", content: "Thanks." }]),
      true,
      second,
    );
    const secondHeaders = executor.buildHeaders(second, true);

    expect(UUID_RE.test(firstHeaders["x-session-id"])).toBe(true);
    expect(firstHeaders["x-session-id"]).toBe(firstBody.threadId);
    expect(secondHeaders["x-session-id"]).toBe(secondBody.threadId);
    expect(secondHeaders["x-session-id"]).toBe(firstHeaders["x-session-id"]);
  });
});
