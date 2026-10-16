/**
 * CodeBuddy / WorkBuddy conversation identity headers.
 *
 * Before this, 9router sent only auth, and the CodeBuddy gateway refused the
 * call with HTTP 400 / code 11128 ("Request blocked … not sent from an official
 * client"). The official VS Code extension sends a family of identity headers;
 * this suite pins the contract that makes the gateway accept the request.
 *
 * Pinned behaviours:
 *   1. all eight headers are emitted for codebuddy-intl and codebuddy-cn only;
 *   2. conversation id is STABLE, turn/root/trace/B3-trace stay put, while
 *      message id and B3 span id change on every outbound (retry included);
 *   3. inbound identity/trace values are honoured, invalid B3 values replaced;
 *   4. two parallel turns never trade ids (AsyncLocalStorage, not instance state);
 *   5. auth headers survive untouched.
 */
import { describe, it, expect } from "vitest";
import {
  createTurn, run, addHeaders, isBuddyProvider, __test__,
} from "open-sse/utils/buddyRequestContext.js";

const IDENTITY = [
  "X-Conversation-ID", "X-Conversation-Request-ID", "X-Conversation-Message-ID",
  "X-Root-Request-ID", "X-Trace-ID", "X-B3-TraceId", "X-B3-SpanId", "X-B3-Sampled",
];

describe("CodeBuddy request identity", () => {
  it("only claims the two buddy providers", () => {
    expect(isBuddyProvider("codebuddy-intl")).toBe(true);
    expect(isBuddyProvider("codebuddy-cn")).toBe(true);
    expect(isBuddyProvider("openai")).toBe(false);
    expect(isBuddyProvider(undefined)).toBe(false);
  });

  it("emits all eight headers with the right shapes", () => {
    const turn = createTurn({});
    const h = addHeaders({ Authorization: "Bearer x" }, turn);

    for (const name of IDENTITY) expect(h[name], name).toBeTruthy();
    expect(h["X-B3-TraceId"]).toMatch(/^[0-9a-f]{32}$/);
    expect(h["X-B3-SpanId"]).toMatch(/^[0-9a-f]{16}$/);
    expect(h["X-B3-Sampled"]).toBe("1");
    expect(h["X-Root-Request-ID"]).toBe(h["X-Conversation-Request-ID"]);
    expect(h["X-Trace-ID"]).toBe(h["X-Conversation-Request-ID"]);
    // auth untouched
    expect(h.Authorization).toBe("Bearer x");
  });

  it("keeps conversation/turn id stable but regenerates message + span per outbound", () => {
    const turn = createTurn({});
    const first = addHeaders({}, turn);
    const retry = addHeaders({}, turn);

    expect(retry["X-Conversation-ID"]).toBe(first["X-Conversation-ID"]);
    expect(retry["X-Conversation-Request-ID"]).toBe(first["X-Conversation-Request-ID"]);
    expect(retry["X-Root-Request-ID"]).toBe(first["X-Root-Request-ID"]);
    expect(retry["X-Trace-ID"]).toBe(first["X-Trace-ID"]);
    expect(retry["X-B3-TraceId"]).toBe(first["X-B3-TraceId"]);

    expect(retry["X-Conversation-Message-ID"]).not.toBe(first["X-Conversation-Message-ID"]);
    expect(retry["X-B3-SpanId"]).not.toBe(first["X-B3-SpanId"]);
  });

  it("honours inbound conversation, turn and trace values", () => {
    const turn = createTurn({
      "x-conversation-id": "conv-from-client",
      "X-Conversation-Request-ID": "turn-from-client",
      "x-trace-id": "trace-from-client",
      "X-B3-TraceId": "ABCDEF0123456789ABCDEF0123456789",
      "x-b3-sampled": "0",
    });
    const h = addHeaders({}, turn);

    expect(h["X-Conversation-ID"]).toBe("conv-from-client");
    expect(h["X-Conversation-Request-ID"]).toBe("turn-from-client");
    expect(h["X-Trace-ID"]).toBe("trace-from-client");
    // B3 lowercased, inbound "0" preserved
    expect(h["X-B3-TraceId"]).toBe("abcdef0123456789abcdef0123456789");
    expect(h["X-B3-Sampled"]).toBe("0");
    expect(h["X-Root-Request-ID"]).toBe("turn-from-client");
  });

  it("rejects malformed and all-zero B3 trace ids", () => {
    expect(__test__.validB3Trace("")).toBeNull();
    expect(__test__.validB3Trace("short")).toBeNull();
    expect(__test__.validB3Trace("z".repeat(32))).toBeNull();
    expect(__test__.validB3Trace("0".repeat(32))).toBeNull();
    expect(__test__.validB3Trace("A".repeat(32))).toBe("a".repeat(32));

    // a rejected inbound value must be replaced, not forwarded
    const turn = createTurn({ "X-B3-TraceId": "0".repeat(32) });
    expect(addHeaders({}, turn)["X-B3-TraceId"]).not.toBe("0".repeat(32));
  });

  it("does not duplicate a header that already exists under other casing", () => {
    const turn = createTurn({});
    const h = addHeaders({ "x-conversation-id": "stale" }, turn);
    const keys = Object.keys(h).filter((k) => k.toLowerCase() === "x-conversation-id");
    expect(keys).toEqual(["X-Conversation-ID"]);
    expect(h["X-Conversation-ID"]).not.toBe("stale");
  });

  it("gives parallel turns independent ids (no shared singleton state)", async () => {
    const turns = Array.from({ length: 8 }, (_, i) =>
      createTurn({ "x-conversation-id": `conv-${i}` }));

    const seen = await Promise.all(turns.map((turn, i) =>
      run(turn, async () => {
        await new Promise((r) => setTimeout(r, (8 - i) * 3));
        return addHeaders({})["X-Conversation-ID"];
      })));

    expect(seen).toEqual(turns.map((_, i) => `conv-${i}`));
    expect(new Set(seen).size).toBe(8);
  });

  it("returns headers unchanged when no turn is bound", () => {
    const h = { Authorization: "Bearer x" };
    addHeaders(h, null);
    expect(h).toEqual({ Authorization: "Bearer x" });
  });
});
