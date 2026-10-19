// Chat-template control markers inside message text.
//
// A provider that renders messages into a prompt of its own treats `<|...|>` as
// structure, not text. CommandCode's gateway fails the whole turn — 400 "The
// request could not be rendered into a prompt for this model" — when *assistant*
// text contains a reasoning-channel switch such as `<|channel|>analysis<|message|>`;
// one quoted tool result carrying those markers poisons every later turn of that
// conversation, because the client replays its transcript verbatim. The same text
// in a user message is accepted, and a lone `<|start|>` is accepted, so the escape
// is applied to assistant text only: the smallest change that keeps the renderer
// out of its own channel state, with the marker still readable as text.
import { ROLE } from "../translator/schema/index.js";

const TOKEN_CHECK_RE = /<\|[^|<>]{1,64}\|>/;
const TOKEN_RE = /<\|([^|<>]{1,64})\|>/g;

/** The text with every control marker broken for a renderer: `<|start|>` -> `< |start| >`. */
export function escapeTemplateTokens(text) {
  if (typeof text !== "string" || !text.includes("<|") || !TOKEN_CHECK_RE.test(text)) return text;
  return text.replace(TOKEN_RE, "< |$1| >");
}

function escapeContent(content) {
  if (typeof content === "string") return escapeTemplateTokens(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const parts = content.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    const text = escapeTemplateTokens(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? parts : content;
}

/**
 * Escape control markers in the assistant text of `body`.
 * @returns the body itself when nothing matched, a copy with new messages otherwise
 */
export function escapeTemplateTokensInAssistantMessages(body) {
  if (!Array.isArray(body?.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (message?.role !== ROLE.ASSISTANT) return message;
    const content = escapeContent(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...body, messages } : body;
}
