export function parseBearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function readJsonBody(request, maxBytes) {
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("request body too large");
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

export function validateChatRequest(body, modelAliases) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
  if (body.tools !== undefined || body.tool_choice !== undefined) throw new Error("tools are not supported");
  if (body.response_format !== undefined || body.modalities !== undefined || body.audio !== undefined) throw new Error("multimodal and response-format options are not supported");
  if (typeof body.model !== "string" || !modelAliases[body.model]) throw new Error("unknown model alias");
  if (!Array.isArray(body.messages) || body.messages.length !== 1) throw new Error("exactly one user message is supported");
  const [message] = body.messages;
  if (message?.role !== "user") throw new Error("only one user message is supported");
  if (typeof message.content !== "string" || !message.content.trim()) throw new Error("message content must be plain text");
  return { model: modelAliases[body.model], prompt: message.content };
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(status, message, headers = {}) {
  return jsonResponse({ error: { message, type: "cgw_codex_shim_error" } }, status, headers);
}
