/**
 * muse-ai — the personal agent at muse.ai, reached through the local bridge.
 *
 * NOT the same thing as the `muse` provider next door. That one is Meta's
 * Model API (the Muse Spark models, billed per token). This one is the
 * muse.ai personal agent — the one with a feed, goals, ideas and a chat
 * thread you keep coming back to.
 *
 * Why a sidecar instead of a direct call
 * --------------------------------------
 * The muse.ai edge only answers a browser-like TLS ClientHello. The
 * handshake itself (Noise XX / protobuf over a WebSocket) was ported to
 * Node and verified byte-for-byte against the reference, and the gateway
 * still closed the connection; swapping to a Chrome TLS fingerprint made
 * the identical handshake succeed. Node cannot present that fingerprint
 * without a native addon, so `muse-bridge/` (Python + curl_cffi) owns the
 * transport and speaks plain OpenAI on localhost. See muse-bridge/README.md.
 *
 * No tool calling
 * ---------------
 * The agent has no native function calling and no known prompt emulation
 * that works reliably. Capabilities are pinned to `tools: false` in
 * providers/capabilities.js so 9router does not advertise what this backend
 * cannot do. Chat works; agentic coding does not. Use `meta-code` (Muse
 * Code) for that.
 *
 * Setup
 * -----
 *   1. cd muse-bridge && pip install -r requirements.txt
 *   2. put muse.ai cookies in muse-bridge/cookies.txt (see its README)
 *   3. python server.py
 *   4. add a connection here — the API key must match muse-bridge's api_key
 *      (default "sk-muse-local"; the value is only meaningful to localhost).
 */
export default {
  id: "muse-ai",
  priority: 40,
  hasFree: true,
  alias: "muse-ai",
  uiAlias: "muse-ai",
  display: {
    name: "Muse (Personal Agent)",
    icon: "auto_awesome",
    color: "#7C3AED",
    textIcon: "MU",
    website: "https://muse.ai",
    notice: {
      signupUrl: "https://muse.ai",
      text:
        "The muse.ai personal agent (feed, goals, ideas, chat) — distinct from the " +
        "Meta `muse` Model API provider. Runs through a local bridge on 127.0.0.1:18611. " +
        "Chat only: the agent has no function calling, so it cannot drive tools " +
        "or edit files. The free tier resets weekly. Start the bridge before using " +
        "this provider; see muse-bridge/README.md.",
    },
  },
  category: "free",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    // Local sidecar. Not reachable from anywhere but this machine — the
    // bridge binds 127.0.0.1 and its key is a formality, not a secret.
    baseUrl: "http://127.0.0.1:18611/v1/chat/completions",
    format: "openai",
    forceStream: true,
  },
  serviceKinds: ["llm"],
  // Mirrors MODEL_ALIASES in muse-bridge/server.py. All of these route to the
  // same single agent; the names exist because clients insist on picking one.
  models: [
    { id: "muse-chat", name: "Muse Chat" },
    { id: "gpt-4o", name: "Muse (gpt-4o alias)" },
    { id: "gpt-5", name: "Muse (gpt-5 alias)" },
    { id: "claude-sonnet-4", name: "Muse (sonnet alias)" },
    { id: "muse-video", name: "Muse Video" },
  ],
};
