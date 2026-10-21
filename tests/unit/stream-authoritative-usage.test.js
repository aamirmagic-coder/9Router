import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const encoder = new TextEncoder();

async function run(options, chunks) {
  let completedUsage;
  const stream = createSSEStream({
    ...options,
    body: { model: "m", messages: [{ role: "user", content: "x".repeat(40000) }] },
    onStreamComplete: (_content, usage) => { completedUsage = usage; },
  });
  const writer = stream.writable.getWriter();
  const reading = (async () => {
    const parts = [];
    for await (const part of stream.readable) parts.push(part);
    return Buffer.concat(parts).toString("utf8");
  })();
  for (const chunk of chunks) await writer.write(encoder.encode(chunk));
  await writer.close();
  return { text: await reading, usage: completedUsage };
}

const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const frames = (text) => [...text.matchAll(/data: (\{[^\n]+\})/g)].map((match) => JSON.parse(match[1]));
const contentAndFinish = [
  data({ choices: [{ delta: { content: "ok" }, finish_reason: null }] }),
  data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
];

function expectOpenAITerminal(text) {
  expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  const beforeDone = frames(text.slice(0, text.indexOf("data: [DONE]")));
  expect(beforeDone.at(-1).usage).toBeDefined();
  return beforeDone.at(-1).usage;
}

describe("authoritative trailing stream usage", () => {
  it("passthrough accounting replaces a finish estimate with trailing provider usage", async () => {
    const result = await run({ mode: "passthrough", provider: "test" }, [
      data({ choices: [{ delta: { content: "ok" }, finish_reason: null }] }),
      data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      data({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } }),
      "data: [DONE]\n\n",
    ]);
    expect(result.usage).toMatchObject({ prompt_tokens: 8, completion_tokens: 6 });
    const usages = [...result.text.matchAll(/data: (\{[^\n]+\})/g)]
      .map((match) => JSON.parse(match[1]).usage)
      .filter(Boolean);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ prompt_tokens: 8, completion_tokens: 6 });
  });

  it("translated accounting replaces a finish estimate with trailing OpenAI usage", async () => {
    const result = await run({ mode: "translate", targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI }, [
      data({ choices: [{ delta: { content: "ok" }, finish_reason: null }] }),
      data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      data({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 } }),
      "data: [DONE]\n\n",
    ]);
    expect(result.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 7 });
    const usages = [...result.text.matchAll(/data: (\{[^\n]+\})/g)]
      .map((match) => JSON.parse(match[1]).usage)
      .filter(Boolean);
    expect(usages).toHaveLength(1);
    expect(expectOpenAITerminal(result.text)).toMatchObject({ prompt_tokens: 9, completion_tokens: 7 });
  });

  it("keeps estimated usage only when upstream sends no usage", async () => {
    const result = await run({ mode: "passthrough", provider: "test" }, [
      data({ choices: [{ delta: { content: "ok" }, finish_reason: null }] }),
      data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    expect(result.usage.prompt_tokens).toBeGreaterThan(8);
  });

  it.each(["data: [DONE]\n\n", "data: [DONE]", "", "data: [DONE]\n\ndata: [DONE]\n\n"])("passthrough fallback precedes exactly one sentinel (%j)", async (end) => {
    const result = await run({ mode: "passthrough", provider: "test" }, [...contentAndFinish, end]);
    expect(expectOpenAITerminal(result.text)).toEqual(result.usage);
    expect(result.usage.estimated).toBe(true);
  });

  it.each(["data: [DONE]\n\n", "data: [DONE]", ""])("translated OpenAI fallback reaches the client before completion (%j)", async (end) => {
    const result = await run({ mode: "translate", targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI }, [...contentAndFinish, end]);
    expect(expectOpenAITerminal(result.text)).toEqual(result.usage);
    expect(result.usage.estimated).toBe(true);
  });

  it.each([true, false])("passthrough consumes an authoritative usage trailer with newline=%s", async (newline) => {
    const trailer = data({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } });
    const result = await run({ mode: "passthrough", provider: "test" }, [...contentAndFinish, newline ? trailer + "data: [DONE]\n\n" : trailer.trimEnd()]);
    expect(result.usage).toMatchObject({ prompt_tokens: 8, completion_tokens: 6 });
    expect(expectOpenAITerminal(result.text)).toMatchObject({ prompt_tokens: 8, completion_tokens: 6 });
    expect(frames(result.text).filter((frame) => frame.usage)).toHaveLength(1);
    expect(result.usage.estimated).toBeUndefined();
  });

  it.each([true, false])("translated Claude terminal usage waits for real usage=%s", async (real) => {
    const result = await run({ mode: "translate", targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.CLAUDE }, [
      ...contentAndFinish,
      ...(real ? [data({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 } })] : []),
      "data: [DONE]\n\ndata: [DONE]\n\n",
    ]);
    const parsed = frames(result.text);
    expect(parsed.filter((frame) => frame.type === "message_stop")).toHaveLength(1);
    expect(parsed.at(-1).type).toBe("message_stop");
    expect(parsed.at(-2).type).toBe("message_delta");
    expect(result.text).not.toContain("data: [DONE]");
    expect(parsed.at(-2).usage).toMatchObject(real ? { input_tokens: 9, output_tokens: 7 } : { estimated: true });
    expect(parsed.at(-2).usage.prompt_tokens).toBeUndefined();
    expect(result.usage).toMatchObject(real ? { prompt_tokens: 9, completion_tokens: 7 } : { estimated: true });
  });

  it.each(["passthrough", "translate"])("%s preserves real finish usage without adding an estimate or buffer", async (mode) => {
    const real = { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 };
    const result = await run({ mode, provider: "test", targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI }, [
      contentAndFinish[0], data({ choices: [{ delta: {}, finish_reason: "stop" }], usage: real }), "data: [DONE]\n\n",
    ]);
    expect(expectOpenAITerminal(result.text)).toEqual(real);
    expect(result.usage).toMatchObject({ prompt_tokens: 8, completion_tokens: 6 });
    expect(frames(result.text).filter((frame) => frame.usage)).toHaveLength(1);
  });

  it.each(["passthrough", FORMATS.OPENAI, FORMATS.CLAUDE, "responses-to-claude"])("completes %s at DONE while upstream remains open", async (format) => {
    const responsesToClaude = format === "responses-to-claude";
    const clientFormat = responsesToClaude ? FORMATS.CLAUDE : format;
    const stream = createSSEStream({
      mode: format === "passthrough" ? "passthrough" : "translate",
      targetFormat: responsesToClaude ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI,
      sourceFormat: format === "passthrough" ? FORMATS.OPENAI : clientFormat,
      body: { messages: [{ role: "user", content: "hello" }] },
    });
    const writer = stream.writable.getWriter();
    let resolveTerminal;
    const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
    let text = "";
    const reading = (async () => {
      for await (const part of stream.readable) {
        text += new TextDecoder().decode(part);
        if (text.includes(clientFormat === FORMATS.CLAUDE ? '"type":"message_stop"' : "data: [DONE]")) resolveTerminal(text);
      }
    })();
    let timer;
    try {
      const chunks = responsesToClaude ? [
        data({ type: "response.created", response: { id: "resp_test", model: "m" } }),
        data({ type: "response.output_text.delta", output_index: 0, delta: "ok" }),
      ] : contentAndFinish;
      for (const chunk of [...chunks, "data: [DONE]\n\n"]) await writer.write(encoder.encode(chunk));
      const immediate = await Promise.race([terminal, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 300); })]);
      expect(immediate).not.toBeNull();
      if (clientFormat === FORMATS.CLAUDE) expect(frames(immediate).at(-2).usage.estimated).toBe(true);
      else expect(expectOpenAITerminal(immediate).estimated).toBe(true);
    } finally {
      clearTimeout(timer);
      await writer.close();
      await reading;
    }
    if (clientFormat === FORMATS.CLAUDE) expect(frames(text).filter((frame) => frame.type === "message_stop")).toHaveLength(1);
    else expectOpenAITerminal(text);
    expect(frames(text).filter((frame) => frame.usage?.estimated)).toHaveLength(1);
  });

  it("captures Claude terminal events generated by a Responses null flush", async () => {
    const result = await run({ mode: "translate", targetFormat: FORMATS.OPENAI_RESPONSES, sourceFormat: FORMATS.CLAUDE }, [
      data({ type: "response.created", response: { id: "resp_test", model: "m" } }),
      data({ type: "response.output_text.delta", output_index: 0, delta: "ok" }),
    ]);
    const parsed = frames(result.text);
    expect(parsed.filter((frame) => frame.type === "message_stop")).toHaveLength(1);
    expect(parsed.at(-1).type).toBe("message_stop");
    expect(parsed.at(-2).type).toBe("message_delta");
    expect(parsed.at(-2).usage).toEqual(result.usage);
    expect(parsed.at(-2).usage.estimated).toBe(true);
  });

  it("preserves native Anthropic field-wise max and cache counts", async () => {
    const result = await run({ mode: "translate", targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.CLAUDE }, [
      data({ type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }),
      data({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }),
      data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 0, output_tokens: 5 } }),
      data({ type: "message_stop" }),
    ]);
    expect(result.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
    expect(frames(result.text).at(-2).usage).toMatchObject({ input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
    expect(frames(result.text).at(-1).type).toBe("message_stop");
  });

  it("preserves Anthropic split-event max merge semantics", async () => {
    const result = await run({ mode: "translate", targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI }, [
      data({ type: "message_start", message: { id: "msg_1", model: "claude", usage: { input_tokens: 11, output_tokens: 0 } } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
      data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      "data: [DONE]\n\n",
    ]);
    expect(result.usage).toMatchObject({ input_tokens: 11, output_tokens: 5 });
  });
});
