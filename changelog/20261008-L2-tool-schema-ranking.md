# L2 — Tool-Schema Relevance Ranking

- **Ticket:** TBD
- **Date:** 2026-10-08
- **Status:** Shipped (fork `master`); upstream PR #4651; **enabled in prod 2026-10-08**
- **Branch:** `feature/tool-schema-ranking`

## Summary

Flag-gated, fail-open lexical relevance ranking that drops zero-overlap tools
before dispatch. Ranking runs only when **all** hold:

```
toolRankEnabled && tokenSaverEnabled && Array.isArray(tools)
```

`rankTools` scores tools by lexical overlap with the message; only tools with
zero overlap are stripped. Any error is caught (fail-open) and the body is left
untouched.

## Files

`open-sse/utils/toolDeduper.js` (ranking), `open-sse/handlers/chatCore.js`
(gate + call), `open-sse/handlers/chatCore/...`, `src/lib/db/repos/settingsRepo.js`
(`toolRankEnabled: false` default), dashboard token-saver toggle, `tests/unit/tool-deduper.test.js`.

## Setting

`toolRankEnabled` — default **`false`** (`settingsRepo.js:61`). Enabled in prod
via the token-saver dashboard toggle; DB-verified `true`.

## Testing

18/18 specs. A/B against pristine: zero regressions. Deployed + preview-validated
on the real box.

## Known issue / follow-up

The `TOOLRANK` measurement log is `log?.debug?.` (`chatCore.js:242`), and
`open-sse/utils/debugLog.js` gates debug to **dev only** (`isDev = NODE_ENV !== "production"`).
So it **never emits in prod** — the measurement it was added for is not
observable. Promote to `log?.info?.` if prod measurement is wanted. `TOOLDEDUP`
(`chatCore.js:231`) has the same limitation.

Also note `tokenSaverEnabled` is per-request (`TOKEN_SAVER_HEADER !== "off"`), so
ranking does not run for clients that disable the token saver.
