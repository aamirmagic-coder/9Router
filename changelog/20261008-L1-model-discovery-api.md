# L1 — Model Discovery API

- **Ticket:** TBD
- **Date:** 2026-10-08
- **Status:** Shipped (fork `master`); upstream PR #4652
- **Branch:** `feature/model-discovery-api`

## Summary

Read-only model-discovery surfaces for the router:

- `GET /api/models/router` — authenticated per-model view of availability, usage,
  latency, and routing (combos / primary), plus capabilities. Reuses
  `getActiveModelLocks` from `/api/models/availability` (now `export`ed) instead
  of duplicating lock logic. Inert without params.
- `GET /api/v1/models` — extended filtering: `capability` (repeatable),
  `min_context`, `kind`, `q`, `limit`.
- `POST /api/v1/models/query` — filtered shortlist with body predicates:
  `capabilities[]`, `min_context`, `max_output`, `kind`, `q`, `owned_by`,
  `exclude`, `limit` (hard-capped).

## Files

`src/app/api/models/router/route.js` (new), `src/app/api/v1/models/query/route.js`
(new), `src/app/api/v1/models/route.js`, `src/app/api/models/availability/route.js`
(export only), `tests/unit/api-models-router.test.js`,
`tests/unit/v1-models-filter.test.js`, `tests/unit/v1-models-query.test.js`.

## Testing

27 specs. A/B against pristine: identical pre-existing failures → zero regressions.
Verified live (preview + prod) with authenticated calls: router view (200), GET
filter (`capability=tools&limit=5` → 5), POST predicates (`capabilities`,
`owned_by`, `q` all correct).

## Risks

Read-only. `/api/models/router` requires a dashboard session cookie (401
unauthenticated, verified); `/api/v1/*` require an API key.
