import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectHttp2 = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/http2Connect.js", () => ({
  connectHttp2,
}));

import {
  clearCursorModelCache,
  cursorCatalogProxyOptions,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

function fakeSession(status, payload) {
  return {
    close() {},
    on() {},
    request() {
      const handlers = {};
      return {
        on(event, fn) {
          handlers[event] = fn;
          return this;
        },
        end() {
          queueMicrotask(() => {
            handlers.response?.({ ":status": status });
            if (payload?.length) handlers.data?.(Buffer.from(payload));
            handlers.end?.();
          });
        },
      };
    },
  };
}

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    connectHttp2.mockReset();
  });

  afterEach(() => {
    clearCursorModelCache();
    vi.unstubAllEnvs();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    connectHttp2.mockResolvedValue(fakeSession(200, payload));
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(connectHttp2).toHaveBeenCalledTimes(1);
    expect(connectHttp2).toHaveBeenCalledWith(
      "https://agent.api5.cursor.sh/agent.v1.AgentService/GetUsableModels",
      expect.objectContaining({ proxyUrl: undefined }),
    );
  });

  it("tunnels GetUsableModels through the connection proxy", async () => {
    const payload = concat(model("grok-4.7-medium", "Grok 4.7 Medium"));
    connectHttp2.mockResolvedValue(fakeSession(200, payload));

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    }, {
      proxyOptions: cursorCatalogProxyOptions({
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://user:secret@127.0.0.1:9",
        strictProxy: true,
        proxyPoolId: "pool-1",
      }),
    })).resolves.toEqual({
      models: [{ id: "grok-4.7-medium", name: "Grok 4.7 Medium" }],
    });

    expect(connectHttp2).toHaveBeenCalledWith(
      "https://agent.api5.cursor.sh/agent.v1.AgentService/GetUsableModels",
      expect.objectContaining({ proxyUrl: "http://user:secret@127.0.0.1:9" }),
    );
  });

  it("refuses a direct catalog fetch when a strict proxy does not resolve", async () => {
    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    }, {
      proxyOptions: cursorCatalogProxyOptions({
        strictProxy: true,
        proxyPoolId: "pool-1",
        connectionProxyEnabled: true,
        connectionProxyUrl: "",
      }),
    })).resolves.toBeNull();

    expect(connectHttp2).not.toHaveBeenCalled();
  });

  it.each([
    { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9", connectionNoProxy: "agent.api5.cursor.sh" },
    { vercelRelayUrl: "https://relay.example/" },
  ])("refuses unsupported strict catalog routing (%j)", async (routing) => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9999");
    vi.stubEnv("NO_PROXY", "");
    connectHttp2.mockResolvedValue(fakeSession(200, concat(model("gpt-5.2", "GPT"))));
    await expect(resolveCursorModels({
      accessToken: "cursor-token", providerSpecificData: { machineId: "machine-id" },
    }, { proxyOptions: { strictProxy: true, proxyPoolId: "pool-1", ...routing } })).resolves.toBeNull();
    expect(connectHttp2).not.toHaveBeenCalled();
  });

  it("fails open when the Cursor catalog request fails", async () => {
    connectHttp2.mockResolvedValue(fakeSession(403, Buffer.from("no")));

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
