// Command Code provider surface + region-403 classification.
//
// Break caught: the gateway posted every request to the CLI-only
// /alpha/generate surface with CLI headers. That surface version-gates and
// region-gates external callers, so a model the account may use still 403s
// "not available in your region" — and the status-403 fallback rule then locked
// the connection for 2m, surfacing a bogus 503 "reset after 2m" instead of the
// upstream message. The documented Provider API surface is the working lane.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import { CommandCodeExecutor } from "../../open-sse/executors/commandcode.js";
import { commandCodeToOpenAIResponse } from "../../open-sse/translator/response/commandcode-to-openai.js";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";
import { checkFallbackError, modelLevelError } from "../../open-sse/services/accountFallback.js";
import { createErrorResult } from "../../open-sse/utils/error.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REGION_MESSAGE =
  "meta/muse-spark-1.3-contributor is not available in your region per Meta's Geographic Use Policy. " +
  "Read more at https://ai.developer.meta.com/legal/geographic-use-policy. Please try a different model.";

// Live 403 from /provider/v1/chat/completions for meta/* when the connection lands
// on a Cloudflare edge that does not serve the model (verified live: cf-ray HKG
// answers this for the same key and body the SIN edge serves).
const EDGE_GATE = {
  error: {
    message: "Authentication failed. Please check your credentials.",
    type: "permission_error",
  },
};

// Live 403 from /provider/v1/chat/completions on a Go plan, for every model.
const PLAN_DENIAL = {
  error: {
    message: "Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
    type: "permission_error",
    code: "upgrade_required",
  },
};

const OK_NDJSON = [
  JSON.stringify({ type: "text-delta", text: "hello" }),
  JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 1 } }),
].join("\n") + "\n";

function ndjsonResponse(lines, status = 200) {
  const body = Array.isArray(lines) ? lines.join("\n") + "\n" : lines;
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

function errorEventResponse(message, statusCode = 403) {
  return ndjsonResponse([JSON.stringify({ type: "error", error: { type: "permission_error", message, statusCode } })]);
}

function executeArgs(overrides = {}) {
  return {
    model: "meta/muse-spark-1.3-contributor",
    body: {
      model: "meta/muse-spark-1.3-contributor",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    },
    stream: true,
    credentials: { apiKey: "user_test", connectionId: "conn-1" },
    providerSessionId: "session-abc",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.proxyAwareFetch.mockReset();
});

describe("commandcode registry transport", () => {
  it("targets the documented Provider API surface, keeping alpha as the CLI fallback", () => {
    const cfg = PROVIDERS.commandcode;
    expect(cfg.baseUrl).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    expect(cfg.cliUrl).toBe("https://api.commandcode.ai/alpha/generate");
    // Requests are OpenAI-shaped on this surface; the response is still NDJSON
    // (the executor pins responseFormat to commandcode for the SSE translator).
    expect(cfg.format).toBe("openai");
    expect(cfg.headers["x-command-code-version"]).toBe("1.81.0");
  });
});

describe("CommandCodeExecutor surfaces", () => {
  it("posts the OpenAI body to the provider surface with a stable session id", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch.mockResolvedValue(ndjsonResponse(OK_NDJSON));

    const result = await executor.execute(executeArgs());

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    // Upstream validates session/thread ids as UUIDs; the gateway's seed is not.
    expect(init.headers["x-session-id"]).toMatch(UUID_RE);
    expect(init.headers["x-command-code-version"]).toBe("1.81.0");

    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("meta/muse-spark-1.3-contributor");
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sent.stream).toBe(true);
    // No CLI envelope on this surface.
    expect(sent.threadId).toBeUndefined();
    expect(sent.params).toBeUndefined();

    expect(result.responseFormat).toBe(FORMATS.COMMANDCODE);
    await expect(result.response.text()).resolves.toContain("hello");
  });

  it.each([403, 404])("replays the turn on the CLI surface when the provider surface answers %s", async (status) => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "no provider api access" } }), { status }))
      .mockResolvedValueOnce(ndjsonResponse(OK_NDJSON));

    const result = await executor.execute(executeArgs());

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    const [cliUrl, cliInit] = mocks.proxyAwareFetch.mock.calls[1];
    expect(cliUrl).toBe("https://api.commandcode.ai/alpha/generate");
    expect(cliInit.headers["x-cli-environment"]).toBe("external");
    expect(cliInit.headers["x-command-code-version"]).toBe("1.81.0");

    const envelope = JSON.parse(cliInit.body);
    // Break caught: a non-UUID threadId here makes upstream answer
    // 400 "Invalid UUID at threadId" for the CLI surface.
    expect(envelope.threadId).toMatch(UUID_RE);
    expect(envelope.threadId).toBe(cliInit.headers["x-session-id"]);
    expect(envelope.params.model).toBe("meta/muse-spark-1.3-contributor");
    // The CLI envelope carries content blocks, not the OpenAI string form.
    expect(envelope.params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    expect(result.responseFormat).toBe(FORMATS.COMMANDCODE);
    await expect(result.response.text()).resolves.toContain("hello");
  });

  it("reconnects on a fresh connection when the provider surface answers the edge gate", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(EDGE_GATE), { status: 403 }))
      .mockResolvedValueOnce(ndjsonResponse(OK_NDJSON));

    const result = await executor.execute(executeArgs());

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    const [gateUrl, gateInit] = mocks.proxyAwareFetch.mock.calls[0];
    const [retryUrl, retryInit] = mocks.proxyAwareFetch.mock.calls[1];
    expect(retryUrl).toBe(gateUrl);
    // The verdict belongs to the edge that answered, not to the turn: retrying over
    // the same pooled socket would hear it again.
    expect(gateInit.dispatcher).toBeDefined();
    expect(retryInit.dispatcher).not.toBe(gateInit.dispatcher);

    expect(result.responseFormat).toBe(FORMATS.COMMANDCODE);
    await expect(result.response.text()).resolves.toContain("hello");
  });

  it("gives the CLI replay a connection of its own", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(PLAN_DENIAL), { status: 403 }))
      .mockResolvedValueOnce(ndjsonResponse(OK_NDJSON));

    const result = await executor.execute(executeArgs());

    const [, providerInit] = mocks.proxyAwareFetch.mock.calls[0];
    const [, cliInit] = mocks.proxyAwareFetch.mock.calls[1];
    // Same host, so a shared socket would answer both lanes the same way.
    expect(cliInit.dispatcher).toBeDefined();
    expect(cliInit.dispatcher).not.toBe(providerInit.dispatcher);
    expect(result.url).toBe("https://api.commandcode.ai/alpha/generate");
  });

  it("never hands the next turn the connection a gate rejected", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify(EDGE_GATE), { status: 403 }));

    await executor.execute(executeArgs());
    await executor.execute(executeArgs());

    const dispatchers = mocks.proxyAwareFetch.mock.calls.map(([, init]) => init.dispatcher);
    expect(dispatchers.every((d) => d !== undefined)).toBe(true);
    // Every attempt draws its own connection — including the attempt after the
    // reconnect budget runs out, so a gated edge cannot greet the next turn.
    expect(new Set(dispatchers).size).toBe(dispatchers.length);
  });

  it("keeps the provider-surface region verdict instead of handing it to the CLI lane", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: REGION_MESSAGE } }), { status: 403 })
    );

    const result = await executor.execute(executeArgs());

    // Every reconnect answers the same verdict, so the surface that denied the turn
    // keeps the last word on it rather than the CLI lane's copy of it.
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(3);
    expect(result.url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    expect(result.response.status).toBe(403);
    // Classifying the body must not consume it: the router reports it onward.
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: REGION_MESSAGE },
    });
  });

  it("hands a plan-denied provider surface to the CLI lane's own verdict", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(new Response(JSON.stringify(PLAN_DENIAL), { status: 403 }))
      .mockResolvedValueOnce(errorEventResponse(REGION_MESSAGE));

    const result = await executor.execute(executeArgs());

    // The plan denial answers the same 403 for every model on this surface
    // (verified live: muse-spark and deepseek both get it), so it carries no
    // information about the model. The CLI lane is the one such a plan is entitled
    // to, so its verdict — here Meta's geographic restriction on the model — is the
    // answer the caller can act on; the plan message would send them to a billing
    // page that cannot lift a regional restriction.
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(result.url).toBe("https://api.commandcode.ai/alpha/generate");
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("Geographic Use Policy") },
    });
  });

  it("surfaces a provider-surface 400 without replaying it on the CLI surface", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 })
    );

    const result = await executor.execute(executeArgs());

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(400);
  });

  it("reports the router's own CLI version when upstream gates it", () => {
    const executor = new CommandCodeExecutor();
    // Live 403 from /alpha/generate when the request carries no
    // x-command-code-version header (any version >= minVersion is accepted).
    const bodyText = JSON.stringify({
      error: {
        code: "upgrade_required",
        message: "Your Command Code CLI is out of date. Run `cmd update` or `npm i -g command-code` to upgrade.",
        minVersion: "0.18.10",
      },
    });

    const parsed = executor.parseError(new Response(bodyText, { status: 403 }), bodyText);

    expect(parsed.status).toBe(403);
    // The upstream wording tells the operator to update a binary they do not run.
    expect(parsed.message).not.toContain("cmd update");
    expect(parsed.message).toContain("minimum 0.18.10");
    expect(parsed.message).toContain(PROVIDERS.commandcode.headers["x-command-code-version"]);
  });

  it("keeps a plan denial's own wording and its no-cooldown classification", () => {
    const executor = new CommandCodeExecutor();
    const bodyText = JSON.stringify(PLAN_DENIAL);

    const parsed = executor.parseError(new Response(bodyText, { status: 403 }), bodyText);

    // The plan denial shares `upgrade_required` with the CLI version gate. Its
    // wording is what the router's no-cooldown rule keys on, so rewriting it into a
    // version message would lock the connection for a plan no cooldown can change.
    expect(parsed.message).toContain("doesn't include API access");
    expect(checkFallbackError(parsed.status, parsed.message).shouldFallback).toBe(false);
  });

  it("keeps the upstream wording for a CLI-lane error it does not explain", () => {
    const executor = new CommandCodeExecutor();
    const bodyText = JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } });

    const parsed = executor.parseError(new Response(bodyText, { status: 429 }), bodyText);

    expect(parsed.status).toBe(429);
    expect(parsed.message).toBe("Too many requests");
  });

  it("does not retry a region rejection carried by a 200 stream", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch.mockResolvedValue(errorEventResponse(REGION_MESSAGE));

    const result = await executor.execute(executeArgs());

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(result.response.ok).toBe(false);
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("Geographic Use Policy") },
    });
  });

  it("floors a small muse-spark output budget and leaves other models alone", () => {
    const executor = new CommandCodeExecutor();
    const muse = executor.transformRequest("meta/muse-spark-1.3-contributor", { max_tokens: 64 }, true, {});
    expect(muse.max_tokens).toBe(512);

    const other = executor.transformRequest("zai-org/GLM-5.2", { max_tokens: 64 }, true, {});
    expect(other.max_tokens).toBe(64);
  });

  it("clamps an oversized output budget before it reaches the provider surface", () => {
    const executor = new CommandCodeExecutor();
    const body = executor.transformRequest("deepseek/deepseek-v4.1-flash", {
      max_tokens: 384000,
      max_output_tokens: 1000000,
      max_completion_tokens: 250000,
    }, true, {});

    expect(body.max_tokens).toBe(200000);
    expect(body.max_output_tokens).toBe(200000);
    expect(body.max_completion_tokens).toBe(200000);
  });
});

describe("Command Code region 403 classification", () => {
  it("does not lock or rotate the account for a geographic restriction", () => {
    const result = checkFallbackError(403, JSON.stringify({ error: { message: REGION_MESSAGE } }));
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("still falls back for an ordinary 403 and backs off for 429", () => {
    expect(checkFallbackError(403, "permission denied").shouldFallback).toBe(true);
    expect(checkFallbackError(429, "slow down").shouldFallback).toBe(true);
  });

  it("reports a region verdict to the client as a model error, not an exhausted quota", async () => {
    // `insufficient_quota` here makes an OpenAI-compatible client treat the answer
    // as a usage limit: it parks the credential for a whole quota window, or aborts
    // the turn when the window exceeds its delay cap, over a model it cannot call.
    const { response } = createErrorResult(403, REGION_MESSAGE, undefined, null, modelLevelError(403, REGION_MESSAGE));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "permission_error", code: "model_not_available" },
    });
  });

  it("does not flag an ordinary 403 as a model verdict", () => {
    expect(modelLevelError(403, "permission denied")).toBeNull();
  });
});

describe("Command Code session id contract", () => {
  it("derives a stable UUID from a non-UUID gateway seed", async () => {
    const executor = new CommandCodeExecutor();
    // Fresh Response per call: a body can only be read once.
    mocks.proxyAwareFetch.mockImplementation(async () => ndjsonResponse(OK_NDJSON));

    await executor.execute(executeArgs());
    await executor.execute(executeArgs());

    const first = mocks.proxyAwareFetch.mock.calls[0][1].headers["x-session-id"];
    const second = mocks.proxyAwareFetch.mock.calls[1][1].headers["x-session-id"];
    expect(first).toMatch(UUID_RE);
    expect(second).toBe(first);
    expect(first).not.toBe("session-abc");
  });

  it("keeps a UUID seed as-is", async () => {
    const executor = new CommandCodeExecutor();
    mocks.proxyAwareFetch.mockImplementation(async () => ndjsonResponse(OK_NDJSON));
    const seed = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    await executor.execute(executeArgs({ providerSessionId: seed }));

    expect(mocks.proxyAwareFetch.mock.calls[0][1].headers["x-session-id"]).toBe(seed);
  });
});

describe("Command Code usage caching", () => {
  it("reports the cached prefix as subsets of the inclusive prompt count", () => {
    const usage = toOpenAIUsage(
      { inputTokens: 100, outputTokens: 20, totalTokens: 120, inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 5 } },
      "commandcode"
    );
    expect(usage.prompt_tokens).toBe(100);
    expect(usage.completion_tokens).toBe(20);
    expect(usage.total_tokens).toBe(120);
    expect(usage.prompt_tokens_details.cached_tokens).toBe(30);
    expect(usage.prompt_tokens_details.cache_creation_tokens).toBe(5);
  });

  it("omits the detail block when the gateway reports no cache activity", () => {
    const usage = toOpenAIUsage({ inputTokens: 10, outputTokens: 1 }, "commandcode");
    expect(usage.prompt_tokens_details).toBeUndefined();
  });
});

describe("Command Code stream translation", () => {
  it("surfaces hidden reasoning as content when the turn ends with no visible text", () => {
    const state = { model: "meta/muse-spark-1.3-contributor" };
    const events = [
      commandCodeToOpenAIResponse(JSON.stringify({ type: "reasoning-delta", text: "thinking hard" }), state),
      commandCodeToOpenAIResponse(JSON.stringify({ type: "finish", finishReason: "stop" }), state),
    ];

    const chunks = events.flat().filter(Boolean);
    const content = chunks.find((c) => c.choices?.[0]?.delta?.content === "thinking hard");
    expect(content).toBeDefined();
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("keeps the visible answer when the model emitted text", () => {
    const state = { model: "meta/muse-spark-1.3-contributor" };
    const events = [
      commandCodeToOpenAIResponse(JSON.stringify({ type: "reasoning-delta", text: "thinking hard" }), state),
      commandCodeToOpenAIResponse(JSON.stringify({ type: "text-delta", text: "the answer" }), state),
      commandCodeToOpenAIResponse(JSON.stringify({ type: "finish", finishReason: "stop" }), state),
    ];

    const chunks = events.flat().filter(Boolean);
    const contents = chunks.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean);
    expect(contents).toContain("the answer");
    expect(contents).not.toContain("thinking hard");
  });
});

describe("commandcode catalog filter", () => {
  it("lists chat-servable ids and drops /messages-only ones", async () => {
    const { FILTERS } = await import("../../src/app/api/providers/suggested-models/filters.js");
    const rows = FILTERS.commandcode([
      { id: "meta/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", context_length: 1048576, supported_endpoints: ["/chat/completions"] },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", supported_endpoints: ["/messages"] },
      { object: "model" },
    ]);

    expect(rows.map((r) => r.id)).toEqual(["deepseek/deepseek-v4-pro", "meta/muse-spark-1.3-contributor"]);
    expect(rows.find((r) => r.id === "meta/muse-spark-1.3-contributor").contextLength).toBe(1048576);
  });
});

describe("openaiToCommandCodeRequest (CLI envelope)", () => {
  it("nests a top-level reasoning_effort under params and keeps the caller's thread", () => {
    const threadId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const envelope = openaiToCommandCodeRequest(
      "meta/muse-spark-1.3-contributor",
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      true,
      { _ccSessionId: threadId }
    );
    expect(envelope.threadId).toBe(threadId);
    expect(envelope.params.reasoning_effort).toBe("high");
    expect(envelope.config.environment).toBe("external");
  });

  it("falls back to a fresh UUID when no session is attached", () => {
    const envelope = openaiToCommandCodeRequest(
      "meta/muse-spark-1.3-contributor",
      { messages: [{ role: "user", content: "hi" }] },
      true,
      null
    );
    expect(envelope.threadId).toMatch(UUID_RE);
  });
});
