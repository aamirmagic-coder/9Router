// Google rejects a request whose last content is a model turn:
//   ../../open-sse/executors/antigravity.js
//   "Requests ending with a model turn are not supported." (400 INVALID_ARGUMENT)
// A client ends on an assistant message whenever its previous response was
// interrupted (Esc / stop), so the executor appends a user nudge.
// Verified live: identical payloads differing only in this tail — model-last
// 400s, user-last returns 200.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { translateRequest, initTranslators } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

try { initTranslators?.(); } catch {}

const TOOLS = [{
  type: "function",
  function: { name: "Bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
}];

function wire(msgs) {
  const body = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-tiered(high)",
    { model: "m", stream: true, messages: msgs, tools: TOOLS }, true,
    { provider: "antigravity", model: "m" });
  const ex = new AntigravityExecutor();
  return ex.transformRequest("gemini-3.8-flash-tiered", body, true,
    { accessToken: "x", projectId: "p", email: "e" }).request.contents;
}

const convo = (tail) => {
  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: "user", content: `u${i}` });
    msgs.push({ role: "assistant", content: `a${i}` });
  }
  return [...msgs, ...tail];
};

describe("AntigravityExecutor — trailing model turn", () => {
  it("appends a user nudge when the conversation ends with a model turn", () => {
    const c = wire(convo([]));                  // ends with assistant
    expect(c.at(-1).role).toBe("user");
    expect(c.at(-1).parts).toEqual([{ text: "Continue." }]);
  });

  it("appends the nudge for a tool-call turn too (interrupted mid-tool)", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }] },
    ];
    const c = wire(msgs);
    expect(c.at(-1).role).toBe("user");
  });

  it("leaves a conversation that already ends with a user turn untouched", () => {
    const c = wire(convo([{ role: "user", content: "final" }]));
    expect(c.at(-1).role).toBe("user");
    expect(c.at(-1).parts).toEqual([{ text: "final" }]);
    // no sentinel injected
    expect(c.some(x => x.parts?.some(p => p.text === "Continue."))).toBe(false);
  });

  it("leaves a conversation ending with a tool result untouched", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const c = wire(msgs);
    expect(c.at(-1).role).toBe("user");
    expect(c.some(x => x.parts?.some(p => p.text === "Continue."))).toBe(false);
  });

  it("never emits a trailing model turn for any tail shape", () => {
    const tails = [
      [],
      [{ role: "user", content: "x" }],
      [{ role: "assistant", content: "x" }],
      [{ role: "tool", tool_call_id: "c1", content: "ok" }],
    ];
    for (const tail of tails) {
      const msgs = [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
        ...tail,
      ];
      const c = wire(msgs);
      expect(c.at(-1).role, `tail=${JSON.stringify(tail)}`).toBe("user");
    }
  });
});
