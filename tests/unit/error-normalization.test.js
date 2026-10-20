import { describe, it, expect } from "vitest";
import { NON_REPLAYABLE } from "../../open-sse/config/replayPolicy.js";
import { DISPATCH_ATTEMPTED } from "../../open-sse/utils/dispatchState.js";
import { createErrorResult, parseUpstreamError } from "../../open-sse/utils/error.js";

describe("dispatch metadata survives error normalization", () => {
  it("keeps internal dispatch state on the result and response while exposing only an advisory header", () => {
    const result = createErrorResult(502, "upstream failed", undefined, {}, {
      dispatchState: DISPATCH_ATTEMPTED,
      replayPolicy: NON_REPLAYABLE
    });

    expect(result.dispatchState).toBe(DISPATCH_ATTEMPTED);
    expect(result.replayPolicy).toBe(NON_REPLAYABLE);
    expect(result.response.dispatchState).toBe(DISPATCH_ATTEMPTED);
    expect(result.response.headers.get("x-9router-no-replay")).toBe("1");
  });

  it("carries dispatch state through upstream parsing", async () => {
    const response = new Response(JSON.stringify({ error: { message: "bad" } }), { status: 502 });
    const parsed = await parseUpstreamError(response, null, { state: DISPATCH_ATTEMPTED });
    expect(parsed.dispatchState).toBe(DISPATCH_ATTEMPTED);
  });
});
