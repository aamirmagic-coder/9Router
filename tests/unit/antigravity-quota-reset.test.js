import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const REAL_429 = {
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Individual quota reached. ... Resets in 149h50m20s.",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "QUOTA_EXHAUSTED",
        metadata: {
          model: "gemini-3-flash-agent",
          quotaResetDelay: "149h50m20.179078308s",
          quotaResetTimeStamp: "2099-01-01T17:54:07Z",
        },
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "539420.179078308s" },
    ],
  },
};

function fakeResponse(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

describe("Antigravity parseError — quota reset extraction", () => {
  it("surfaces resetsAtMs from quotaResetTimeStamp on a 429", () => {
    const ex = new AntigravityExecutor();
    const parsed = ex.parseError(fakeResponse(429, REAL_429), JSON.stringify(REAL_429));
    expect(typeof parsed.resetsAtMs).toBe("number");
    expect(parsed.resetsAtMs).toBe(Date.parse("2099-01-01T17:54:07Z"));
    // reason + model are appended so lastError in the dashboard says WHICH pool
    expect(parsed.message).toContain("QUOTA_EXHAUSTED");
    expect(parsed.message).toContain("gemini-3-flash-agent");
  });

  it("falls back to quotaResetDelay when the timestamp is absent", () => {
    const body = structuredClone(REAL_429);
    delete body.error.details[0].metadata.quotaResetTimeStamp;
    const ex = new AntigravityExecutor();
    const parsed = ex.parseError(fakeResponse(429, body), JSON.stringify(body));
    const expected = Date.now() + Math.round((149 * 3600 + 50 * 60 + 20.179078308) * 1000);
    expect(Math.abs(parsed.resetsAtMs - expected)).toBeLessThan(5000);
  });

  it("leaves non-429 errors to the base parser", () => {
    const ex = new AntigravityExecutor();
    const body = { error: { code: 400, message: "bad request" } };
    const parsed = ex.parseError(fakeResponse(400, body), JSON.stringify(body));
    expect(parsed.resetsAtMs).toBeUndefined();
    expect(parsed.message).toContain("bad request");
  });

  it("does not invent a reset for a 429 without any reset signal", () => {
    const ex = new AntigravityExecutor();
    const body = { error: { code: 429, message: "Resource has been exhausted (e.g. check quota)." } };
    const parsed = ex.parseError(fakeResponse(429, body), JSON.stringify(body));
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("parseUpstreamError propagates the reset through the executor hook", async () => {
    const ex = new AntigravityExecutor();
    const out = await parseUpstreamError(fakeResponse(429, REAL_429), ex);
    expect(out.statusCode).toBe(429);
    expect(out.resetsAtMs).toBe(Date.parse("2099-01-01T17:54:07Z"));
  });

  it("parseUpstreamError extracts the reset even without an executor", async () => {
    const out = await parseUpstreamError(fakeResponse(429, REAL_429), null);
    expect(out.resetsAtMs).toBe(Date.parse("2099-01-01T17:54:07Z"));
  });
});
