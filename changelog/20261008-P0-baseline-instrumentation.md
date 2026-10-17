# P0 — Baseline Instrumentation (attempt depth, cache reuse %, tool count)

- **Ticket:** TBD
- **Date:** 2026-10-08
- **Status:** Shipped (fork `master`, PR #37); upstream PR #4649
- **Branch:** `feature/p0-instrumentation`

## Summary

- Logs combo attempt depth (`COMBO … · ATTEMPT i/n`) so multi-model fallback is
  observable.
- Logs per-request cache-reuse % on the `DONE` line.

## Fix landed 2026-10-08

The cache-reuse **denominator** was wrong in PR #37: it divided by raw
`inTok`, which is not the cache-inclusive prompt count. Now uses the canonical
value:

```js
const canonical = canonicalizeUsage(u);
const denom = canonical?.prompt_tokens || inTok;
```

`canonicalizeUsage` folds `cached + cache_creation` into `prompt_tokens`, so the
percentage is against the true prompt total. Matches upstream #4649.

## Files

`open-sse/handlers/chatCore/requestDetail.js` (`formatDoneLine`),
`open-sse/services/combo.js` (`ATTEMPT`).

## Testing

Verified deployed: running prod container contains
`requestDetail.js:100 → const denom = canonical?.prompt_tokens || inTok`; combo
`ATTEMPT` line present at `combo.js:309`.
