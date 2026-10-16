import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

// agent.api5.cursor.sh is HTTP/2-only, so cursorModels.js talks raw http2 (not fetch).
// Fake http2.connect: each request answers with h2.reply = { status, body }.
const h2 = vi.hoisted(() => ({ reply: { status: 200, body: new Uint8Array() }, connect: null, requests: [] }));

vi.mock("http2", async () => {
  const { EventEmitter } = await import("node:events");
  h2.connect = vi.fn(() => {
    const client = new EventEmitter();
    client.close = vi.fn();
    client.request = vi.fn((headers) => {
      const req = new EventEmitter();
      h2.requests.push(headers);
      req.end = () => setImmediate(() => {
        req.emit("response", { ":status": h2.reply.status });
        req.emit("data", Buffer.from(h2.reply.body));
        req.emit("end");
      });
      return req;
    });
    return client;
  });
  return { default: { connect: (...args) => h2.connect(...args) } };
});

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
    h2.requests.length = 0;
    h2.connect.mockClear();
  });

  afterEach(() => {
    h2.reply = { status: 200, body: new Uint8Array() };
    clearCursorModelCache();
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
    h2.reply = { status: 200, body: payload };
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

    // Second call is served from cache: exactly one upstream connection/request.
    expect(h2.connect).toHaveBeenCalledTimes(1);
    expect(h2.connect).toHaveBeenCalledWith("https://agent.api5.cursor.sh");
    expect(h2.requests).toHaveLength(1);
    expect(h2.requests[0]).toEqual(expect.objectContaining({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      ":authority": "agent.api5.cursor.sh",
      "content-type": "application/proto",
      accept: "application/proto",
    }));
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.reply = { status: 403, body: new TextEncoder().encode("no") };

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
