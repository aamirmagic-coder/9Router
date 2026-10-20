import { describe, it, expect, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { NON_REPLAYABLE } from "../../open-sse/config/replayPolicy.js";
import { DISPATCH_COMPLETED } from "../../open-sse/utils/dispatchState.js";

const { executeMock, refreshMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: false, execute: executeMock, refreshCredentials: refreshMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const log = { info: vi.fn(), warn: vi.fn() };

describe("non-replayable outer routing", () => {
  it("does not rotate to the next combo member after dispatch", async () => {
    const handleSingleModel = vi.fn(async () => {
      const response = new Response(JSON.stringify({ error: { message: "ambiguous" } }), { status: 502 });
      response.replayPolicy = NON_REPLAYABLE;
      response.dispatchState = DISPATCH_COMPLETED;
      return response;
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["p/one", "p/two"],
      handleSingleModel,
      log,
      comboStrategy: "fallback"
    });

    expect(result.status).toBe(502);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("does not re-execute after a non-replayable auth response", async () => {
    executeMock.mockImplementation(async ({ dispatchContext }) => {
      dispatchContext.state = DISPATCH_COMPLETED;
      return {
        response: new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 }),
        url: "http://relay/v1/chat/completions",
        headers: {},
        transformedBody: null,
      };
    });

    const result = await handleChatCore({
      body: { model: "relay-model", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai-compatible-replay-test", model: "relay-model" },
      credentials: { apiKey: "k", providerSpecificData: { replayPolicy: NON_REPLAYABLE } },
      log,
      connectionId: "conn",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: false,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.dispatchState).toBe(DISPATCH_COMPLETED);
    expect(result.replayPolicy).toBe(NON_REPLAYABLE);
    expect(result.response.status).toBe(401);
  });
});
