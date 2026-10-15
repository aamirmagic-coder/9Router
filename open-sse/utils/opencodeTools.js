/**
 * OpenCode free-tier request fingerprint (verified live 2026-10-14).
 *
 * Live probing of https://opencode.ai/inference/openai/v1/chat/completions
 * shows that requests without this fingerprint are answered with:
 *
 *   403 FreeTierError: "OpenCode's free tier can only be used from within
 *   OpenCode. Download it at https://opencode.ai and keep building."
 *
 * The gate requires three things in addition to a valid session:
 *
 *   1. `User-Agent` must match a real OpenCode client (bun runtime present).
 *   2. `x-opencode-client: cli` — the old `desktop` value now 403s.
 *   3. The full OpenCode tool declarations (11 tools, ~23KB) must be present
 *      in the request body. A 4-tool subset is rejected.
 *
 * We ship the canonical tool declarations extracted from an actual `opencode
 * run` request so every request looks identical to upstream.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TOOLS_FILE = join(__dirname, "opencode-official-tools.json");
export const OPENCODE_USER_AGENT =
  "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
export const OPENCODE_CLIENT = "cli";

const OFFICIAL_TOOLS = JSON.parse(readFileSync(TOOLS_FILE, "utf8"));

/** Mirror of ./opencode.js generateRequestId — inlined here to avoid a circular import. */
function generateRequestId() {
  const cur = BigInt(Date.now()) * 0x1000n + 1n;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((cur >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")
  ).join("");
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.randomBytes(14);
  let random = "";
  for (let i = 0; i < 14; i++) random += chars[bytes[i] % 62];
  return `msg_${time}${random}`;
}

/** Inject the canonical tool declarations (free-tier gate). */
export function injectOpencodeTools(body) {
  if (!body || typeof body !== "object") return;
  body.tools = OFFICIAL_TOOLS;
  body.stream = true;
  delete body.tool_choice;
}

/** Build headers that match a real OpenCode CLI request. */
export function buildOpencodeHeaders(credentials) {
  const raw = credentials?.rawHeaders || {};
  const lower = {};
  for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

  const session = credentials?._opencodeSession || "";
  const requestId = credentials?._opencodeRequest || generateRequestId();

  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer public",
    "User-Agent": OPENCODE_USER_AGENT,
    "x-opencode-client": OPENCODE_CLIENT,
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-opencode-request": requestId,
    "x-opencode-project": lower["x-opencode-project"] || "global",
    Accept: "text/event-stream",
  };
}