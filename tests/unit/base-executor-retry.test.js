// Locks BaseExecutor.execute retry/fallback behavior (docs 04 GAP #1, docs 11 §7).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network layer so we can script upstream responses.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function res(status) {
  return { status, headers: { get: () => "" } };
}

function makeExec(config) {
  const ex = new BaseExecutor("test", config);
  // make headers trivial; credentials empty
  return ex;
}

const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("BaseExecutor.execute — retry by status (config-driven)", () => {
  it("retries 502 `attempts` times then succeeds", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after exhausting 502 attempts on a single url and throws", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 2, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(502));
    // single url: 1 initial + 2 retries = 3 calls, then returns the 502 response (no fallback url)
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("BaseExecutor.execute — baseUrls fallback", () => {
  it("falls over to the next url on 429 (shouldRetry)", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 429: { attempts: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(429)) // url[0] → fallback
      .mockResolvedValueOnce(res(200)); // url[1] ok
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("BaseExecutor.execute — network error retry/fallback", () => {
  it("maps network exception to 502 retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 0 } } });
    fetchMock
      .mockImplementationOnce(async () => { throw new Error("ECONNRESET"); })
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the only url fails with network error and no retries left", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 0 } } });
    // mockImplementationOnce (not persistent) avoids vitest flagging a reused rejection.
    fetchMock.mockImplementationOnce(async () => { throw new Error("boom"); });
    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }
    expect(thrown?.message).toBe("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — connect timeout fail-fast", () => {
  // A timeout that consumed a LARGE budget means the host is unreachable, not
  // slow: a healthy upstream answers well inside a big window (antigravity's
  // 1.2 MB payloads measured 18-23 s against a 120 s budget). Retrying it
  // would multiply the stall, so execute() must surface it after ONE attempt.
  //
  // Uses tiny real timeouts + an injected `noRetryTimeoutMs` so the drift is
  // exercised without waiting seconds.
  const TIMEOUT_MS = 30;

  // Queues one hanging call per expected attempt. Must be `mockImplementationOnce`,
  // not `mockImplementation`: with a persistent implementation, vitest 4 waits on
  // the promise that settles from inside an AbortSignal listener and trips its
  // 10 s hook timeout even though the test body already finished. Once-queue
  // settles identically and runs in ~50 ms.
  function queueHanging(n) {
    for (let i = 0; i < n; i++) fetchMock.mockImplementationOnce(hangingFetch());
  }

  // Hangs until the passed signal aborts, then rejects like undici does.
  function hangingFetch() {
    return (url, opts = {}) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          const err = new Error("fetch connect timeout");
          err.name = "AbortError";
          reject(err);
        };
        if (opts.signal?.aborted) return abort();
        opts.signal?.addEventListener("abort", abort, { once: true });
      });
  }

  function makeTimeoutExec(noRetryTimeoutMs) {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    ex.config.timeoutMs = TIMEOUT_MS;
    ex.config.noRetryTimeoutMs = noRetryTimeoutMs;
    return ex;
  }

  async function runAndCapture(ex, signal) {
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds, signal });
      return null;
    } catch (e) {
      return e;
    }
  }

  it("does NOT retry a connect timeout once the budget is large (>= noRetryTimeoutMs)", async () => {
    // Window far below the threshold -> "unreachable", fail fast.
    const ex = makeTimeoutExec(10);
    queueHanging(1);
    const thrown = await runAndCapture(ex);
    expect(thrown?.message).toBe("fetch connect timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a connect timeout when the budget is short (< noRetryTimeoutMs)", async () => {
    // Window above the threshold -> "slow", keep retrying.
    const ex = makeTimeoutExec(60000);
    queueHanging(4);
    const thrown = await runAndCapture(ex);
    expect(thrown?.message).toBe("fetch connect timeout");
    // 1 initial + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("an already-aborted caller signal is never retried or swallowed", async () => {
    const ex = makeTimeoutExec(10);
    queueHanging(1);
    const thrown = await runAndCapture(ex, AbortSignal.abort());
    expect(thrown?.name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — computeRetryDelay hook veto", () => {
  it("only invokes computeRetryDelay when status has retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(0);
    fetchMock.mockResolvedValueOnce(res(500));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(500);
    expect(ex.computeRetryDelay).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hook returning false skips retry (uses fallback path)", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 429: { attempts: 5, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(res(429));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    // hook vetoes retry → no fallback url → returns the 429 response as-is
    expect(out.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
