# CGW / 9Router Compatibility Matrix

Recorded on 2026-10-20 (Europe/Berlin) during the Task 1 native gate.

| Component | Observed value | Result |
| --- | --- | --- |
| Development checkout | `e0be411184e67687171a1e13ae2e5686c14dd43a8` | Isolated implementation base |
| Development worktree | `codex/cgw-codex-combo-shim` | Clean at gate start |
| Installed 9Router | `9router-app` `0.5.104`, `custom-server.js` | Running on `http://127.0.0.1:20128` |
| Installed 9Router revision | No Git metadata in installed package | Recorded as package version, not guessed as a commit |
| Existing native adapter | `@lightrsi/codex-adapter` source commit `7e4147674c018f0654b3840704e0d0ee8c9e9330` | `tokenpilot-codex serve` on `http://127.0.0.1:17667`, upstream `9Router` |
| CGW runtime | `codex-chatgpt-web` `6.1.12-win32-x64` | `serve` on `http://127.0.0.1:17841` |
| Codex CLI | `codex-cli 0.162.1` | Native executable resolved from the installed Codex CLI |
| Codex home | Existing user `CODEX_HOME` | Used for authentication only; no credential value recorded |
| PR #111 overlay | Reference target `ce4460ef79382bfddb4aa5fc0ff9f3cb0d5f95a8`; installed package exposes no overlay commit metadata | Existing relay remains untouched |
| Model probe | `gpt-6.1-sol` | Returned the exact requested marker through the configured local path |
| Persistent execution | `codex exec --json --sandbox read-only --skip-git-repo-check` | `turn.completed`, final text `CGW_NATIVE_OK` |
| Ephemeral execution | Same command with `--ephemeral` and explicit local provider/base URL overrides | `turn.completed`, final text `CGW_EPHEMERAL_OK` |
| Native result | Both modes | Genuine terminal event and valid final assistant message observed |
| Coexistence | Development 9Router source, installed 9Router, existing adapter, and CGW runtime | Compatible for the approved text-only smoke; PR #111 was not modified |

## Anomaly

Codex emitted a warning that hooks were loaded from both the user
`config.toml` and `hooks.json`. The warning reproduced in both native modes.
The root cause is duplicated user-level hook representations: the existing
Codex configuration contains hook entries while the separate `hooks.json`
contains TokenPilot/Herdr hooks. The native turn still completed successfully.
This is an environment configuration issue, not a 9Router defect, and no
permanent configuration was changed during the gate.

## Gate Decision

The proven execution mode is available for the shim. The implementation must
retain the Task 1 constraints: loopback-only service, text-only single-turn
input, bounded native process lifecycle, no credential persistence, and no
assumption that process exit alone proves success.
