# CGW Codex Shim

This directory contains a loopback-only OpenAI-compatible adapter for the
installed CGW/9Router/Codex runtime. It translates one plain-text, single-turn
Chat Completions request into one bounded native `codex exec` invocation.

## Scope

- `GET /v1/models` exposes only aliases configured in
  `CGW_SHIM_MODEL_ALIASES_JSON`.
- `POST /v1/chat/completions` accepts exactly one non-empty `user` message.
- `stream: true` returns buffered compatibility SSE; it is not live token
  streaming.
- Tools, system messages, multi-turn context, images, audio, and response-format
  options are rejected before native dispatch.
- The service binds only to loopback and requires a dedicated bearer key.
- Native success requires both `turn.completed` and a final assistant message.
- Native failures after dispatch include `x-9router-no-replay: 1` as an advisory
  diagnostic for the parent 9Router replay policy.

## Configuration

The shim automatically loads `.env` from the repository root when any shim
entrypoint starts. Existing process environment variables remain authoritative.
Use `.env.example` as the template and keep the real `.env` uncommitted.

Start the long-running relay with:

```powershell
node tools/cgw-codex-shim/run.js
```

The equivalent variables are:

```dotenv
CGW_SHIM_HOST=127.0.0.1
CGW_SHIM_PORT=20129
CGW_SHIM_API_KEY=use-a-dedicated-local-key
CGW_SHIM_MODEL_ALIASES_JSON={"gpt-6.1-sol":"gpt-6.1-sol","gpt-5.6-sol":"gpt-5.6-sol"}
CGW_SHIM_CODEX_BIN=codex
CGW_SHIM_CODEX_BASE_URL=http://127.0.0.1:20128/v1
CGW_SHIM_CODEX_MODEL_PROVIDER=9router
CGW_SHIM_CODEX_WIRE_API=responses
CGW_SHIM_CODEX_SANDBOX=read-only
CGW_SHIM_CODEX_EPHEMERAL=true
```

Optional `CGW_SHIM_CODEX_HOME` selects the already authenticated native Codex
home for the process. The value is read at runtime and is never written to the
repository. Use the existing authenticated session only for an explicitly
approved local smoke test.

The default limits are bounded and can be overridden with
`CGW_SHIM_MAX_BODY_BYTES`, `CGW_SHIM_MAX_CONCURRENT`, `CGW_SHIM_MAX_QUEUE`,
`CGW_SHIM_TIMEOUT_MS`, `CGW_SHIM_MAX_OUTPUT_BYTES`, and
`CGW_SHIM_TERMINATION_GRACE_MS`.

## Checks

```powershell
node --test tools/cgw-codex-shim/test/*.test.js
node tools/cgw-codex-shim/smoke.js --help
```

For the live native smoke, set the environment above and run:

```powershell
node tools/cgw-codex-shim/smoke.js --model gpt-6.1-sol --prompt "Reply with CGW_SHIM_NATIVE_OK only."
```

The command prints only the selected alias and returned text. It does not print
the bearer key, native arguments, or inherited credential values.
