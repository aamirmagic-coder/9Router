import { afterEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetcher.fetch }));
afterEach(() => vi.useRealTimers());

describe("quota guard stale usage safety", () => {
  it("marks a Claude stale fallback so the monitor cannot treat it as recovery", async () => {
    vi.useFakeTimers();
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    fetcher.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 10 } }) });
    const token = "stale-guard-test";
    expect((await getClaudeUsage(token)).quotas["session (5h)"].remaining).toBe(90);
    vi.advanceTimersByTime(300001);
    fetcher.fetch.mockRejectedValue(new Error("offline"));
    expect((await getClaudeUsage(token)).stale).toBe(true);
  });
});
