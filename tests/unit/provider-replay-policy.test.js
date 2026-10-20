import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { DEFAULT_REPLAY_POLICY, NON_REPLAYABLE, normalizeReplayPolicy } from "../../open-sse/config/replayPolicy.js";
import { resolveReplayPolicy } from "../../open-sse/services/provider.js";

const originalDataDir = process.env.DATA_DIR;
const originalFetch = global.fetch;
let tempDir;

describe("provider replay policy", () => {
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-replay-policy-"));
    process.env.DATA_DIR = tempDir;
  });

  afterAll(() => {
    const adapter = global._dbAdapter?.instance;
    try { adapter?.close?.(); } finally {
      if (global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
    }
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("next/server");
    vi.doUnmock("@/dashboardGuard");
    global.fetch = originalFetch;
    process.env.DATA_DIR = tempDir;
  });

  it("defaults omitted values to replayable and rejects unknown values", () => {
    expect(normalizeReplayPolicy()).toBe(DEFAULT_REPLAY_POLICY);
    expect(normalizeReplayPolicy(null)).toBe(DEFAULT_REPLAY_POLICY);
    expect(normalizeReplayPolicy(NON_REPLAYABLE)).toBe(NON_REPLAYABLE);
    expect(() => normalizeReplayPolicy("maybe")).toThrow(/replayPolicy/);
  });

  it("persists explicit non-replayable policy across module restart", async () => {
    process.env.DATA_DIR = tempDir;
    vi.resetModules();

    const firstModels = await import("@/models/index.js");
    await firstModels.createProviderNode({
      id: "openai-compatible-replay-test",
      type: "openai-compatible",
      name: "Replay Test",
      prefix: "replay-test",
      apiType: "chat",
      baseUrl: "http://127.0.0.1:20129/v1",
      replayPolicy: NON_REPLAYABLE,
    });
    expect((await firstModels.getProviderNodeById("openai-compatible-replay-test")).replayPolicy).toBe(NON_REPLAYABLE);

    vi.resetModules();
    const restartedModels = await import("@/models/index.js");
    expect((await restartedModels.getProviderNodeById("openai-compatible-replay-test")).replayPolicy).toBe(NON_REPLAYABLE);
  });

  it("round-trips policy through provider-node API and compatible connection metadata", async () => {
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
    vi.doMock("@/dashboardGuard", () => ({ isLocalRequest: () => true }));

    const { POST: createNode } = await import("@/app/api/provider-nodes/route.js");
    const { PUT: updateNode } = await import("@/app/api/provider-nodes/[id]/route.js");
    const { POST: createConnection } = await import("@/app/api/providers/route.js");
    const invalid = await createNode(new Request("http://127.0.0.1/api/provider-nodes", {
      method: "POST",
      body: JSON.stringify({
        name: "Invalid",
        prefix: "invalid",
        apiType: "chat",
        baseUrl: "http://127.0.0.1:20129/v1",
        replayPolicy: "sometimes",
      }),
    }));
    expect(invalid.status).toBe(400);

    const created = await createNode(new Request("http://127.0.0.1/api/provider-nodes", {
      method: "POST",
      body: JSON.stringify({
        name: "CGW Relay",
        prefix: "cgw",
        apiType: "chat",
        baseUrl: "http://127.0.0.1:20129/v1",
        replayPolicy: NON_REPLAYABLE,
      }),
    }));
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expect(createdBody.node.replayPolicy).toBe(NON_REPLAYABLE);

    const updated = await updateNode(new Request("http://127.0.0.1/api/provider-nodes/update", {
      method: "PUT",
      body: JSON.stringify({
        name: "CGW Relay Updated",
        prefix: "cgw",
        apiType: "chat",
        baseUrl: "http://127.0.0.1:20129/v1",
        replayPolicy: DEFAULT_REPLAY_POLICY,
      }),
    }), { params: { id: createdBody.node.id } });
    expect(updated.status).toBe(200);
    expect((await updated.json()).node.replayPolicy).toBe(DEFAULT_REPLAY_POLICY);

    const restored = await createConnection(new Request("http://127.0.0.1/api/providers", {
      method: "POST",
      body: JSON.stringify({
        provider: createdBody.node.id,
        apiKey: "test-key",
        name: "CGW Connection",
        defaultModel: "gpt-6.1-sol",
      }),
    }));
    expect(restored.status).toBe(201);
    expect((await restored.json()).connection.providerSpecificData.replayPolicy).toBe(DEFAULT_REPLAY_POLICY);
  });

  it("returns the normalized policy from local relay validation", async () => {
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
    vi.doMock("@/dashboardGuard", () => ({ isLocalRequest: () => true }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/provider-nodes/validate/route.js");
    const response = await POST(new Request("http://127.0.0.1/api/provider-nodes/validate", {
      method: "POST",
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:20129/v1",
        apiKey: "test-key",
        type: "openai-compatible",
        replayPolicy: NON_REPLAYABLE,
      }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).replayPolicy).toBe(NON_REPLAYABLE);
  });

  it("keeps legacy node records replayable", async () => {
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const models = await import("@/models/index.js");
    await models.createProviderNode({
      id: "openai-compatible-legacy-test",
      type: "openai-compatible",
      name: "Legacy Test",
      prefix: "legacy-test",
      apiType: "chat",
      baseUrl: "http://127.0.0.1:20129/v1",
    });
    expect((await models.getProviderNodeById("openai-compatible-legacy-test")).replayPolicy).toBe(DEFAULT_REPLAY_POLICY);
  });

  it("resolves policy from compatible connection metadata and preserves the default", () => {
    expect(resolveReplayPolicy("openai-compatible-chat-test", {
      providerSpecificData: { replayPolicy: NON_REPLAYABLE },
    })).toBe(NON_REPLAYABLE);
    expect(resolveReplayPolicy("openai-compatible-chat-test", { providerSpecificData: {} })).toBe(DEFAULT_REPLAY_POLICY);
    expect(resolveReplayPolicy("anthropic-compatible-test", {
      providerSpecificData: { replayPolicy: NON_REPLAYABLE },
    })).toBe(DEFAULT_REPLAY_POLICY);
  });
});
