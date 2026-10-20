import { describe, it, expect, vi, beforeEach } from "vitest";
import { NON_REPLAYABLE } from "../../open-sse/config/replayPolicy.js";
import { DISPATCH_ATTEMPTED, DISPATCH_COMPLETED, createDispatchContext } from "../../open-sse/utils/dispatchState.js";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function res(status) {
  return { status, headers: { get: () => "" } };
}

const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("BaseExecutor non-replayable dispatch policy", () => {
  it("does not retry a status response or rotate fallback URLs after dispatch", async () => {
    const executor = new BaseExecutor("test", {
      baseUrls: ["https://a/api", "https://b/api"],
      retry: { 429: { attempts: 2, delayMs: 0 } }
    });
    const dispatchContext = createDispatchContext();
    fetchMock.mockResolvedValueOnce(res(429));

    const result = await executor.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      replayPolicy: NON_REPLAYABLE, dispatchContext
    });

    expect(result.response.status).toBe(429);
    expect(result.dispatchState).toBe(DISPATCH_COMPLETED);
    expect(dispatchContext.state).toBe(DISPATCH_COMPLETED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry or rotate after a network failure that may have reached upstream", async () => {
    const executor = new BaseExecutor("test", {
      baseUrls: ["https://a/api", "https://b/api"],
      retry: { 502: { attempts: 2, delayMs: 0 } }
    });
    const dispatchContext = createDispatchContext();
    fetchMock.mockImplementationOnce(async () => { throw new Error("ECONNRESET"); });

    await expect(executor.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      replayPolicy: NON_REPLAYABLE, dispatchContext
    })).rejects.toMatchObject({ message: "ECONNRESET", dispatchState: DISPATCH_ATTEMPTED });
    expect(dispatchContext.state).toBe(DISPATCH_ATTEMPTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a second dispatch when a non-replayable context is already started", async () => {
    const executor = new BaseExecutor("test", { baseUrl: "https://x/api" });
    const dispatchContext = { state: DISPATCH_COMPLETED };

    await expect(executor.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      replayPolicy: NON_REPLAYABLE, dispatchContext
    })).rejects.toMatchObject({ code: "NO_REPLAY", dispatchState: DISPATCH_COMPLETED });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
