import { describe, it, expect } from "vitest";
import { injectPonytail, resolvePonytailPrompt } from "../../open-sse/rtk/ponytail.js";
import { PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { ROLE } from "../../open-sse/translator/schema/roles.js";

const SEP = "\n\n";

describe("resolvePonytailPrompt", () => {
  it("returns the built-in prompt for the level when override is missing", () => {
    expect(resolvePonytailPrompt("full", undefined)).toBe(PONYTAIL_PROMPTS.full);
    expect(resolvePonytailPrompt("ultra", "")).toBe(PONYTAIL_PROMPTS.ultra);
  });

  it("treats a whitespace-only override as empty", () => {
    expect(resolvePonytailPrompt("lite", "   \n\t ")).toBe(PONYTAIL_PROMPTS.lite);
  });

  it("prefers a non-empty override over the built-in text", () => {
    expect(resolvePonytailPrompt("full", "MY OWN DOCTRINE")).toBe("MY OWN DOCTRINE");
  });

  it("returns undefined for an unknown level without override", () => {
    expect(resolvePonytailPrompt("nope", "")).toBeUndefined();
  });

  it("still honours an override for an unknown level", () => {
    expect(resolvePonytailPrompt("nope", "OVERRIDE")).toBe("OVERRIDE");
  });
});

describe("injectPonytail with a user override", () => {
  it("appends the override to an existing system message", () => {
    const body = {
      messages: [
        { role: ROLE.SYSTEM, content: "hello" },
        { role: ROLE.USER, content: "hi" },
      ],
    };
    injectPonytail(body, FORMATS.OPENAI, "full", "MY DOCTRINE");
    expect(body.messages[0].content).toBe(`hello${SEP}MY DOCTRINE`);
  });

  it("creates a system message when none exists", () => {
    const body = { messages: [{ role: ROLE.USER, content: "hi" }] };
    injectPonytail(body, FORMATS.OPENAI, "full", "MY DOCTRINE");
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "MY DOCTRINE" });
  });

  it("falls back to the built-in text when the override is blank", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hello" }] };
    injectPonytail(body, FORMATS.OPENAI, "full", "   ");
    expect(body.messages[0].content).toBe(`hello${SEP}${PONYTAIL_PROMPTS.full}`);
  });

  it("does not inject anything for an unknown level with no override", () => {
    const body = { messages: [{ role: ROLE.USER, content: "hi" }] };
    injectPonytail(body, FORMATS.OPENAI, "unknown-level", "");
    expect(body.messages).toEqual([{ role: ROLE.USER, content: "hi" }]);
  });

  it("is idempotent for the same override", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hello" }] };
    injectPonytail(body, FORMATS.OPENAI, "full", "MY DOCTRINE");
    injectPonytail(body, FORMATS.OPENAI, "full", "MY DOCTRINE");
    expect(body.messages[0].content).toBe(`hello${SEP}MY DOCTRINE`);
  });
});
