# muse-bridge

A small local service that lets 9router talk to the **muse.ai personal agent**
(the one with a feed, goals and ideas — not the Meta Model API).

9router reaches it as the `muse-ai` provider. Nothing here listens on the
network: the server binds `127.0.0.1` only.

## Why this exists

The muse.ai edge only completes a TLS handshake that looks like a browser's.
The protocol on top (Noise XX over a WebSocket, protobuf envelopes) was ported
to Node and verified byte-for-byte against the reference implementation — and
the gateway still closed the connection every time, within ~220 ms of the
handshake finishing. The only change that made the identical handshake succeed
was presenting a Chrome TLS fingerprint.

Node cannot present one without a native addon, so the transport lives in
Python (where `curl_cffi` provides it) and speaks plain OpenAI over localhost.
That is the whole reason for the split — it is not a preference.

## Setup

```bash
cd muse-bridge
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
```

### Cookies

Export the muse.ai session cookies from a logged-in browser
(DevTools → Application → Cookies → `https://muse.ai`). At minimum you need
`hatch_sess`; `hatch_gw`, `hatch_native_auth_device`, `hatch_vml` and `datr`
travel together in practice.

Write them to `cookies.txt` in this directory, one line:

```
hatch_sess=VALUE; hatch_gw=VALUE; hatch_native_auth_device=VALUE; datr=VALUE
```

A Netscape cookie jar or `{"cookies": {...}}` JSON also work. The file is
gitignored — it grants full access to the account, so treat it like a password.

### Run

```bash
python server.py
```

Listens on `http://127.0.0.1:18611`. `config.json` (gitignored, see
`config.example.json`) can override the port, the API key, timeouts, and list
several accounts.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness + per-account state |
| `GET` | `/v1/models` | OpenAI model list |
| `POST` | `/v1/chat/completions` | Chat, streaming SSE and buffered |
| `GET`/`POST` | `/admin/accounts` | Inspect / add an account |

The API key is checked against `api_key` in the config (default
`sk-muse-local`). It only ever crosses loopback, so it is a formality rather
than a secret — but set something of your own if other users share the machine.

## What it can and cannot do

**Can**: multi-turn chat with the personal agent, streamed.

**Cannot**: tool calling. The agent has no native function calling, and no
prompt-side emulation is known to work reliably — the upstream reference
implementation tracks "emulated tool calling" as unstarted and warns the agent
may refuse a tool schema outright. `tools` is therefore pinned to `false` in
`open-sse/providers/capabilities.js`, and the bridge states the limitation in
the prompt when a client sends `tools` anyway. For agentic coding use
`meta-code` (Muse Code), which is built for it.

**Limits** in the model list (100k context / 8k output) are placeholders —
muse.ai publishes no figures. They exist so clients can size prompts sanely.

## How a turn works

Muse is a single conversational agent, not a message-array API, so the whole
`messages` array is flattened into one labelled transcript
(`User: … / Assistant: …`). Replaying it this way keeps the agent's own memory
of the thread intact instead of pretending each request is a fresh call.

Sending is `chat.stream`; the reply itself is read from `chat.history` on a
poll. That is deliberate: live subscription events use a different shape and
miss threaded replies entirely, while history is the source of truth and
carries the `reply_to_message_id` discriminator that separates a genuine answer
from proactive pushes (background task updates, Telegram drafts).

One turn runs at a time per account. The Noise transport is stateful —
interleaved reads corrupt it — so concurrency is serialized rather than
hoped for.

## Credit

Protocol knowledge (framing, service ids, the route table, the Noise profile)
comes from [nikships/muse-cli](https://github.com/nikships/muse-cli), MIT.
`routes.json` and `desc{0,1}.bin` in this directory are from that project.
