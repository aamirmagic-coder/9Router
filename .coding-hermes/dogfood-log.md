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
