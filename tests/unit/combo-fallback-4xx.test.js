// Regression: an unmatched 4xx (e.g. "too many payload" / 413) used to stop the
// combo immediately because the account-fallback classifier said shouldFallback:false.
// Combo fallback is user intent, so every model must be tried and the last upstream
// error returned in its native shape.
import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("handleComboChat — fallback on request-scoped errors", () => {
  it("falls back past a 413 too-many-payload error", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { messages: [] },
      models: ["a/one", "b/two"],
      log,
      comboName: "x",
      handleSingleModel: async (_, model) => {
        calls.push(model);
        return model === "a/one"
          ? json(413, { error: { message: "too many payload" } })
          : json(200, { choices: [{ message: { content: "ok" } }] });
      },
    });

    expect(calls).toEqual(["a/one", "b/two"]);
    expect(result.status).toBe(200);
  });

  it("returns the last upstream error when every model fails", async () => {
    const result = await handleComboChat({
      body: { messages: [] },
      models: ["a/one", "b/two"],
      log,
      comboName: "y",
      handleSingleModel: async (_, model) =>
        json(model === "a/one" ? 400 : 422, { error: { message: `${model} broke` } }),
    });

    expect(result.status).toBe(422);
    expect((await result.json()).error.message).toBe("b/two broke");
  });
});
