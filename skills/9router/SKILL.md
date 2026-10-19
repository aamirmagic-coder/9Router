---
name: 9router
description: Entry point for 9Router — local/remote AI gateway with OpenAI-compatible REST for chat, image, TTS, embeddings, web search, web fetch. Use when the user mentions 9Router, NINEROUTER_URL, or wants AI without writing provider boilerplate. This skill covers setup + indexes capability skills; fetch the relevant capability SKILL.md from the URLs below when needed.
---

# 9Router

Local/remote AI gateway exposing OpenAI-compatible REST. One key, many providers, auto-fallback.

## Setup

```bash
export NINEROUTER_URL="http://localhost:20128"      # or VPS / tunnel URL
export NINEROUTER_KEY="sk-..."                      # from Dashboard → Keys (only if requireApiKey=true)
```

All requests: `${NINEROUTER_URL}/v1/...` with header `Authorization: Bearer ${NINEROUTER_KEY}` (omit if auth disabled).

Verify: `curl $NINEROUTER_URL/api/health` → `{"ok":true}`

## Discover models

```bash
curl $NINEROUTER_URL/v1/models                  # chat/LLM (default)
curl $NINEROUTER_URL/v1/models/image            # image-gen
curl $NINEROUTER_URL/v1/models/tts              # text-to-speech
curl $NINEROUTER_URL/v1/models/embedding        # embeddings
curl $NINEROUTER_URL/v1/models/web              # web search + fetch (entries have `kind` field)
curl $NINEROUTER_URL/v1/models/stt              # speech-to-text
curl $NINEROUTER_URL/v1/models/image-to-text    # vision
```

Use `data[].id` as `model` field in requests. Combos appear with `owned_by:"combo"`.

Response shape:
```json
{ "object": "list", "data": [
  { "id": "openai/gpt-5", "object": "model", "owned_by": "openai", "created": 1735000000 },
  { "id": "tavily/search", "object": "model", "kind": "webSearch", "owned_by": "tavily", "created": 1735000000 }
]}
```

## Capability skills

When the user needs a specific capability, fetch that skill's `SKILL.md` from its raw URL:

| Capability | Raw URL |
|---|---|
| Chat / code-gen | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-chat/SKILL.md |
| Image generation | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-image/SKILL.md |
| Text-to-speech | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-web-fetch/SKILL.md |

## Errors

- 401 → set/refresh `NINEROUTER_KEY` (Dashboard → Keys)
- 400 `Invalid model format` → check `model` exists in `/v1/models/<kind>`
- 503 `All accounts unavailable` → wait `retry-after` or add another provider account
- 400 `No credentials for provider: openai` after a ~95s hang → the model id does not exist
  on that upstream (NOT a credential problem). Copy the id verbatim from `/v1/models`.
  Known gap (DF-9ROUTER-40): fail-fast + model-scoped message not yet implemented.

## Wiring an OpenAI-compatible upstream (what works, 2026-09-24)

Two objects are required, in order — connection follows node:

1. Providers → **Add OpenAI Compatible** → Name, Prefix, Base URL (e.g.
   `http://host:1234/v1`), optional model hint list.
2. Open the node card → **Add API Key** → Name + key + Default Model → Save → state `active`.
3. On the node card → **Import from /models** → one id per upstream model, prefixed
   `<Prefix>/<model>` (96 imported in seconds from a 96-model upstream).

Restart the server after adding a provider connection — running config is loaded at boot.

Client key: Dashboard → **Endpoint & Key** → the default key exists already (reveal/copy).
A completion and an embeddings call through the wired node, via the OpenAI SDK:

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:20127/v1", api_key=KEY)
c.chat.completions.create(model="dlm/qwen3.8-27b", max_tokens=300,
                          messages=[{"role": "user", "content": "ping"}])
c.embeddings.create(model="dlm/text-embedding-nomic-embed-text-v1.5",
                    input=["hello world"])   # 768-dim, sanity-verified pass-through
```

Gotchas (measured 2026-09-24, DF-9ROUTER-38..41):

- **'Require API key' can silently no-op**: if the instance was started with `.env` copied
  from `.env.example`, `REQUIRE_API_KEY=false` in that file pins the setting and the UI
  toggle saves but never takes effect. Verify with an unkeyed request before trusting the
  toggle; enforcement can currently only be pinned from the env.
- **Chained 9routers double-prefix ids** (`up/dlm/…` when node `up` points at a 9router
  whose own models are `dlm/…`) — request the id exactly as listed.
- **Embeddings calls record no usage row**; chat rows on the stream-omitted path store a
  local token *estimate* that under-counts reasoning models ~30x vs the SDK-reported number.
- Restart persistence: models/keys/connections/usage all survive a kill+restart; no
  re-wiring needed.
- **Federation snapshot: UI-configured state replicates verbatim.** Boot the instance as
  `FEDERATION_MODE=central` + a second as `FEDERATION_MODE=edge` (shared `FEDERATION_TOKEN`,
  `FEDERATION_CENTRAL_URL`): the edge's replica carries the node, connection (credentials
  included), client key and full model import (96 ids, revisionLag 0) and serves chat +
  embeddings from the replica alone (`EDGE-SNAPSHOT-OK`).
