import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const overflowMessages = [
  "This model's maximum context length is 8192 tokens. However, you requested 64213 tokens.",
  "Error code: 400 - context_length_exceeded",
  "input length and `max_tokens` exceed context limit: 210000 > 200000",
  "The input token count (1000001) exceeds the maximum number of tokens allowed (1000000).",
  "Prompt is too long: 1676806 tokens > 1000000 maximum",
];
const log = { info: vi.fn(), warn: vi.fn() };
const body = { messages: [{ role: "user", content: "A long document" }] };
const models = ["provider-a/small-model", "provider-b/large-model"];
const failure = (message) => Response.json({ error: { message } }, { status: 400 });

describe("combo context overflow fallback (#4796)", () => {
  it.each(overflowMessages)("tries a larger member without cooling the account: %s", async (message) => {
    expect(checkFallbackError(400, message)).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
    const success = Response.json({ choices: [{ message: { content: "fits" } }] });
    const handleSingleModel = vi.fn().mockResolvedValueOnce(failure(message)).mockResolvedValueOnce(success);
    const result = await handleComboChat({ body, models, handleSingleModel, log, comboStrategy: "fallback" });
    expect(result).toBe(success);
    expect(handleSingleModel.mock.calls.map(([, model]) => model)).toEqual(models);
  });

  it("returns the first upstream rejection verbatim when every member overflows", async () => {
    const first = failure(overflowMessages[0]);
    const handleSingleModel = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(failure(overflowMessages[2]));
    const result = await handleComboChat({ body, models, handleSingleModel, log, comboStrategy: "fallback" });
    expect(result).toBe(first);
    expect(result.status).toBe(400);
    expect((await result.json()).error.message).toBe(overflowMessages[0]);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("also tries another provider for unsupported parameters under master's request-scoped policy", async () => {
    const success = Response.json({ choices: [] });
    const handleSingleModel = vi.fn().mockResolvedValueOnce(failure("unsupported parameter: foo")).mockResolvedValueOnce(success);
    expect(await handleComboChat({ body, models, handleSingleModel, log, comboStrategy: "fallback" })).toBe(success);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
