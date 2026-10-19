import { describe, expect, it } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Probed live against https://api.commandcode.ai/provider/v1/chat/completions on
// 2026-10-16, one request per catalog id:
//   {"error":{"message":"Model \"meta/muse-spark-1.3-contributor\" does not support
//    reasoning_effort \"off\". Only models that can turn thinking off accept it.","type":
//    "invalid_request_error","param":"reasoning_effort"}}
// The five ids that accept "off" are all deepseek/* (v4-pro, v4-flash,
// v4-flash-vision-exp, v4.1-flash, v4.1-flash-fast); the other 69 — every
// muse-spark, GLM, Kimi, MiniMax, Qwen, grok, gemini, stepfun and nvidia id —
// answer that 400. capabilities.js advertised thinkingCanDisable:true for all of
// them, so a client asking for no thinking wrote "off" and lost the whole turn.

const CANNOT_DISABLE = [
  "meta/muse-spark-1.3-contributor",
  "meta/muse-spark-1.3",
  "meta/muse-spark-1.2-contributor",
  "moonshotai/Kimi-K2.7-Code",
  "zai-org/GLM-5.2",
  "MiniMaxAI/MiniMax-M3",
  // Exact capability entry that only pins limits: the provider-wide rule still
  // has to reach it, or the entry re-enables "off" for a model that rejects it.
  "claude-haiku-5-5",
];

const CAN_DISABLE = ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"];

describe("CommandCode models that reject reasoning_effort off", () => {
  it.each(CANNOT_DISABLE)("%s is marked as unable to disable thinking", (id) => {
    expect(getCapabilitiesForModel("commandcode", id).thinkingCanDisable).toBe(false);
    expect(getCapabilitiesForModel("cmc", id).thinkingCanDisable).toBe(false);
  });

  it.each([
    ["reasoning_effort: none", { reasoning_effort: "none" }],
    ["reasoning_effort: off", { reasoning_effort: "off" }],
    ["thinking.type: disabled", { thinking: { type: "disabled" } }],
    ["enable_thinking: false", { enable_thinking: false }],
  ])("%s clamps to the lowest accepted level", (_label, seed) => {
    for (const id of CANNOT_DISABLE) {
      const body = structuredClone(seed);
      applyThinking("openai", id, body, "commandcode");
      // The value upstream 400s on, in the field it reads.
      expect(body.reasoning_effort, id).toBe("low");
    }
  });

  it("keeps the levels the model does accept", () => {
    const body = { reasoning_effort: "xhigh" };
    applyThinking("openai", "meta/muse-spark-1.3-contributor", body, "commandcode");
    expect(body.reasoning_effort).toBe("xhigh");

    // "minimal" is not in the upstream enum — the alias maps it onto "low".
    const minimal = { reasoning_effort: "minimal" };
    applyThinking("openai", "meta/muse-spark-1.3-contributor", minimal, "commandcode");
    expect(minimal.reasoning_effort).toBe("low");
  });

  it("still turns thinking off on the ids whose upstream accepts it", () => {
    for (const id of CAN_DISABLE) {
      expect(getCapabilitiesForModel("commandcode", id).thinkingCanDisable, id).toBe(true);
      const body = { reasoning_effort: "none" };
      applyThinking("openai", id, body, "commandcode");
      expect(body.reasoning_effort, id).toBe("off");
    }
  });
});
