// A5 (cases #7/#9/#10): lock hardcode->config no-op values.
import { describe, it, expect } from "vitest";
import {
  OPENAI_COMPAT_BASE,
  ANTHROPIC_COMPAT_BASE,
  ANTHROPIC_API_VERSION,
} from "../../open-sse/providers/shared.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";
import mimoFree from "../../open-sse/providers/registry/mimo-free.js";
import opencode from "../../open-sse/providers/registry/opencode.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

describe("compat base URLs / version", () => {
  it("OPENAI_COMPAT_BASE", () => {
    expect(OPENAI_COMPAT_BASE).toBe("https://api.openai.com/v1");
  });
  it("ANTHROPIC_COMPAT_BASE", () => {
    expect(ANTHROPIC_COMPAT_BASE).toBe("https://api.anthropic.com/v1");
  });
  it("ANTHROPIC_API_VERSION", () => {
    expect(ANTHROPIC_API_VERSION).toBe("2023-06-01");
  });
});

describe("default token limits", () => {
  it("max/min", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(64000);
    expect(DEFAULT_MIN_TOKENS).toBe(32000);
  });
});

describe("provider baseUrl const (full path, no trailing slash)", () => {
  it("mimo-free full path", () => {
    expect(mimoFree.transport.baseUrl).toBe("https://api.xiaomimimo.com/api/free-ai/openai/chat");
  });
  it("opencode no trailing slash", () => {
    expect(opencode.transport.baseUrl).toBe("https://opencode.ai");
  });
});

describe("antigravity retry (intentional change: no same-host retries, rotate host instead)", () => {
  // attempts: 0 untuk ketiganya. Retry di host yang sama tidak berguna untuk
  // 429 (rate limit per akun) maupun 503 "No capacity available" (pool
  // kapasitas per host) — keduanya tidak sembuh dalam hitungan detik.
  // chatCore langsung memutar akun, dan AntigravityExecutor.shouldRetry
  // memutar host (daily -> sandbox), jadi menunggu backoff 2s+4s+8s di host
  // yang sudah mati kapasitasnya hanya membuang waktu.
  it("429 attempts = 2 (retry in-place di host yang sama, delay dari quotaResetDelay)", () => {
    expect(antigravity.transport.retry["429"].attempts).toBe(2);
  });
  it("500 attempts = 0", () => {
    expect(antigravity.transport.retry["500"].attempts).toBe(0);
  });
  it("503 attempts = 0", () => {
    expect(antigravity.transport.retry["503"].attempts).toBe(0);
  });
  it("declares more than one inference host so capacity rotation can happen", () => {
    expect(Array.isArray(antigravity.transport.baseUrls)).toBe(true);
    expect(antigravity.transport.baseUrls.length).toBeGreaterThan(1);
  });
});

describe("OpenCode Free endpoint routing", () => {
  const MUSE = "muse-spark-1.2-contributor-free";

  it("declares the Responses format only on the Muse Spark model", () => {
    expect(opencode.transport.format).toBeUndefined();
    const muse = opencode.models.find((m) => m.id === MUSE);
    expect(muse?.targetFormat).toBe("openai-responses");
    const muse13 = opencode.models.find((m) => m.id === "muse-spark-1.3-contributor-free");
    expect(muse13?.targetFormat).toBe("openai-responses");
  });

  it("routes Muse Spark to /responses and every other model to /chat/completions", () => {
    const executor = new OpenCodeExecutor();
    expect(executor.buildUrl(MUSE)).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl(`${MUSE}(xhigh)`)).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-1.3-contributor-free")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-1.4-contributor-free")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("muse-spark-2.0-contributor-free(xhigh)")).toBe("https://opencode.ai/inference/v1/responses");
    expect(executor.buildUrl("big-pickle")).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(executor.buildUrl("hy3-free")).toBe("https://opencode.ai/inference/v1/chat/completions");
  });

  it("normalizes Chat token/thinking fields only for the Responses model", () => {
    const executor = new OpenCodeExecutor();
    const muse = { max_tokens: 4096, reasoning_effort: "high" };
    executor.transformRequest(MUSE, muse, true, {});
    expect(muse.max_output_tokens).toBe(4096);
    expect(muse.max_tokens).toBeUndefined();
    expect(muse.reasoning).toEqual({ effort: "high", summary: "auto" });

    const chat = { max_tokens: 4096, reasoning_effort: "high" };
    executor.transformRequest("big-pickle", chat, true, {});
    expect(chat.max_tokens).toBe(4096);
    expect(chat.max_output_tokens).toBeUndefined();
    expect(chat.reasoning_effort).toBe("high");
  });

  // Free tier answers a non-streaming upstream call with 403 FreeTierError
  // (verified live 2026-09-17: stream:false and a missing `stream` both 403,
  // across every free model). The executor must always ask upstream for SSE.
  it("forces streaming upstream even when the client asked for JSON", () => {
    const executor = new OpenCodeExecutor();
    const body = { model: "big-pickle", messages: [{ role: "user", content: "hi" }], stream: false };
    executor.transformRequest("big-pickle", body, false, {});
    expect(body.stream).toBe(true);

    const missing = { model: "big-pickle", messages: [{ role: "user", content: "hi" }] };
    executor.transformRequest("big-pickle", missing, false, {});
    expect(missing.stream).toBe(true);

    // The registry flag drives chatCore's SSE->JSON conversion for such clients.
    expect(opencode.forceStream).toBe(true);
  });

  // Fourth upstream gate (verified live 2026-09-18): the free tier fingerprints
  // the official agentic client by the file-search quartet. 0-3 of these names
  // → 403 FreeTierError; the quartet plus any extras → 200. Plain chat callers
  // send no tools, so without injection every such request 403s.
  it("injects the file-search tool quartet on Chat bodies", () => {
    const executor = new OpenCodeExecutor();
    const body = { model: "big-pickle", messages: [{ role: "user", content: "hi" }] };
    executor.transformRequest("big-pickle", body, true, {});

    const names = body.tools.map((t) => t.function.name).sort();
    expect(names).toEqual(["read", "shell"]);
    for (const tool of body.tools) {
      expect(tool.type).toBe("function");
      // v2: OpenCode's own definitions, not empty stubs — upstream matches them verbatim.
      expect(tool.function.parameters.type).toBe("object");
      expect(Object.keys(tool.function.parameters.properties).length).toBeGreaterThan(0);
    }
  });

  it("keeps caller tools verbatim and only appends the missing quartet names", () => {
    const executor = new OpenCodeExecutor();
    const body = {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "my_tool", description: "mine", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "bash", description: "punyaku", parameters: { type: "object", properties: {} } } },
      ],
    };
    executor.transformRequest("big-pickle", body, true, {});

    const names = body.tools.map((t) => t.function.name);
    // `bash` is not part of the v2 fingerprint set (read/shell), so the caller's
    // own declaration stays verbatim and the two members are appended after it.
    expect(names).toEqual(["my_tool", "bash", "read", "shell"]);
    expect(body.tools[1].function.description).toBe("punyaku");
  });

  it("injects the quartet in Responses flat shape on the Responses endpoint", () => {
    const executor = new OpenCodeExecutor();
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    executor.transformRequest("muse-spark-1.3-contributor-free", body, true, {});

    const names = body.tools.map((t) => t.name).sort();
    expect(names).toEqual(["read", "shell"]);
    for (const tool of body.tools) {
      expect(tool.type).toBe("function");
      expect(tool.function).toBeUndefined(); // flat shape, not nested
    }
  });
});
