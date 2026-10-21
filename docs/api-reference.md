# 9Router API Reference

9Router exposes an **OpenAI-compatible** API surface at `/v1`, plus an
Anthropic-compatible `POST /v1/messages`, and a set of dashboard APIs under
`/api`.

## Base URL

```
http://localhost:20128/v1
```

The port defaults to `20128` and can be changed with the `PORT` env var.
All `/v1` endpoints accept CORS from any origin.

## Configuration (environment variables)

The authoritative list of environment variables is
[`.env.example`](../.env.example) (39 keys, each commented with its default
and effect): auth secrets (`INITIAL_PASSWORD`, `JWT_SECRET`,
`API_KEY_SECRET`), server settings (`PORT`, `HOSTNAME`, `DATA_DIR`,
`REQUIRE_API_KEY`), and provider/API-key credentials for the routing
backends. Copy it with `cp .env.example .env` and edit before first boot.
Federation-specific keys (`FEDERATION_MODE`, `FEDERATION_CENTRAL_URL`,
`FEDERATION_TOKEN`, `FEDERATION_EDGE_ID`, `FEDERATION_REDACT_FIELDS`) are
documented in [FEDERATION.md](FEDERATION.md). Test-harness-only variables
(`RUN_E`, `RUN_REAL`) live in [`tests/`](../tests) and never affect a
production deployment.

## Authentication

9Router has two independent auth surfaces, and neither is a blanket
"API key on every request" rule.

### Dashboard API (`/api/*`) — deny-by-default

A `/api/*` request is allowed when **any** of the following holds:

1. Its path is on the public allow-list: `/api/health`, `/api/version`,
   `/api/init`, `/api/locale`, `/api/auth/login`, `/api/auth/logout`,
   `/api/auth/status`, `/api/auth/oidc*`, `/api/auth/saml*` and
   `/api/settings/require-login`.
2. Its path is under `/api/federation/*` — the dashboard session is deliberately
   skipped there so the federation role guard can enforce `FEDERATION_TOKEN`
   (see [Federation docs](FEDERATION.md)).
3. It carries the `auth_token` JWT cookie issued by `POST /api/auth/login`, or
   dashboard login is switched off through the `requireLogin` setting.
4. It carries the on-host CLI token in the `x-9r-cli-token` header (derived from
   `MACHINE_ID_SALT`).

Every other `/api/*` route — including `GET/POST /api/keys`, `/api/settings`,
`/api/combos`, `/api/providers`, `/api/proxy-pools`, `/api/models`, `/api/usage`,
`/api/oauth`, `/api/cloud`, `/api/pricing`, `/api/tags`, `/api/cli-tools`,
`/api/mcp` and `/api/translator` — answers `401 {"error":"Unauthorized"}` without
one of the above.

Two stricter classes sit inside that set:

- `/api/shutdown`, `/api/settings/database`, `/api/version/update` and
  `/api/version/shutdown` always need a valid `auth_token` session or the CLI
  token — the `requireLogin: false` escape hatch does not apply to them, and the
  answer is `401` otherwise.
- The local-only routes (`/api/mcp/*`, `/api/cli-tools/cowork-settings`,
  `/api/cli-tools/antigravity-mitm`, the install/enable/disable/check endpoints
  under `/api/tunnel/`, `/api/headroom/start`, `/api/headroom/stop`,
  `/api/headroom/proxy`, `/api/oauth/cursor/auto-import`,
  `/api/oauth/kiro/auto-import`, `/api/oauth/zed/auto-import` and
  `/api/auth/reset-password`) need the CLI token
  or a loopback client that is authenticated, so a remote session gets `403` even
  when its cookie is valid.

Creating an API key therefore needs a session — the dashboard
(**Dashboard → Endpoint → API Keys**), or a two-step `curl`. This example runs as
written:

```bash
# 1. Log in — the auth_token JWT cookie is stored in cookies.txt
curl -s -c cookies.txt -X POST http://localhost:20128/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"<dashboard password>"}'
# → 200 {"success":true}

# 2. Create the key with that session
curl -s -b cookies.txt -X POST http://localhost:20128/api/keys \
  -H "Content-Type: application/json" \
  -d '{"name":"my-tool"}'
# → 201 {"key":"sk-...","name":"my-tool","id":"<uuid>","machineId":"..."}
```

Skip step 1 and the same create call answers `401 {"error":"Unauthorized"}` —
`/api/keys` belongs to the deny-by-default `/api/*` surface.

### LLM API (`/v1`, `/v1beta`, `/api/v1`, `/api/v1beta`, `/codex`, `/responses`)

These prefixes are public at the dashboard layer; their own check accepts a
request when **any** of the following holds:

1. **Trusted local client** — the request arrives from a loopback peer (and, when
   it carries an `Origin`, that origin is loopback too). The guard lets it through
   with no key; the endpoint handlers below add their own check.
   A request forwarded by a reverse proxy is never counted as local.
2. **Valid API key**, sent as any of:
   - `Authorization: Bearer sk-…`
   - `x-api-key: sk-…`
   - `x-goog-api-key: sk-…`
   - `?key=sk-...`

   These are keys **minted by this instance** — dashboard → Endpoint → API Keys,
   or login + `POST /api/keys` (recipe below). The `API_KEY_SECRET` environment
   variable is the server-side HMAC secret used to derive and validate those
   keys; it is **not** a client credential and must never be sent as a Bearer
   key. Sharing `API_KEY_SECRET` across federation instances keeps minted keys
   valid on every instance — it does not make the secret itself a client key.
3. **Remote keyless access, while the effective `requireApiKey` setting is
   `false`.** This is a deployment opt-out — and it is the state a fresh install
   boots in, because `.env.example` ships `REQUIRE_API_KEY=false` (see the
   `REQUIRE_API_KEY` row in the README for the unset semantics).

Otherwise a remote request with a missing or invalid key is rejected with
`401 {"error":{"message":"API key required for remote API access","type":"authentication_error","code":"invalid_api_key"}}`
— the dashboard guard answers before the request reaches the endpoint handler,
in the same OpenAI error envelope the handlers use (DF-9ROUTER-56).

### Endpoint handlers — the second check

Most LLM handlers (`/v1/chat/completions`, `/v1/messages`, `/v1/embeddings`, the
image, audio, search, fetch and video routes) then re-check the effective
`requireApiKey` themselves. When it is `true` they require a valid key from
**every** client — loopback included — and answer
`401 {"error":{"message":"Missing API key",…}}` or `"Invalid API key"`. When it is
`false` that check is skipped. A few read-only endpoints, `GET /v1/models` among
them, have no such check and therefore stay keyless on loopback even while
`requireApiKey` is `true`.

Verified against a running instance (loopback, no key sent):

| Effective `requireApiKey` | Client | `GET /v1/models` | `POST /v1/chat/completions` |
|---|---|---|---|
| `false` (shipped `.env.example`) | loopback | `200` | `200` (runs) |
| `false` | remote | `200` | `200` (runs) |
| `true` (runtime default) | loopback | `200` | `401` `Missing API key` |
| `true` | remote | `401` `authentication_error`/`invalid_api_key` | `401` `authentication_error`/`invalid_api_key` |

Both 401s share the OpenAI error envelope — `{"error":{"message":…,"type":"authentication_error","code":"invalid_api_key"}}`
— differing only in the message text.

So `GET /v1/models` works with or without a key on loopback, while a completion
call always needs one once `requireApiKey` is `true`:

```bash
curl http://localhost:20128/v1/models
curl http://localhost:20128/v1/models -H "Authorization: Bearer sk-..."
```

When a key **is** required, a missing or invalid one surfaces from the endpoint
handler as:

| Status | Meaning |
|---|---|
| `401` | Missing or invalid API key (`{"error":{"message":"Missing API key"/"Invalid API key","type":"authentication_error","code":"invalid_api_key"}}`) |

## Endpoints

### `POST /v1/chat/completions`

OpenAI-compatible chat completions. Request:

```json
{
  "model": "kr/claude-sonnet-4.5",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false
}
```

Non-streaming response:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "kr/claude-sonnet-4.5",
  "choices": [
    {"index": 0, "message": {"role": "assistant", "content": "Hi there!"}, "finish_reason": "stop"}
  ],
  "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}
}
```

With `"stream": true` the server returns SSE chunks
(`data: {"object":"chat.completion.chunk",...}` terminated by `data: [DONE]`).

**Model ids** use the form `<provider-alias>/<model>` (e.g. `kr/claude-sonnet-4.5`).
Requesting a model with no active provider credentials returns `404`/`503`
(see error table below). Requests with no `model` field return `400`.

### `POST /v1/messages`

Anthropic Messages API format (used by Claude Code via `ANTHROPIC_BASE_URL`):

```json
{
  "model": "kr/claude-sonnet-4.5",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hello!"}]
}
```

The request is translated into the same internal chat pipeline as
`/v1/chat/completions`.

### `GET /v1/models`

Lists available models:

```bash
curl http://localhost:20128/v1/models \
  -H "Authorization: Bearer sk-..."
```

Returns a JSON object with a `data` array of `{id, object: "model", ...}`
entries (OpenAI shape). Live catalogs are resolved per provider when possible.

### Other `/v1` endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/audio/speech` | Text-to-speech |
| `POST /v1/audio/transcriptions` | Speech-to-text |
| `GET /v1/audio/voices` | List TTS voices for a provider (`?provider=…`) |
| `POST /v1/embeddings` | Embeddings |
| `POST /v1/images/generations` | Image generation |
| `POST /v1/messages/count_tokens` | Count tokens for a Messages request |
| `GET /v1/models/info` | Detailed model catalog (kind, endpoint, capabilities) |
| `POST /v1/responses` | OpenAI Responses-format endpoint |
| `POST /v1/responses/compact` | Compact conversation context |
| `POST /v1/search` | Web search |
| `POST /v1/videos/generations` | Video generation |
| `POST /v1/videos/edits` | Async video edit (xAI Grok Imagine) |
| `POST /v1/videos/extensions` | Async video extension (xAI Grok Imagine) |
| `GET /v1/videos/{id}` | Poll async video job status |
| `POST /v1/web/fetch` | Web URL fetch/extract |

All are gated by the rules in [Authentication](#authentication).

## Errors

All endpoints return OpenAI-compatible error bodies:

```json
{
  "error": {
    "message": "Model not found",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

Two layers can answer before an endpoint does (see
[Authentication](#authentication)): the dashboard guard returns
`{"error":{"message":"API key required for remote API access","type":"authentication_error","code":"invalid_api_key"}}`
for a keyless remote LLM request while `requireApiKey` is `true`, and
`{"error":"Unauthorized"}` for an unauthenticated `/api/*` request (the
dashboard surface keeps its flat body; the OpenAI-style `/v1` surface uses the
envelope above).

| HTTP | type | code | Meaning |
|---|---|---|---|
| `400` | `invalid_request_error` | `bad_request` | Malformed request / missing model |
| `401` | `authentication_error` | `invalid_api_key` | Missing or invalid key |
| `402` | `billing_error` | `payment_required` | Quota/payment issue |
| `403` | `permission_error` | `insufficient_quota` | Quota exhausted |
| `404` | `invalid_request_error` | `model_not_found` | Unknown model — when the id is in no catalog the message reads `Model 'X' not found in catalog`; ids the catalog lists but that have no usable connection keep the `No active credentials for provider: X` wording (DF-9ROUTER-56) |
| `406` | `invalid_request_error` | `model_not_supported` | Model not supported by provider |
| `429` | `rate_limit_error` | `rate_limit_exceeded` | Provider rate limit (transient) |
| `5xx` | `server_error` | `internal_server_error` / `bad_gateway` / `service_unavailable` / `gateway_timeout` | Upstream or gateway failure |

Streaming requests surface errors as `data: {"error": {...}}` SSE events before
the stream closes.

## Rate limiting

9Router does not apply a global request-rate limiter on `/v1`. Provider-level
rate limits (e.g. Copilot/Codex subscriptions) are handled internally with
cooldowns and are reported to clients as `429`/`503`.

## Dashboard APIs (`/api`)

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health check |
| `POST /api/auth/login` | Dashboard login (JWT cookie) |
| `GET/POST /api/keys` | List / create API keys |
| `GET/POST /api/combos` | List / create combos (model routing rules) |
| `GET /api/settings` | Runtime settings |
| `GET /api/usage/stats` | Token/cost aggregates + recent requests for the Usage page |
| `GET /api/federation/status` | Federation mode status (edge/central) |

`GET /api/usage/stats` takes `?period=today`, `24h`, `7d` (default), `30d`, `60d`
or `all`, and only reports requests that completed: token counts come from the provider's
own usage metadata (Claude/Responses, OpenAI, Gemini, and native Ollama's
top-level `prompt_eval_count`/`eval_count`). When a provider reports no counts at
all and the response carried content, the tokens are estimated from the request
body and the response text and the stored row is marked `"estimated": true`; a
response with neither counts nor content is not recorded.

Dashboard routes (`/api/*`) are deny-by-default and need the `auth_token` session
cookie or the host CLI token — an API key does not authorize them. The LLM
prefixes are keyless for trusted local clients and require an API key from remote
clients only while the effective `requireApiKey` is `true` (`.env.example` ships
`REQUIRE_API_KEY=false`, so a fresh install serves them keyless). See
[Authentication](#authentication).

## See also

- [Integrations guide](integrations/README.md) — Claude Code, Cursor, and other tools.
- [Local MCP integrations](integrations/mcp.md) — HTTP SSE bridge for local stdio MCP servers.
- [Federation docs](FEDERATION.md) — edge/central deployment.
