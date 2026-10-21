import { afterEach, describe, it, expect, vi } from "vitest";
import { proxyAwareFetch, resolveOutboundProxyUrl } from "../../open-sse/utils/proxyFetch.js";

afterEach(() => vi.unstubAllEnvs());

vi.mock("../../open-sse/services/cursorModels.js", () => ({
  resolveCursorModels: vi.fn(async () => ({ models: [{ id: "gpt-5.2" }] })),
}));

import { CursorExecutor } from "../../open-sse/executors/cursor.js";

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

function stubSession(executor) {
  let opened = 0;
  const connect = vi.fn(() => {
    opened += 1;
    return {
      responseHeaders: Promise.resolve({ ":status": 200 }),
      write() {},
      end() {},
      close() {},
      async read() { return { value: undefined, done: true }; },
    };
  });
  executor.openAgentHttp2Stream = connect;
  return { connect, opened: () => opened };
}

async function runAgent(executor, proxyOptions) {
  return executor.executeAgent({
    model: "gpt-5.2",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials,
    proxyOptions,
  });
}

describe("Cursor AgentService strict-proxy policy guard", () => {
  it("refuses to open any h2 session when a strict proxy is intended but unresolved", async () => {
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, {
      strictProxy: true,
      proxyPoolId: "pool-1",
      connectionProxyEnabled: true,
      connectionProxyUrl: "", // pool drained/inactive: nothing resolves
    })).rejects.toThrow(/strict proxy/u);
    expect(connect).not.toHaveBeenCalled();
  });

  it("fails closed when a strict pool id is present even without an explicit url", async () => {
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, {
      strictProxy: true,
      proxyPoolId: "pool-1",
    })).rejects.toThrow(/strict proxy/u);
    expect(connect).not.toHaveBeenCalled();
  });

  it("tunnels when a strict proxy URL resolves (CONNECT path)", async () => {
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, {
      strictProxy: true,
      enabled: true,
      url: "http://127.0.0.1:9",
    })).resolves.toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][3]).toMatchObject({ enabled: true, url: "http://127.0.0.1:9" });
  });

  it("tunnels when a strict connectionProxyUrl resolves", async () => {
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, {
      strictProxy: true,
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:9",
    })).resolves.toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][3]).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:9",
    });
  });

  it("non-strict proxy options keep today's direct h2 behavior", async () => {
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, {
      strictProxy: false,
      proxyPoolId: "pool-1",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:9",
    })).resolves.toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("no proxy options at all keeps the direct h2 path", async () => {
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, null)).resolves.toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("strict without any proxy intent is not blocked (nothing to honor)", async () => {
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, { strictProxy: true })).resolves.toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not substitute an environment proxy for an excluded strict bound proxy", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9999");
    vi.stubEnv("NO_PROXY", "");
    const proxyOptions = {
      strictProxy: true, proxyPoolId: "pool-1",
      connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9",
      connectionNoProxy: "agent.api5.cursor.sh",
    };
    expect(resolveOutboundProxyUrl("https://agent.api5.cursor.sh/", proxyOptions)).toBeNull();
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, proxyOptions)).rejects.toThrow(/strict proxy/u);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an excluded strict fetch proxy before entering MITM DNS bypass", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9999");
    vi.stubEnv("NO_PROXY", "");
    await expect(proxyAwareFetch("https://api2.cursor.sh/v1/chat", {}, {
      strictProxy: true, proxyPoolId: "pool-1",
      connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9",
      connectionNoProxy: "api2.cursor.sh",
    })).rejects.toThrow(/none resolved.*strictProxy/u);
  });

  it("rejects an unsupported relay instead of opening a direct h2 session", async () => {
    const executor = new CursorExecutor();
    const { connect } = stubSession(executor);
    await expect(runAgent(executor, {
      strictProxy: true,
      proxyPoolId: "relay-1",
      vercelRelayUrl: "https://relay.example/",
    })).rejects.toThrow(/strict proxy/u);
    expect(connect).not.toHaveBeenCalled();
  });

  it("execute() routes the failure through its connection_error envelope", async () => {
    const executor = new CursorExecutor();
    stubSession(executor);
    const result = await executor.execute({
      model: "gpt-5.2",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials,
      proxyOptions: { strictProxy: true, proxyPoolId: "pool-1" },
    });
    expect(result.response.status).toBeGreaterThanOrEqual(500);
    const payload = await result.response.json();
    expect(payload.error.message).toMatch(/strict proxy/u);
    expect(payload.error.type).toBe("connection_error");
  });
});
