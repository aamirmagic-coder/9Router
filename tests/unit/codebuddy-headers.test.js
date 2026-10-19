import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_REGEX = /^[0-9a-f]{32}$/i;

describe.each([
  { name: "CodeBuddyExecutor", Executor: CodeBuddyExecutor },
  { name: "CodeBuddyIntlExecutor", Executor: CodeBuddyIntlExecutor },
])("$name buildHeaders", ({ Executor }) => {
  it("returns required CLI headers and generated conversation identifiers", () => {
    const executor = new Executor();
    const headers = executor.buildHeaders({ apiKey: "test-token" });

    expect(headers["User-Agent"]).toBe("CLI/2.108.1 CodeBuddy/2.108.1");
    expect(headers["X-Product"]).toBe("SaaS");
    expect(headers["X-IDE-Type"]).toBe("CLI");
    expect(headers["X-Domain"]).toBe("copilot.tencent.com");
    expect(headers["x-codebuddy-request"]).toBe("1");

    expect(headers["X-Conversation-ID"]).toMatch(UUID_REGEX);
    expect(headers["X-Conversation-Request-ID"]).toMatch(HEX32_REGEX);
    expect(headers["X-Conversation-Message-ID"]).toMatch(HEX32_REGEX);
  });

  it("preserves X-Conversation-ID when credentials.rawHeaders has x-conversation-id", () => {
    const executor = new Executor();
    const customConvId = "custom-conversation-id-1234";
    const headers = executor.buildHeaders({
      apiKey: "test-token",
      rawHeaders: {
        "x-conversation-id": customConvId,
      },
    });

    expect(headers["X-Conversation-ID"]).toBe(customConvId);
    expect(headers["X-Conversation-Request-ID"]).toMatch(HEX32_REGEX);
    expect(headers["X-Conversation-Message-ID"]).toMatch(HEX32_REGEX);
  });
});
