// Control markers inside assistant text.
//
// Break caught: CommandCode answers 400 "The request could not be rendered into a
// prompt for this model" when assistant content contains a reasoning-channel switch
// (`<|channel|>analysis<|message|>`) — a quoted tool result carrying those markers
// poisoned every later turn of a conversation, because a client replays its
// transcript verbatim. The escape is assistant-only: the same text in a user message
// and a lone `<|start|>` are both accepted by that gateway.
import { describe, expect, it } from "vitest";
import {
  escapeTemplateTokens,
  escapeTemplateTokensInAssistantMessages,
} from "../../open-sse/utils/chatTemplateTokens.js";
import { CommandCodeExecutor } from "../../open-sse/executors/commandcode.js";

const INCIDENT = "Tool result:\n<|constrain|><|start|>assistant<|channel|>analysis<|message|>";
const body = (messages) => ({ model: "reflection/beam:free", messages });

describe("escapeTemplateTokens", () => {
  it("breaks each marker so a renderer can no longer read it as structure", () => {
    expect(escapeTemplateTokens("<|start|>assistant<|channel|>analysis<|message|>"))
      .toBe("< |start| >assistant< |channel| >analysis< |message| >");
    expect(escapeTemplateTokens("<|im_start|>system")).toBe("< |im_start| >system");
  });

  it("leaves text without markers untouched, and is idempotent", () => {
    const plain = "no markers here, just <angle> brackets";
    expect(escapeTemplateTokens(plain)).toBe(plain);

    const escaped = escapeTemplateTokens(INCIDENT);
    expect(escapeTemplateTokens(escaped)).toBe(escaped);
  });
});

describe("escapeTemplateTokensInAssistantMessages", () => {
  it("escapes the assistant text of the reported incident", () => {
    const out = escapeTemplateTokensInAssistantMessages(body([
      { role: "system", content: INCIDENT },
      { role: "user", content: INCIDENT },
      { role: "assistant", content: INCIDENT },
      { role: "tool", tool_call_id: "c1", content: INCIDENT },
    ]));

    expect(out.messages[2].content).toBe(
      "Tool result:\n< |constrain| >< |start| >assistant< |channel| >analysis< |message| >");
    // Only assistant text is rewritten: the gateway accepts the markers anywhere else.
    expect(out.messages[0].content).toBe(INCIDENT);
    expect(out.messages[1].content).toBe(INCIDENT);
    expect(out.messages[3].content).toBe(INCIDENT);
  });

  it("escapes text parts and leaves other parts alone", () => {
    const image = { type: "image_url", image_url: { url: "https://x/y.png" } };
    const out = escapeTemplateTokensInAssistantMessages(body([
      { role: "assistant", content: [{ type: "text", text: "<|start|>" }, image] },
    ]));

    expect(out.messages[0].content[0].text).toBe("< |start| >");
    expect(out.messages[0].content[1]).toBe(image);
  });

  it("returns the same body when there is nothing to escape", () => {
    const clean = body([
      { role: "assistant", content: "ordinary answer" },
      { role: "assistant", content: [{ type: "text", text: "ordinary part" }] },
    ]);
    expect(escapeTemplateTokensInAssistantMessages(clean)).toBe(clean);

    const noMessages = { model: "x" };
    expect(escapeTemplateTokensInAssistantMessages(noMessages)).toBe(noMessages);
    expect(escapeTemplateTokensInAssistantMessages(null)).toBe(null);
  });

  it("CommandCodeExecutor.transformRequest applies it", () => {
    const executor = new CommandCodeExecutor();
    const out = executor.transformRequest("reflection/beam:free", body([
      { role: "user", content: INCIDENT },
      { role: "assistant", content: INCIDENT },
    ]), true, {});

    expect(out.messages[1].content).toContain("Tool result:\n< |constrain| >");
    expect(out.messages[0].content).toBe(INCIDENT);
  });
});
