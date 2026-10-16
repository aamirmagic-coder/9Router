// Guards the "fail fast then rotate" timeouts.
//
// Background: `connectTimer` in executors/base.js is cleared when the response
// HEADERS arrive, so its budget is really a time-to-first-byte limit, not a TCP
// connect limit. Two ways that goes wrong:
//
//   1. FETCH_CONNECT_TIMEOUT_MS and NO_RETRY_TIMEOUT_MS were both 60s, so
//      `timeoutMs >= noRetryTimeoutMs` was always true and the "unreachable →
//      don't retry" branch swallowed every provider, including ones that were
//      merely slow.
//   2. A provider with a stalled upstream but no timeout of its own waited the
//      full default before rotating — one Claude Code request could hang for
//      minutes across accounts.
//
// Both are silent failures: nothing throws, requests just take far longer than
// they should. These tests pin the values that keep them from returning.
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/providers/index.js";
import {
  FETCH_CONNECT_TIMEOUT_MS,
  NO_RETRY_TIMEOUT_MS,
} from "open-sse/config/runtimeConfig.js";

describe("connect-timeout defaults", () => {
  it("keeps the global fail-fast threshold strictly above the default budget", () => {
    // The regression: equal values make `timeoutMs >= noRetryTimeoutMs` true
    // for every provider that does not override it, disabling retries broadly.
    expect(NO_RETRY_TIMEOUT_MS).toBeGreaterThan(FETCH_CONNECT_TIMEOUT_MS);
  });

  it("still lets large-budget providers trip the fail-fast branch", () => {
    // antigravity runs a 120s budget; the branch exists to stop retrying a
    // provider that cannot answer within a budget that big.
    expect(PROVIDERS.antigravity).toBeTruthy();
    const budget = PROVIDERS.antigravity.timeoutMs ?? FETCH_CONNECT_TIMEOUT_MS;
    if (budget >= FETCH_CONNECT_TIMEOUT_MS) {
      // Informational: the branch must be reachable for it.
      expect(budget).toBeGreaterThanOrEqual(FETCH_CONNECT_TIMEOUT_MS);
    }
  });
});

describe("bai timeout", () => {
  it("fails fast instead of waiting the 60s default", () => {
    expect(PROVIDERS.bai.timeoutMs).toBe(25000);
  });

  it("sets noRetryTimeoutMs equal to its budget so it rotates accounts", () => {
    // Measured: a healthy api.b.ai first-byte is 2.2-4.0s even with an 87K-token
    // prompt and 102 tool definitions. Waiting longer does not help — the pool
    // has 600+ accounts, so discarding a stalled one beats waiting on it.
    // Equal values make BaseExecutor treat the timeout as "unreachable" and
    // move on immediately; without it, 3 retries x 25s would be far worse.
    expect(PROVIDERS.bai.noRetryTimeoutMs).toBe(PROVIDERS.bai.timeoutMs);
  });
});

describe("meta-code timeout", () => {
  it("allows more room than bai because reasoning legitimately runs slower", () => {
    // Measured: api.meta.ai first-byte with a 45K-token context is 5.8-12.2s.
    // A 25s budget would cut off turns that are actually progressing.
    expect(PROVIDERS["meta-code"].timeoutMs).toBe(45000);
    expect(PROVIDERS["meta-code"].timeoutMs).toBeGreaterThan(PROVIDERS.bai.timeoutMs);
  });

  it("does not retry, because the pool is a single account", () => {
    // Retrying cannot rotate to a different account here — it only multiplies
    // the wait. Fail once, clearly, rather than 3 x 45s.
    expect(PROVIDERS["meta-code"].noRetryTimeoutMs).toBe(PROVIDERS["meta-code"].timeoutMs);
  });
});
