// Regression: an unmatched 4xx (a request-scoped failure) used to hit the
// transient-cooldown default, which locked the account for 30s and — with a
// single connection — answered every other request in that window with a copy of
// the first error. A 400 "maximum context length" from one session therefore
// looked like the same failure in unrelated sessions.
import { describe, expect, it } from "vitest";
import { checkFallbackError, modelLevelError } from "../../open-sse/services/accountFallback.js";
import { MODEL_LEVEL_ERROR } from "../../open-sse/config/errorConfig.js";
import { createErrorResult } from "../../open-sse/utils/error.js";

describe("checkFallbackError — request-scoped vs account-scoped failures", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: {
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
        type: "invalid_request_error",
      },
    }));

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("does not cool the account down for a plan without API access", () => {
    // Live 403 body from the CommandCode provider surface on a Go plan: the same
    // denial comes back for every model, so a cooldown cannot fix it and only
    // turns the entitlement answer into a bogus 503 "reset after 2m".
    const result = checkFallbackError(403, JSON.stringify({
      error: {
        message: "Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
        type: "permission_error",
        code: "upgrade_required",
      },
    }));

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("does not cool the CommandCode contributor serving gate down", () => {
    // Live 403 body from the CommandCode provider surface for Meta's
    // `*-contributor` ids: the same key serves deepseek and muse-spark-1.3 there,
    // and a genuinely bad key answers 401 with different wording, so this text is a
    // serving gate and not a credential problem. The 403 status rule used to lock
    // the model, and the lock kept answering 503 "reset after 14s" after upstream
    // served the model again.
    const body = JSON.stringify({
      error: {
        message: "Authentication failed. Please check your credentials.",
        type: "permission_error",
      },
    });

    expect(checkFallbackError(403, body, 0, "commandcode")).toEqual({ shouldFallback: false, cooldownMs: 0 });

    // The upstream words blame a credential that was never the problem, so the rule
    // carries wording of its own for the client.
    const verdict = modelLevelError(403, body, "commandcode");
    expect(verdict).toMatchObject(MODEL_LEVEL_ERROR);
    expect(verdict.message).toMatch(/not serving this model right now/i);
    expect(verdict.message).not.toMatch(/check your credentials/i);
  });

  it("keeps the CLI-lane replay open for that gate", () => {
    // The CommandCode executor asks modelLevelError without a provider id. The rule
    // is provider-scoped, so it does not match there — the executor still replays
    // the turn on the CLI lane, which serves a contributor id while the provider
    // surface gates it.
    expect(modelLevelError(403, "Authentication failed. Please check your credentials.")).toBe(null);
    expect(checkFallbackError(403, "Authentication failed. Please check your credentials.", 0, "cursor").shouldFallback).toBe(true);
  });

  it("still cools the connection down for a genuinely bad CommandCode key", () => {
    const body = JSON.stringify({
      error: { message: "Invalid 'Authorization' header or token.", type: "authentication_error", code: "UNAUTHORIZED" },
    });

    expect(checkFallbackError(401, body, 0, "commandcode").shouldFallback).toBe(true);
  });

  it("matches the gate whether the request names the provider by id or by alias", async () => {
    // The router passes resolveProviderId(provider) into the classifier, and
    // callers may name the provider `cmc`; the rule is scoped to the canonical id.
    const { resolveProviderId } = await import("../../src/shared/constants/providers.js");
    const body = JSON.stringify({ error: { message: "Authentication failed. Please check your credentials." } });

    for (const named of ["commandcode", "cmc"]) {
      expect(checkFallbackError(403, body, 0, resolveProviderId(named))).toEqual({ shouldFallback: false, cooldownMs: 0 });
    }
  });

  it("keeps the classifier text on the result while the body explains the verdict", () => {
    // The request loop classifies from `result.error`. If a rule's own wording
    // replaced it there, the rule would stop matching its own verdict and the 403
    // status rule would lock the model again — the bug this rule exists to remove.
    const upstream = "[403]: Authentication failed. Please check your credentials.";
    const verdict = modelLevelError(403, upstream, "commandcode");
    const result = createErrorResult(403, upstream, undefined, null, verdict);

    expect(result.error).toBe(upstream);
    expect(checkFallbackError(result.status, result.error, 0, "commandcode")).toEqual({ shouldFallback: false, cooldownMs: 0 });
    return expect(result.response.json()).resolves.toMatchObject({
      error: {
        type: "permission_error",
        code: "model_not_available",
        message: expect.stringMatching(/not serving this model right now/i),
      },
    });
  });
});
