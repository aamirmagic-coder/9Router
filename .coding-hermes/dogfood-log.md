# Dogfood Log

## 2026-09-20 — 9router (federation fork) — run 7: the product promises under the plumbing

- **Verdict:** 🟡 PROMISING-BUT-ROUGH. The ROI feature is real (RTK measurably
  saves 32% on grep / 73% on find and is proven end-to-end), but two of the
  README's headline promises are broken at HEAD `321268d5` and the test suite
  is structurally unable to see either.
- **Angle (new surface):** 10+ prior runs swept the CLI/CAG surface, the
  gateway endpoints and the whole federation acceptance suite (most recently
  2026-09-19, all green). This run took the untested product layer instead:
  RTK token saver, combo/model auto-fallback, multi-account rotation, and
  usage/quota accounting — driven with a real client on a scratch instance
  (`PORT=20127`, `DATA_DIR=/tmp/dogfood-9router`) plus a fresh bunker box.
  The 09-19 conclusion ("remaining roughness is onboarding friction, not
  broken promises") does not survive this surface.
- **Promise:** "point any OpenAI/Claude-compatible coding CLI at one endpoint,
  route to 40+ providers with RTK saving 20-40% of tool_result tokens, auto
  fallback subscription→cheap→free for zero downtime, round-robin across
  accounts, and track usage/quota so subscriptions get used before reset."
- **Method:** real use — scratch production instance, OpenAI-compatible node →
  LM Studio over the tailnet, client API key, real tool blobs sent as
  `role:"tool"` content, row counts read straight from SQLite, plus a fresh
  ephemeral bunker agent (`bunker-las-03`, agent `6e0618e5`, destroyed) for
  the install leg and a two-hop chain on that box.
- **Top findings:**
  1. **DF-9ROUTER-32 (P0)** — a request that OMITS `stream` (the OpenAI SDK
     default) returns non-stream JSON with `data: [DONE]` glued on, so the body
     does not parse (`Extra data: line 33 column 2`). Explicit `stream:true`
     and `stream:false` are both correct; upstream LM Studio is clean.
  2. **DF-9ROUTER-33 (P0)** — usage recording is dead on the streaming path:
     rows 1 → `stream:true` 2 → `stream` omitted 2 (NO ROW) → `stream:false` 3,
     while the client receives real counts. `requestDetail.js` drops the record
     when `inTokens === 0 && outTokens === 0`. Re-find: first reported
     2026-09-16, still open; this run adds the discriminator + guard location.
  3. **DF-9ROUTER-34 (P1)** — combo fallback never advances past a
     model-scoped 4xx: `[bad-model, good-model]` returns the first model's 400
     and never tries model #2, contradicting "zero downtime".
  4. **DF-9ROUTER-35 (P1)** — on a fresh install, a node against a healthy
     91-model upstream listed exactly ONE model through `/v1/models` (stable
     across 3 probes) although a completion through it worked.
  5. **DF-9ROUTER-36 (P1)** — round-robin is opt-in (fill-first default):
     4/4 requests served by the newest connection; README states it as a
     feature, not a switch.
  6. **DF-9ROUTER-37 (P2)** — a wrong provider-nodes field name gives a
     misleading error, and omitting `apiType` silently invents
     `prefix:"compatible"`.
- **Verified working (explicitly, on the same instance):** RTK saving
  (`grep` 11259B→32.1%, `find` 7266B→73.5%, `git log` refused) and end-to-end
  `[RTK] saved 3618B / 11259B via [grep]` with prompt_tokens 3316→2592, or
  3483 with `X-9Router-Token-Saver: off`; the filter safety contract (a
  worst-case blob GREW and was correctly left alone); restart persistence
  (nodes/connections/combos/models/traffic all survive); round-robin once
  enabled; and on the fresh box clone → `npm ci` (43s) → `npm run dev`
  (`Ready in 396ms`) → a real `CHAIN-OK` completion through fresh-install →
  control-host → LM Studio.
- **Time-to-first-success:** ~6 min on the control host (login → node →
  connection → key → completion); ~5 min from bare Debian to working routing
  on the fresh bunker box. Friction count: 6 product findings.
- **Artifacts:** `docs/dogfood/2026-09-20-integration.md`,
  `docs/dogfood/diagnostics.md` §13 (mechanism + the new re-verification
  playbook), `skills/9router-token-saving-and-accounting-usage/SKILL.md`,
  board rows DF-9ROUTER-32..37.
- **Foreman:** NOT woken — fleet law pins this project at 21600s; the rows are
  picked up at the normal cadence. No cooldown or Enabled state was touched.
- **Meta:** every one of these defects lives in a path the suite green-lights —
  a filter that returns bigger output (correctly refused) hides the missing
  end-to-end saving assertion; a "don't store junk" guard silently amputates a
  whole feature; an account-health predicate answers a model-level question.
  Tests proved modules; using it proved the product.

## 2026-09-01 — 9router (federation fork) — run 3: re-verify the fixes

- **Verdict:** ✅ SHIPPABLE (federation feature). Every formerly-open finding
  (FED-020 delta version drop, FED-021 lag metric, FED-022 settings
  replication, NR-GAP-034/036/039 hardening) re-verified FIXED at row level
  against real deployments.
- **Promise:** "Edges proxy /v1 + dashboard API to central, replicate its
  SQLite within seconds, keep serving during a central outage (writes queued,
  reconciled later) — using only documented env vars."
- **Method:** real deployment @ `cd90fd9e` (repo-root production path,
  `npm ci` + build), real dashboard API (login/key/provider/combo/settings),
  real `/v1` against a local mock Ollama, SIGKILL central → degraded →
  serve-from-replica → 202 queued write → restart → drain → re-link.
- **Top findings (all minor, P3):**
  1. **R3-01** — PUT `/api/keys/{id}` silently ignores `name` (200 + no-op).
  2. **R3-02** — short-FEDERATION_TOKEN boot guard logs placeholder-secrets
     wording (hard refusal, but misleading message).
  3. **R3-03** — `[federation] pull failed: fetch failed` logged once per
     sync interval for the whole outage; no rate limiting.
- **Row-level integrity:** apiKeys v4 delta, settings v6, combos v7 —
  `federation_version` + `updated_at` identical central/edge. FED-020
  signature (`maxVersion < lastAppliedRevision`) absent.
- **Time-to-first-success:** ~6 min (clean scratch → first `/v1` completion
  through the edge). Friction count: 4 (none blocking).
- **Artifacts:** `docs/dogfood/2026-09-01-integration.md`,
  `docs/dogfood/diagnostics.md` §11,
  `skills/9router-federation-usage/SKILL.md` v3.0.0, board R3-01..03
  (event id 452).
- **Foreman:** cooldown 259200s (3-day) with an empty board at start —
  woken to 900s to work R3-01..03, per the stand-in speed-up loop.
- **Meta:** the three-layer termination check (L3 = real user workflow) is
  what makes this verdict trustworthy; the 12-file/189-test federation
  vitest suite passes at HEAD too, but it passed at earlier HEADs that
  still hid FED-020.

## 2026-08-20 — 9router (federation fork) — re-test after FED-011..016

- **Verdict:** 🟡 PROMISING-BUT-ROUGH (federation now WORKS end-to-end; one P1
  replica-integrity bug + two P2 gaps remain). 2026-08-08 🔴 verdict resolved in
  practice.
- **Promise:** "Edges proxy /v1 to central, replicate central's SQLite, keep serving
  from a local replica during a central outage (writes queued, reconciled later)."
- **Method:** Real deployment, not tests: fresh `npm run build` at HEAD 10bb05d3,
  central + edge via the documented repo-root production path (`node custom-server.js`
  = `npm run start`), real dashboard API seeding (login, API key, ollama provider),
  real /v1 traffic against a mock Ollama upstream, SIGKILL of central, degraded
  writes, central restart. Re-ran the 2026-08-08 acceptance checks A–D verbatim.
- **Top findings:**
  1. **A–D ALL PASS**: replication converges (<10s, apiKeys/providerConnections in
     replica), authenticated /v1 through the edge (200, not "Invalid API key"),
     Bearer-only federation API (200), and the full kill→DEGRADED→serve-from-replica
     →queued-write (202 + X-Federation-Queued-Write-Id)→recover→drain (state=done)
     →reconcile (central has queued key; replicated back to edge) lifecycle.
     FED-011..016 fixes verified live (loops start from real entry points; edge boot
     logs `[federation] replication + failover loops started (edge mode).`).
  2. **FED-020 (P0-in-effect, filed P1)** — delta-applied replica rows lose
     `federation_version`/`updated_at` (entry-level metadata dropped by the delta
     branch of `applyRevisionBatch`): central v4/v5 rows land as v0/NULL on the edge;
     `local-status` shows `lastAppliedRevision:5, maxVersion:1`, revisionLag clamped
     to 0 — a stale edge can look healthy. Snapshot path is correct, which is why
     the bootstrap-heavy tests missed it.
  3. **FED-021 (P2)** — revisionLag derives from the local (corruptible) watermark
     instead of central's advertised maxVersion; FED-022 (P2) — settings boot seed
     bypasses stamping so settings never replicate via delta (edge settings=0).
- **Time-to-first-success:** ~3 min standalone completion on central; federation
  convergence ~10s after seeding; full lifecycle verified in ~15 min of testing.
- **Friction count:** 4 (stream:true 503 with mock — identical on central, not
  federation; undocumented model prefix; provider API shapes need source-reading;
  proxy ~2x timeout on failure paths).
- **Artifacts:** `docs/dogfood/2026-08-20-integration.md`,
  `docs/dogfood/diagnostics.md` §7-10 (addendum), `skills/9router-federation-usage/SKILL.md`
  v2.0.0 (rewritten to current reality), board FED-020..FED-022 (event id 369).
- **Foreman:** woken — CooldownS 21600 → 900 via scheduler API (Enabled=true kept).
- **Meta:** the 2026-08-12 reverify passed while row versions were already
  corrupting — it asserted counts and lag, never row-level version metadata. The
  integrity probe (compare row versions central vs edge after a delta update) is now
  step 4 of the verification playbook.

## 2026-08-08 — 9router (federation fork)

- **Verdict:** 🔴 DOES-NOT-DELIVER (federation feature; standalone/upstream product works)
- **Promise:** "Deploy the same 9router on multiple instances; edges proxy /v1 to central,
  replicate central's SQLite, and keep serving from a local replica during a central
  outage (writes queued, reconciled later)."
- **Method:** Real deployment, not tests — central + edge booted from the exact
  Dockerfile.federation runtime layout (`node custom-server.js`), real dashboard API
  usage (login, API keys, provider connection), real `/v1/chat/completions` against a
  mock Ollama upstream, SIGKILL of central, degraded writes, central restart.
- **Top findings:**
  1. **FED-011 (P0)** — edge proxy strips the client's API key (`Authorization` →
     `X-9r-Client-Authorization`, never read upstream): authenticated /v1 through any
     edge → `Invalid API key` from central. The headline "point your CLI tool at the
     edge" workflow fails on the first authenticated request.
  2. **FED-013 (P0)** — replication + failover loops (`edgeClient.start()`/
     `failover.start()`) are called only by the e2e harness, never by the real app:
     edge replica stayed empty (0 apiKeys/providerConnections after 6 min), DEGRADED
     serving answered `Invalid API key` (empty replica), and after central restart the
     edge stayed DEGRADED forever with pendingWrites never drained / never reconciled.
  3. **FED-012 (P0)** — `/api/federation/*` 401s with only the documented Bearer token
     (dashboardGuard deny-by-default; `/api/federation` missing from PUBLIC_API_PATHS);
     even token-less `local-status` needs a dashboard session. The documented protocol
     is unreachable.
  - Also: FED-014 (README `npm run start` never loads custom-server.js → no federation
    at all), FED-015 (plain Docker image ships without `src/lib/federation` → silently
    inert edge), FED-016 (status surface masks "never started" as `linked`).
- **Time-to-first-success (federation):** never — first documented workflow (replication)
  failed at step 1; first working federation API call required an undocumented dashboard
  cookie. Time-to-first-success (standalone gateway): ~3 min.
- **Friction count:** 7 (see integration report).
- **Artifacts:** `docs/dogfood/2026-08-08-integration.md`,
  `docs/dogfood/diagnostics.md`, `skills/9router-federation-usage/SKILL.md`, board
  tasks FED-011..FED-016 (event id 74).
- **Foreman:** not woken (CooldownS already 900); 6 pending P0/P1/P2 tasks on the board.
- **Meta:** the "e2e 17/17 PASS" claim coexists with a dead feature — the harness starts
  the loops itself and bypasses Next's dashboardGuard. Tests proved modules, not product.
2026-09-01 | PROMISING-BUT-ROUGH | 20s t2fs | friction 6 | 5 findings
2026-09-04 | PROMISING-BUT-ROUGH | 12s t2fs | friction 9 | 5 findings
2026-09-07 | PROMISING-BUT-ROUGH | 170s t2fs | friction 9 | 5 findings

2026-09-13 | DOES-NOT-DELIVER | 44s t2fs | friction 16 | 5 findings\n
2026-09-13 | PROMISING-BUT-ROUGH | 39.465s t2fs | friction 9 | 5 findings\n
2026-09-13 | DOES-NOT-DELIVER | 43s t2fs | friction 13 | 5 findings\n
2026-09-16 | PROMISING-BUT-ROUGH | 335s t2fs | friction 14 | 5 findings\n
2026-09-19 | PROMISING-BUT-ROUGH | t2fs boot 40s + local-endpoint wiring ~6min | friction 4 | 3 findings (DF-9ROUTER-29 P1 onboarding/two-object model, DF-9ROUTER-30 P2 silent empty completion on protocol mismatch, DF-9ROUTER-31 P3 fail-hard outage window) | promise: multi-tool AI gateway routing to 40+ providers + fork federation; reality: OpenAI stream/non-stream + Anthropic /v1/messages + usage tracking all work at HEAD 585bd31c, federation acceptance A/A+/B/C/D all PASS (replication, row-level integrity, edge auth, kill→degraded→queue→drain→relink); all five 09-13 P0/P1 findings re-checked and none reproduce; artifacts docs/dogfood/2026-09-19-integration.md + diagnostics.md §12 + skills/9router-federation-usage updated | install leg: bunker-qa battery on bunker-las-02 agent c5d61826 (evidence /tmp/bunker-qa-evidence-9router-df10.jsonl)
install-leg result (bunker-las-02, agent c5d61826, evidence /tmp/bunker-qa-evidence-9router-df10.jsonl): fresh-install OK on the clean agent (toolchain-bootstrap OK, repo sync + install path completed); collect OK, agent destroyed. Cell FAILs are battery-environment artifacts, not install failures: docker-deploy/chaos-shutdown rc=125 'unknown shorthand flag: d' — the agent's rootless docker is the compose-v1 era CLI (compose plugin absent), same class seen on other QA runs; upgrade 404 — the fork's private package 9router-app has no registry release (README documents fork is source/Docker only); ui-probe treats the auth 307 /login redirect as not-serving; ci-pass/chaos-resource need act + full toolchain the throwaway agent lacks. None of these contradict installability; compose cells would need a compose-plugin bootstrap in the battery script (bunker-qa.sh, not this repo).

2026-09-20 | PROMISING-BUT-ROUGH | t2fs ~6min (control host) / ~5min fresh box | friction 6 | 6 findings (DF-9ROUTER-32 P0 default-stream unparseable JSON, DF-9ROUTER-33 P0 usage-dead-on-streaming, DF-9ROUTER-34 P1 combo-fallback-4xx, DF-9ROUTER-35 P1 fresh-node 1-model listing, DF-9ROUTER-36 P1 round-robin opt-in, DF-9ROUTER-37 P2 node-field validation) | RTK VERIFIED (grep 32.1%/find 73.5%; prompt_tokens 3316->2592, 3483 with saver off) | install_seconds=43 | bunker=las-bunker-03 agent=6e0618e5 | smoke=ok (clone+checkout federation+npm ci 43s+dev Ready 396ms+CHAIN-OK completion; agent destroyed)

2026-09-24 | SHIPPABLE | UI bootstrap + embeddings first drive; t2fs ~10 min (build 3 min included); friction 6 | 4 findings (DF-9ROUTER-38 P1 Require-API-key silent env-pin no-op + double-PATCH race, DF-9ROUTER-39 P2 non-stream usage ~30x under-estimate + embeddings no row, DF-9ROUTER-40 P2 chained-router double-prefix ids + 95s hang on bad model id, DF-9ROUTER-41 P3 UI polish) | promise: dashboard-first wiring of an OpenAI-compatible router + embeddings endpoint; reality: UI path works end-to-end (login->node->connection->import 96 models->key->completion), embeddings 768-dim cosine-sanity PASS (also through a 2-hop chain), 09-20 P0s DF-32/DF-33 verified FIXED at HEAD eb8fee31, restart persistence PASS, fresh bunker install clone 3s / npm install 39s / dev boot 436ms / FRESH-CHAIN-OK | artifacts docs/dogfood/2026-09-24-integration.md + diagnostics.md s14 + skills/9router/SKILL.md wiring+gotchas | install leg: bunker-las-03 agent 6b0e3ee4 (destroyed) smoke=ok

2026-09-25 | DOES-NOT-DELIVER (fresh HEAD install) / SHIPPABLE (undici-7 instances) | t2fs: NEVER on fresh HEAD (first chat 503, 100% repro); friction 5 | 5 findings (DF-9ROUTER-42 P0 undici 8.11.0 bump breaks every gemini upstream call at HEAD — raw-gzip JSON.parse, bisect+downgrade-proven on bunker; DF-9ROUTER-43 P1 STT rejects octet-stream WAV and burns 30s account lock; DF-9ROUTER-44 P1 .env PORT override + undocumented restart-after-adding-provider; DF-9ROUTER-45 P2 cooldown lock masks real error; DF-9ROUTER-46 P2 bunker-qa __gen-remote still broken) | ANGLE: multimodal surface first drive (image/TTS/STT/search/web-fetch) — untouched by 13 prior runs | on working instances the surface is good: image 1024² PNG 5-7s, TTS WAVE 1.5s, TTS→STT round-trip returns exact sentence, search 4-9s; perf: nothing slow enough for a PERF row | artifacts docs/dogfood/2026-09-25-integration.md + diagnostics.md s15 + skills/9router-multimodal/SKILL.md | install leg: bunker-qa battery SKIPPED (script broken, DF-46) — manual ephemeral bunker las-bunker-03 agent 0b251c72: clone 3s, npm install 87s, dev boot <60s, chat 200@699edac3 vs 503@HEAD, undici@7.19.2 downgrade → 200, agent destroyed | foreman: not woken (active sibling ticks same window; board rows pending)

2026-09-25 (nudge2 continuation) | SHIPPABLE (verified) | tick-416 wave recovery: DF-42/43/44 work was already merged and judged by the interrupted session; this tick live-verified all three fixes at HEAD 133a53b2 on the persisted scratch instance (undici 8.11.0): chat 200 stream+non-stream, TTS 200 RIFF, STT 200 with AND without MIME — DF-43's no-MIME rejection itself is fixed at HEAD. Rows closed with verdict citations; host-local verdict dirs cited (history gitignored). New finding DF-9ROUTER-47 P2: npm run build crashed once transiently (webpack uncaughtException, no BUILD_ID), clean retry green — CI has no production build leg. No bunker install leg: this was a verification tick, previous same-day run carried it (install 87s, boot <60s). Kill the P0: chat 503 is dead at HEAD no longer.

2026-09-25 | PROMISING-BUT-ROUGH (compose deployment surface) | t2fs: compose federation stack usable ~5 min after build (247s build+boot on N100; standalone published-image up 19s warm; fresh-daemon cold install 271s incl. build) | friction 4 | 4 findings (DF-9ROUTER-48 P1 compose coexistence command omits -p -> resolves onto LIVE stack network+volumes silently + 9router-data pinned globally; DF-9ROUTER-49 P1 DOCKER.md never explains login/.env/INITIAL_PASSWORD; DF-9ROUTER-50 P2 first-completion cold outlier 17.9s upstream-attributed, baseline recorded; DF-9ROUTER-51 P2 SKIPPED-install-bunker — all 4 las hosts down/stuck, compensated by fresh-daemon dind install proof) | ANGLE: docker-compose deployment surface (never driven by 14 prior runs; battery compose cells always died on plugin): federation A/A+/B/C/D lifecycle ALL PASS with containers as the unit (degraded ~15s, replica serving 1.8s, 202+queued-write, re-link ~20s, reconcile both sides, row-level integrity byte-identical in-container), standalone quickstart + headroom sidecar wiring + upgrade-in-place via local-build override all PASS | perf: /v1/models through router 180-209ms vs 363ms direct (cache wins), steady completions 610-670ms vs 326ms direct (~280ms overhead), restart->serving 3s; nothing user-noticeable, no PERF row | artifacts docs/dogfood/2026-09-25-compose-integration.md + diagnostics.md s16 + skills/9router-compose/SKILL.md | install leg: bunker-qa/bunker SKIPPED (DF-51) — fresh-daemon leg on-host: 271s cold -> FRESH-DAEMON-OK | foreman: not woken (rows pending at normal cadence; live stack on :20128 is THIS project's production instance — coordination caution noted in report)

## 2026-10-02 19:45 UTC — Dogfood tick (9router-dogfood lane)

**Verdict**: PARTIAL SUCCESS

**Findings**:
- DOGFOOD-001: API key auth fails for remote requests (HIGH) — isLocalRequest() requires trusted peer headers in production, breaking all remote API access
- DOGFOOD-002: No providers configured (MEDIUM) — cannot test LLM routing
- DOGFOOD-003: Federation untested (LOW) — both instances running but no traffic observed
- DOGFOOD-004: Fast endpoints (INFO) — dashboard 31ms, health 8ms

**Files**:
- Report: /tmp/9router-dogfood-report.md
- Findings: /tmp/dogfood-findings.jsonl
- Board: 4 rows appended (DOGFOOD-001 through DOGFOOD-004)

**Blockers**: Cannot complete full dogfood without fixing DOGFOOD-001 and configuring at least one provider.

**Next steps**:
1. Fix API key authentication for remote access
2. Configure OpenAI or Anthropic provider
3. Test federation edge→central proxy
4. Add integration tests for remote API auth
2026-10-10 | SHIPPABLE (live central real-use + fresh-install leg) | t2fs: fresh install dev-server first completion N/A (no provider creds on fresh box — expected); fresh-box login→key→models chain ~7min incl. toolchain download | friction 3 | 3 findings (DF-9ROUTER-52 P1 stale DOGFOOD-001/002 premises: env API_KEY_SECRET is not a client credential, DB-issued keys work — 3/3 real completions through live central ocg/ocg/xkiro; DF-9ROUTER-53 P2 fresh-install default password 123456 undiscoverable from docs; DF-9ROUTER-54 P3 691 catalog models listed with zero credential indication) | ANGLE: re-verify the 10-02 scratch-instance rows against LIVE state + fresh-install first-user path | perf: chat warm 0.55-0.88s (first-call outlier 1.55s, upstream), /v1/models warm ~0.38s, dashboard health ~1.8ms — nothing user-noticeable, no PERF row | install leg: bunker-las-02 agent 0ee9fc3f (las-03/04 down, las-02 active; 1 spawn retry after transient slice-limits failure): clone 3s, npm install 12s (after node22 tarball download ~75s — bare agent has NO node/npm: docs finding for fresh-machine claims), dev Ready 446ms (port .env override → 20127, not documented PORT), v1/models 200, health 200, dashboard 200, remote-styled 401 triad correct; agent destroyed (1st destroy aborted on tar race, 2nd OK) | foreman: not woken (read-only lane; rows pending at normal cadence)
2026-10-13 | FAILED (stale-deploy regression of a fixed P0 on the flagship surface) | t2fs: fresh install leg clean (clone 6.5s, node22 4.4s, npm i 43s, dev Ready 1.25s, unauth 401 correct, destroy ok 1 retry, residue clean on bunker-mvp agent 62bac767) | friction 2 | 3 findings (DF-9ROUTER-55 P0 STALE DEPLOY: live central v0.5.69 + edges v0.5.55 predate DF-9ROUTER-32 fix b3b4f9d1/v0.6.0-federation.1 — non-stream /v1/chat/completions returns glued 'data: [DONE]\n\n' tail, strict json.loads fails 3/3, all OpenAI SDK consumers break on the core surface; DF-9ROUTER-56 P2 error-envelope drift: bad-key on /v1/* returns dashboard-API error shape while fresh-install path returns proper OpenAI envelope, bad model 404 blames 'provider: openai' for an unresolvable alias; DF-9ROUTER-57 P3 docs: destroy-gate-refuses-with-live-processes undocumented) | ANGLE: unexercised real-consumer surface — key-mint→chat→fail-closed ladder on the LIVE central + both edges (prior 10-10 run did dev-server + basic chat only) | perf: chat warm 0.76-2.2s (upstream-bound), /v1/models 0.47s, stream 0.76s, dashboard ~8ms; edge-a single 14.1s sample; nothing router-attributed slow, no PERF row | install leg: bunker-mvp agent 62bac767 PASS (bunker2/3/4 ssh-timeout; las-02 not probed this run) | foreman: not woken (lane contract; rows pending at normal cadence)
2026-10-13 (second run, re-proof) | INDEPENDENT RE-PROOF of DF-9ROUTER-55 + NEW sub-evidence narrowing it | live central :20128 + both edges re-driven from a fresh shell: stream key ABSENT → 200 text/event-stream with JSON body + trailing `data: [DONE]\n\n` glued (3/3, jq parse error "Invalid numeric literal"), explicit `stream:false` → CLEAN application/json (7/7), so the corruption hits exactly the no-stream-key default every SDK/curl consumer uses | NEW: `stream:true` → duplicated `data: [DONE]` sentinel (2 in one response; prior run recorded streaming clean — regression or v0.5.69 behavior worth the redeploy diff) | same-shape SSE leak on /v1/responses (event: sequence_number tail, event-stream ct) | fail-closed ladder re-proven (unauth 401, xkiro/glm-5.3-flash 404 model_not_found, embeddings 503 w/ 24s cooldown lock) | perf: warm non-stream 0.59-0.72s, models 0.50s — nothing user-noticeable, no PERF row | install leg: bunker-mvp agent 6a96e478 (las-02/03/04 ALL ssh-unreachable this run) — tar-transfer clone, node22 tarball 24s, npm install fast, dev health/models 200 + DF-9ROUTER-54's improved no-credentials error message verified live on fresh HEAD, unauth 401 correct, destroyed + verified | board NOT touched (read-only lane; re-proof recorded here only) | foreman: rows DF-9ROUTER-55/56 already pending from sibling run 9a584df7 — no new rows filed
## 2026-10-16 (9router-dogfood lane, bunker-mvp agents 78748826 + df9router1016) | SHIPPABLE on the live central — DF-9ROUTER-55 premise proven FALSE, DF-9ROUTER-56 half re-proven LIVE | ANGLE: discriminating re-proof of the two 10-13 pending rows against the REDEPLOYED production stack; one key minted; no code/board writes | STACK IDENTITY: central v0.5.99 (its own /api/version), image built 2026-10-13 17:23 -05, running since 22:24:10Z — the image PREDATES fix commit e90cff7f (2026-10-14 01:36 -05) by ~8h; edges run FEDERATION_MODE=edge, central=central; container FEDERATION_TOKEN + API_KEY_SECRET md5-match the host .env; container REQUIRE_API_KEY=true vs host-file false (drift noted) | REAL-USE CHAIN all green on live central :20128: dashboard login 200 7ms → POST /api/keys 201 (len-35 sk- key) → local+key /v1/models 200 0.373s → remote-styled (Host: tailnet IP)+key 200 0.459s → remote NO-KEY 401 + remote bad-key 401 (fail-closed held) → non-stream chat ocg/glm-5.3-flash 200 1.22s content 'dogfood-ok' → edge-a with the central-minted key 200 2.37s content 'edge-ok' → wrong-model xkiro/… 404 model_not_found with OpenAI envelope → spoof probes all refused 401 (x-9r-via-proxy, x-forwarded-for, bare x-9r-real-ip, ?key=bad) | RE-PROOFS: DF-9ROUTER-55 FALSE — stream-key-ABSENT non-stream 3/3 CLEAN application/json, jq parses, content 'reproof'; /v1/responses 200 application/json with clean head AND tail (same-shape SSE leak gone); stream:true sentinel exactly 1 (no duplication) — all three 10-13 symptoms dead on this image; DF-9ROUTER-56 HALF-LIVE — bad-key 401 on /v1/models STILL returns the bare dashboard shape {"error":"API key required for remote API access"} (no error.type/code) while wrong-model 404 IS properly enveloped, consistent with the image predating e90cff7f; NEW local-regression observation: loopback keyless /v1/models → 401 and keyless loopback chat → 401 ("provide your API key / CLI dev only"), which contradicts the dashboardGuard keyless-local path (isLocalRequest) — needs foreman source-reading, P2; live catalog lists 179 model ids for this key | perf (hyperfine on live central): /v1/models 0.373s±0.036 ×20, non-stream chat 2.542s±1.026 ×10 (upstream-bound), /api/health 0.024s±0.016 ×30 — nothing router-attributed that a user would notice; NO PERF row | INSTALL LEG (explicit, not silent): bunker2/3/4 ssh-unreachable, bunker-mvp active — tar-transfer install on agent 78748826 (git archive tar-over-ssh, clone 3s; node22 tarball ~30s — bare agent ships NO node/npm; npm i ~30s; dev Ready <2s, /api/health 200 0.39–0.53s cold) BUT every first /v1/models cold-compile attempt killed the next-server process: 8 consecutive attempts all 000 after a preceding 200 health, 0 procs after, host dmesg shows NO kernel OOM and the bunker logs show no cause → COMPILING-KILLS-DEV on the tar-transfer install, UNRESOLVED on the flagship surface; compensating fresh-clone leg on agent df9router1016 (public https clone, npm i 30s/594 pkgs, Ready 485ms, /v1/models try0 → 200 50,717B, server stayed alive) proves the product path healthy on a TRUE clone install — the kill is specific to the tar-transfer install shape; the fresh-clone leg's remaining smoke probes (unauth 401, dashboard) did NOT run — the agent's TTL reaped it at 19:12 before that script executed; 78748826 itself was TTL-reaped (spawned 17:24:31Z, expired 18:54:31Z) | LESSON for the bunker leg: `bunker spawn` without --ttl runs on a ~90m default (heartbeat docs name it) — two agents lost to TTL in one run; pass --ttl explicitly | foreman: not woken (read-only lane); corrections for DF-9ROUTER-55 (premise false on current deploy) and DF-9ROUTER-56 (401-envelope half still live on this image) ride this log at normal cadence

2026-10-20 | PUBLISHED-PACKAGE ON A FRESH MACHINE: installability PASS, first-use discovery FAILS | t2fs: ~20s to a serving router on a clean box (node tarball 4s + `npm install -g 9router` 10s + boot 6s); time to first SUCCESSFUL completion: never (0/5 across 3 fresh instances) | friction 5 | 1 finding (DF-9ROUTER-2-R2 P1 recurrence: a fresh install advertises 824 ids from /v1/models and 0 of them complete a standard chat — advertised ids 404 'No active credentials for provider: <p>' in 7ms; the deliberately-credentialless ids 400 upstream (`oc/jev-1.13-free` ModelProtocolUnsupported, `mmf/mimo-auto` 'Unsupported model mimo-auto'); the same endpoint answered 5 ids once a node+connections existed, so the surface swings between 824-dead and 5-dead) | ANGLE: the published artifact (npm 9router@0.5.104) on a machine that had never seen the project + an audit of what that install tells the user | re-proof: DF-9ROUTER-2/7/54 are all status=complete, so this is a recurrence on the published-package path — route.js:444-454/536-566 states the fresh-install path must not serve the static catalog | perf: nothing user-noticeable — warm /api/health 2.45-3.60ms, /v1/models (824 ids, 317KB) 5.73-10.02ms, /login 2.38-11.74ms, /dashboard 307 2.58ms; the slow numbers are one-shot cold steps (node 4s, npm -g 10s, boot 6s) -> NO PERF row | install leg: ephemeral bunker server bunker-mvp agent d7673bc5 (Ubuntu 24.04.4, node/npm/jq all MISSING): README:116 `npm install -g 9router` rc=0 10s -> `9router 0.5.104`; boot /api/health 200 in 6s; login 200 with the default password; POST /api/keys 201 (35-char key); README:158 clone 1s (default branch = master 699edac, NOT the federation branch); `npm install` in the clone 594 packages 77s rc=0; agent destroyed + `bunker list` back to its pre-run count (bunker-las-02/03/04 OFFLINE deadline_exceeded this run, so bunker-mvp was the only ONLINE server) | artifacts: docs/dogfood/2026-10-20-published-package-fresh-install.md + skills/9router-fresh-install/SKILL.md | foreman: not woken (read-only lane) | RUN INTEGRITY: this tick was delivered TWICE into one session (82f13f2b, 04:03:48 and 04:13:49) so two executors ran the same tick concurrently — the other executor owned the live-chain/SSE angle and the bunker-qa.sh battery (agent f4c5e00f); this entry covers the published-package/fresh-machine angle only, was written once, its id was minted by board_next_id.py --recur and re-checked for uniqueness immediately after the append.

2026-10-20 (same tick, install-leg continuation) | bunker-qa.sh battery on a FRESH machine (agent f4c5e00f, bunker-mvp, HEAD 01235645) | cells: repo-head OK · toolchain-bootstrap OK (node v22.22.3, go 1.26.5, gcc/g++, make, compose+buildx plugins — the old docker-compose rc=125 blocker is GONE) · fresh-install OK · upgrade OK (v0.6.0-federation.1 tree → HEAD reinstall clean) · ci-pass FAIL (native rc=1: Tests 53 failed | 4333 passed | 14 expected fail | 132 skipped | 1 todo (4533), 434 files, 274.25s; the cell's own regression gate names 15 pass→fail — force-stream-config ×2, mimo-free.live (live/opt-in), security-audit source-audit ×12) · ui-probe FAIL = HARNESS ARTIFACT, not a product defect (probe treats the auth 307 → /login as 'UI not serving', observed while Next was still 'Compiling /login') · docker-deploy + chaos-shutdown SKIPPED by the controller safety gate (controller is the live Hermes host) · chaos-corruption N/A · chaos-resource INFO (OOM under cap) · chaos-errorpath INFO (missing-config start unverified: module-loader throw) | cross-check: same-day local run at the same HEAD gave 53 failed | 4383 passed | 95 skipped with the gate naming 8 pass→fail — IDENTICAL failure count on two machines, so the regression set is real, not host-specific; the pass→fail lists differ only by environment-dependent tests (live-network, source-content audits). Evidence: /tmp/bunker-qa-evidence-20261020T093444Z-3362680.jsonl (20 rows, collect OK, agent destroyed, bunker-mvp back to its pre-run count). Recorded as a reproof EVENT on DF-9ROUTER-62 (no second row).

2026-10-20 (second angle, SAME tick 2026-10-20-09-03-45) | PROMISING-BUT-ROUGH (chained-router + published-package runtime) | t2fs: install + first-user chain ~2min (npm i 5.7s, boot ≤4-9s, login→key→models all <1s); time to first SUCCESSFUL chained completion ~15min of which ~10min was source-reading the node-id/snapshot contracts | friction 4 | 3 new findings (DF-9ROUTER-55-R2 P1 recurrence: stream-key-ABSENT across a compat-node hop returns text/event-stream with 'data: [DONE]' glued to the JSON (jq dies), stream:true duplicates the sentinel — central direct is clean on the identical body; DF-9ROUTER-63 P2: connections snapshot node baseUrl/apiType at create so a node fix needs connection re-creation, and POST /api/providers 404s on prefix (wants node id); DF-9ROUTER-64 P2: fresh published instances died silently twice in 50min on a headless host, empty logs, no kernel OOM, data persisted) | ANGLE: live-chain real use (fresh v0.5.104 → central v0.5.99 → GLM-5.2 completion returned 'dogfood-ok-1020') + dashboard UI walk (Providers 'central-df 3 Connected', Usage 7 req/51,702 in/101 out matching API ground truth) + consumer CLI (show honest, connect wrote tool config) | perf: health p50 3ms, /v1/models p50 7ms, chained chat min 1.17s/mean 2.74s max 7.90s (upstream-bound) — nothing router-attributed, NO PERF row | install leg: bunker-qa battery on bunker-mvp agent f4c5e00f (launch 09:34Z, evidence /tmp/bunker-qa-evidence-20261020T093444Z-3362680.jsonl): repo-head/toolchain/fresh-install OK (compose+buildx plugin gap FIXED), ci-pass FAILED — verify-no-regression re-run on-agent names 15 pass→fail (force-stream ×2 + security-audit ×12 + mimo live ×1), same set the sibling run reproduced locally; evidence pull via collect completes after this entry (collect printed RUNNING on first poll) | artifacts: docs/dogfood/2026-10-20-live-chain-sse-integration.md + skills/9router-fresh-install/SKILL.md (rewrite with chain traps) + diagnostics.md §17 | sibling coordination: run delivered twice into one session (sibling entry above covers published-package/fresh-machine + DF-9ROUTER-2-R2/62); this entry covers ONLY the live-chain/SSE/battery angle, rows minted by board_next_id.py (--recur for 55-R2) and verified present x1 each | foreman: not woken (read-only lane)

2026-10-23 | tick 9router-dogfood-2026-10-23-13-55-53 | PROMISING-BUT-ROUGH (launcher lifecycle + fresh-machine install) | t2fs: ~5 min to a serving fork instance on the fleet host (boot 2.8-4.9s, all probes warm <6ms); NEVER on a bare box — the documented source build fails | friction 4 | 5 findings (DF-9ROUTER-67 P2 fresh-box `npm run build` aborts in /api/oauth page-data collection `TypeError ... 'bind'` → `npm start` FATAL, same HEAD builds green on the fleet host in 94s so it is environment-shaped not repo-broken; DF-9ROUTER-68 P2 the launcher menu's own `Update to v0.5.109` offer runs `npm install -g 9router@latest`, which replaces a fork install with UPSTREAM (no federation) and can never clear while cli/package.json is pinned 0.5.104; DF-9ROUTER-69 P3 `.gitignore:102` unscoped `9router-*` silently ignores any NEW `skills/9router-*/SKILL.md` or `docs/dogfood/9router-*.md` (the 14 tracked skills survive only because tracked files are exempt) so the repo's self-teaching path drops new knowledge; DOC-28 P4 `cli/README:153-156` implies an unusable `--port` warns like `PORT`, live it is silent (offending value 0 occurrences on both streams, stderr 73 B = exit line only); FED-PR-005-R2 P1 recurrence — PR decolua/9router#3173 is CONFLICTING/DIRTY again, 403 files +57315/-4706, head `federation-pr` 58 behind `federation`, upstream master at v0.5.109) | ANGLE: the LAUNCHER itself (`node cli/cli.js` + `npm start`) — never driven by any prior run (prior ticks covered HTTP API, dashboard, federation, multimodal, compose, published package) | POSITIVE re-proofs: `--no-tray` serves headless with zero tray artifacts and wins over `--tray`; SIGINT/SIGTERM exit in 120/118 ms, kill the detached server group, release the port, and emit exactly `[<ISO>] [9router] exiting: signal {"signal":"SIGINT"}`; SIGKILL leaves the documented orphan (port stayed bound — the docs are honest); occupied port refuses with rc=1 naming both `--port`/`PORT=` fixes; `show` enumerates all 9 tools; `connect` without a URL exits rc=1 with usage; a fresh fork instance advertises exactly 1 model (`mmf/mimo-auto`) instead of the published package's 824 — the DF-2/7/54 credential filter holds — though that one id still 400s upstream in 3.8s; real-remote-peer auth is fail-closed (401 OpenAI envelope on models+chat for no-key and bogus-key) while a spoofed Host header is NOT remote (harness artifact, discarded) | perf: nothing user-noticeable — global install of the published 0.5.109 4.30s cold (11 pkgs), boot 2.82-4.93s (4 runs), /api/health warm p50 3.6ms (10 samples, max 6.5ms), /v1/models warm 3.5-5.3ms, shutdown 120ms — NO PERF row | install leg: bunker-mvp REFUSED spawn (`dial tcp 100.115.67.116:19090: connection refused`), las-01/03/04 silent → agent df9router1023 on bunker-las-02 (Debian 6.12, node/npm MISSING): node v22.14.0 in 9s, clone 5s @9e50cba4, npm ci 38s rc=0, `npm run build` rc=1 in 19s, `npm start` FATAL no standalone server; CONTROL ARM same HEAD on the fleet host: clone 2s, npm ci 16s, build rc=0 94s, standalone present | CONTAMINATION DISCLOSED: port 20128 on that host is held by a FOREIGN kara-owned next-server v16.3.2 (/api/version 0.5.55) that the agent user cannot kill, so my first probe rounds answered from THAT instance; all agent numbers here come from a free-port (30005) run or from the build logs | agent destroyed + verified (`Agent df9router1023 destroyed.`, key removed, bunker-las-02 back to its pre-run count) | artifacts: docs/dogfood/2026-10-23-cli-launcher-lifecycle.md + skills/9router-cli-launcher/SKILL.md (force-added: see DF-9ROUTER-69) | SIBLING SPLIT: a second delivery of this same tick ran concurrently on the same checkout (combos/usage-accounting angle, rows DF-9ROUTER-65/66, doc 2026-10-23-combos-and-usage-accounting.md) — I left docs/dogfood/diagnostics.md and skills/README.md untouched rather than race two writers, so this run's diagnostic trail lives in its own doc; ids re-minted after 65/66 were taken (board_next_id.py, --recur for FED-PR-005-R2) and validated: boardctl validate = 375 warnings, identical to the parent commit | foreman: not woken (read-only lane)

2026-10-23 (second angle, SAME tick 9router-dogfood-2026-10-23-13-55-53) | PROMISING-BUT-ROUGH (combos work; the usage ledger next to them does not) | t2fs: ~2 min from minted key to a working 3-seat combo (create 201, first completion 7.64s incl. the failover walk, then 0.89-1.42s); friction 3 | 4 findings (DF-9ROUTER-39-R2 P1 recurrence — usage ledger records the CLIENT-BODY ESTIMATE, not the upstream count, for gemini-format providers: served prompt_tokens 2002 vs ledger 2 on the same request, constant ~2000-token delta across 5 arms, /api/usage/stats says 157 prompt tokens for 19 requests that served ~38k, root cause open-sse/handlers/chatCore/requestDetail.js:24-50 extractUsageFromResponse has no usageMetadata branch + resolveUsage:125 fallback, harvest runs BEFORE nonStreamingHandler.js:436 translation; DF-9ROUTER-65 P3 — all-seats-fail combo answers 503 in 8ms naming only the LAST seat's raw upstream text; DF-9ROUTER-66 P3 — per-key model/combo access control works but is undocumented in README and denies with type=permission_error + code=insufficient_quota; DF-9ROUTER-70 P2 — fresh-machine CI red on the DF-9ROUTER-64 fix's OWN guard: unit/cli-no-tray-headless.test.js expects default-path exit 0, clean Debian-13/node-22 box exits 1, dev host 5/5 pass, and it is the only failing file missing from known-fails.txt) | ANGLE: the combo/failover surface (zero combos existed on the live instance before this run) driven as a user on a live central whose lanes were almost all dead | LIVE STACK: central v0.5.99 (container created 2026-10-13, started 2026-10-23T14:09:19Z), dashboard itself advertises 0.5.109; of 7 provider connections only gemini (df-crosscheck) was testStatus=active — ocg ×2 [401] api_key_expired, cmc ×2 [429] weekly limit (resets 2026-10-24T23:07Z), xkiro ×2 unavailable in a real call xkiro/google/gemini-3.6-flash answered 503 in 14.7s | REAL USE: combo [ocg(dead), cmc(dead), gemini(live)] → 3/3 completions 200 (7.64s cold / 1.42s / 0.89s), dead seats locked after first failure so later requests skip them; stream through the combo 200 in 1.44s with exactly 1 `data: [DONE]` and model = the resolved seat; NESTED combo (combo as a seat) 200 in 0.89s; per-combo Round Robin set from the dashboard <select> persisted to settings.comboStrategies and rotated correctly 4/4 200; the combo is a first-class /v1/models id (owned_by=combo) so a CLI picker finds it; per-key restriction allow=[combo] → combo 200 / other model 403 | perf (no PERF row): /api/health 12ms, /v1/models 0.374-0.391s, combo warm 0.63-1.42s vs direct gemini 0.97-2.0s (no combo overhead), all-seats-fail 8ms — nothing slow enough that a user would notice; the real cost signal is the ~2000-token accounting gap, not latency | install leg: bunker-qa.sh on bunker-las-02 agent fc083fea (--keep, destroyed after logs pulled): repo-head OK, toolchain-bootstrap OK (node v22.22.3/npm 10.9.8/go 1.27.3/compose+buildx), fresh-install OK 4s, upgrade OK (v0.6.0-federation.1 → HEAD), ci-pass FAIL (native rc=1: 46 failed / 4359 passed / 14 expected fail / 132 skipped of 4552 in 222.61s; act build job OK 3m00s + e2e OK 14.1s + test job FAIL 2m36s), ui-probe FAIL = harness artifact (307 → /login during `Compiling /login`), docker-deploy + chaos-shutdown SKIPPED by the controller safety gate, chaos-corruption N/A, chaos-resource INFO, chaos-errorpath INFO (probe_started=no), chaos-disconnect UNVERIFIED (suite failed first); evidence /tmp/bunker-qa-evidence-20261023T141854Z-1886922.jsonl (20 rows) + pulled ci.log/native.log; HARNESS FRICTION: bunker-qa.sh's known-server SSH table maps only mvp→22 and everything else→2223, while the live hosts answer agents on 22 → launch died `repo sync failed: … port 2223: Connection refused` and collect said `unreachable-agent` until BUNKER_QA_SSH_PORT=22 was exported for BOTH phases; dedi-2 spawned an agent with ssh refused and cube-las-00 refused spawn outright while its port was open | HYGIENE: the live instance still carries 4 ACTIVE keys left by earlier dogfood runs (dogfood-cli-0928, dogfood-1016, dogfood-1016b, dogfood-1020-fresh) — left in place, not mine to revoke; this run's own combos (3), keys (2) and its comboStrategies entry were removed and verified gone (combos 0, comboStrategies {}, my keys deleted) | artifacts: docs/dogfood/2026-10-23-combos-and-usage-accounting.md + diagnostics.md §18 + skills/9router-combos/SKILL.md (force-added: .gitignore:102 `9router-*` would otherwise ignore it — corroborates sibling row DF-9ROUTER-69) | SIBLING: this tick was delivered twice; the other executor committed 1c17f739 (launcher lifecycle + fresh-machine install, DF-9ROUTER-67/68/69, DOC-28, FED-PR-005-R2) before this angle landed. No overlapping defect — its rows cover build/launcher/gitignore/PR, mine cover combos + usage accounting + this one clean-machine CI red; that commit also swept my three combo/accounting rows into its diff, so they read as landed from 1c17f739. `boardctl validate` before (parent board dump) 375 warnings OK / after 375 warnings OK — delta 0 | foreman: not woken (read-only lane)

2026-10-23 (NO-OP RESUME, same tick 9router-dogfood-2026-10-23-13-55-53 re-fired) | nothing re-driven, nothing missing — verification only | HEAD 45ad1072 on origin/federation (0 unpushed, 0 behind; base 9e50cba4 + sibling 1c17f739 + this angle's 45ad1072) | census in the COMMITTED blob: DF-9ROUTER-39-R2, -65, -66, -67, -68, -69, -70, DOC-28, FED-PR-005-R2 each appear exactly once (working tree identical) | artifacts present in HEAD: docs/dogfood/2026-10-23-combos-and-usage-accounting.md, docs/dogfood/2026-10-23-cli-launcher-lifecycle.md, skills/9router-combos/SKILL.md, skills/9router-cli-launcher/SKILL.md, diagnostics.md §18 | boardctl validate: RESULT OK (375 warnings), identical to the parent-commit baseline — no new warnings | two quiescence samples identical (HEAD 45ad1072, clean working tree, tasks.jsonl mtime 2026-10-23 09:46:05, dogfood-log.md 09:46:25, 90 s apart) and no dogfood writer process on the checkout (only the long-lived live stack next-servers) | no scratch listeners; bunker-las-02 back to 0 agents; live central restored (login 200, combos 0); DuckBrain /dogfood/2026-10-23-dogfood-lane-run2 reads back 200 in namespace 9router | this fire deliberately did NOT repeat the combo probes, the launcher PTY capture, or the install leg — at an unchanged HEAD those measure the substrate, not the product
