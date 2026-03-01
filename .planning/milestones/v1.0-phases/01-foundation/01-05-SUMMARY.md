---
phase: 01-foundation
plan: 05
subsystem: security
tags: [pino, fastify, vitest, sqlite, better-sqlite3, drizzle-orm]

# Dependency graph
requires:
  - phase: 01-04
    provides: payment orchestration, POST /agents/:id/pay, audit entries
  - phase: 01-03
    provides: policy engine, ledger repo, audit repo
  - phase: 01-02
    provides: agents repo, agentAuth middleware, buildApp factory
  - phase: 01-01
    provides: db schema, migrations, types
provides:
  - Pino logger configuration with token redaction (loggerConfig from pino.plugin.ts)
  - BuildAppOptions interface for injecting loggerStream in tests
  - 10 security/isolation tests: token redaction, balance isolation, cross-agent 403, fail-closed
  - 1 comprehensive E2E test validating all 5 Phase 1 success criteria sequentially
  - 59 total tests across entire Phase 1 (zero failures)
affects: [02-lightning, 03-cashu, 04-approvals]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pino redact paths: explicit top-level paths (token, token_hash, raw_token) required alongside wildcard (*.token) — pino wildcard does NOT match top-level fields"
    - "buildApp overloaded signature: supports legacy buildApp(db) and new buildApp({db, loggerStream}) for test capture"
    - "Fail-closed test via paymentsService.processPayment(closedDb) — tests service layer directly when agentAuth can't be bypassed"
    - "loggerConfig uses level: 'silent' in NODE_ENV=test; tests override app.log.level = 'info' when capture is needed"

key-files:
  created:
    - src/plugins/pino.plugin.ts
    - tests/integration/security.test.ts
    - tests/integration/e2e.test.ts
  modified:
    - src/app.ts

key-decisions:
  - "Pino top-level redact paths require explicit names: `*.token` wildcard only matches nested fields (e.g. agent.token), NOT top-level `token`. Both must be listed."
  - "BuildAppOptions interface extends buildApp to accept optional loggerStream — enables test capture without NODE_ENV hacks"
  - "Fail-closed test calls paymentsService.processPayment directly with closed SQLite — because agentAuth also uses DB, closing connection before HTTP request would 500 in middleware, not service"
  - "E2E test uses a single sequential `it` block — validates full lifecycle state machine (each step depends on prior state)"

patterns-established:
  - "Security test pattern: import loggerConfig.redact directly into tests; build pino instance with same config to verify redaction behavior"
  - "E2E test pattern: single ordered test with accumulated state (agent_id, token, tx_id) — not isolated beforeEach"

requirements-completed:
  - OBSV-05
  - AGNT-02

# Metrics
duration: 6min
completed: 2026-02-26
---

# Phase 1 Plan 5: Security, Observability, and E2E Validation Summary

**Pino token redaction with 59 passing tests including full lifecycle E2E validating all 5 Phase 1 success criteria**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-26T09:38:43Z
- **Completed:** 2026-02-26T09:45:32Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- `src/plugins/pino.plugin.ts` exports `loggerConfig` with pino redact paths for all token fields: top-level `token`/`token_hash`/`raw_token` AND nested `*.token`/`*.token_hash`/`*.raw_token` AND `req.headers.authorization`
- `src/app.ts` updated to use `loggerConfig` from pino plugin; `BuildAppOptions` interface added so tests can inject a custom `loggerStream` for log capture
- `tests/integration/security.test.ts` — 10 tests: pino redaction verified via parsed JSON (top-level, nested, req.headers), Fastify loggerStream capture, balance isolation (AGNT-02), cross-agent 403 enforcement, fail-closed DENY on closed DB
- `tests/integration/e2e.test.ts` — 1 sequential test exercising all 15 steps of the complete payment lifecycle, validating all 5 Phase 1 success criteria
- All 59 tests pass (11 policy + 14 ledger + 11 agents + 12 payments + 10 security + 1 E2E), TypeScript clean

## Task Commits

1. **Task 1: Pino token redaction plugin and security/isolation tests** - `08c5e79` (feat)
2. **Task 2: Full lifecycle E2E test validating all 5 Phase 1 success criteria** - `0fb493f` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified

- `src/plugins/pino.plugin.ts` - Pino logger configuration with redact paths for token masking (OBSV-05)
- `src/app.ts` - Replaced inline logger config with loggerConfig import; added BuildAppOptions for loggerStream injection
- `tests/integration/security.test.ts` - Token redaction tests, balance isolation tests, fail-closed tests
- `tests/integration/e2e.test.ts` - Full lifecycle end-to-end test covering all Phase 1 endpoints

## Decisions Made

- **Pino top-level redact paths**: `*.token` wildcard only catches `{parent}.token` nested fields — it does NOT catch top-level `{token: ...}` log entries. Both explicit (`token`) and wildcard (`*.token`) paths must be listed. Discovered by running failing tests against the original config.
- **buildApp overloaded signature**: Added `BuildAppOptions` accepting `loggerStream?: DestinationStream` alongside the legacy `buildApp(db)` signature. Uses `{ ...loggerConfig, stream: loggerStream }` which Fastify's logger-pino.js passes as the pino stream parameter.
- **Fail-closed test approach**: Calling `paymentsService.processPayment(closedDb)` directly (not via HTTP) — because agentAuth also queries the DB, a closed connection before the HTTP layer would produce a 500 in the middleware, not the service. The service-level fail-closed invariant is better tested at the service boundary.
- **E2E test structure**: Single sequential `it` block with accumulated variables (agentId, agentToken, txId) so each step validates state from the prior step. Matches the "state machine" nature of the full lifecycle.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pino `*.token` wildcard does not match top-level `token` fields**
- **Found during:** Task 1 (token redaction tests)
- **Issue:** Plan specified `'*.token'` as the redact path for token fields. Pino's wildcard `*` in redact paths only matches one level of nesting — it does NOT catch a top-level `{token: "vtk_..."}` object. The tests `token field is masked in pino output` and `pino logger redacts token fields` both failed because top-level `token`, `token_hash`, `raw_token` were not redacted.
- **Fix:** Added explicit top-level paths (`token`, `token_hash`, `raw_token`) to `loggerConfig.redact.paths` alongside the wildcard variants. Final paths: `token`, `token_hash`, `raw_token`, `*.token`, `*.token_hash`, `*.raw_token`, `req.headers.authorization`, `req.headers["authorization"]`.
- **Files modified:** `src/plugins/pino.plugin.ts`
- **Verification:** 4 token redaction tests pass including parsed JSON assertions
- **Committed in:** `08c5e79` (Task 1)

**2. [Rule 2 - Missing Critical] Fail-closed HTTP test replaced with service-layer test**
- **Found during:** Task 1 (fail-closed test implementation)
- **Issue:** Plan specified testing fail-closed by closing SQLite connection and sending an HTTP payment request. However, `agentAuth` middleware also queries the DB to resolve the token hash. Closing SQLite before the HTTP request causes the auth middleware to fail with 500 (unhandled error), not the payment service's fail-closed path.
- **Fix:** Replaced the HTTP-level fail-closed test with a direct `paymentsService.processPayment(db, agentId, request)` call after closing SQLite. This tests the exact invariant: the payment service's outer try/catch converts any DB error to DENY with reason `internal_error`.
- **Files modified:** `tests/integration/security.test.ts`
- **Verification:** Test passes; result has `policy_decision: DENY`, `reason: internal_error`, `transaction_id` matching `tx_` prefix
- **Committed in:** `08c5e79` (Task 1)

---

**Total deviations:** 2 auto-fixed (Rule 1 - Bug, Rule 2 - Missing Critical)
**Impact on plan:** Both required for correctness of the security properties under test. Plan intent fully satisfied: token redaction verified, fail-closed verified. No scope creep.

## Issues Encountered

- TypeScript overloaded function signatures for `buildApp` required care to distinguish `DB` instances from `BuildAppOptions` objects at runtime. Used duck-type detection (`'db' in obj || 'loggerStream' in obj`) to identify options objects vs legacy DB arguments.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 1 complete: all 5 success criteria validated in E2E test, 59/59 tests passing
- Security hardened: bearer tokens never appear in logs, balance isolation proven, cross-agent access blocked, fail-closed verified
- Ready for Phase 2 (Lightning integration)
- Phase 2 blocker noted: LND TrackPaymentV2/ListPayments retry semantics and HTLC slot exhaustion warrant targeted research before Phase 2 planning begins

## Self-Check: PASSED

All created files found on disk. All task commits exist in git history.

- FOUND: src/plugins/pino.plugin.ts
- FOUND: tests/integration/security.test.ts
- FOUND: tests/integration/e2e.test.ts
- FOUND: .planning/phases/01-foundation/01-05-SUMMARY.md
- FOUND commit: 08c5e79 (Task 1 - Pino redaction + security tests)
- FOUND commit: 0fb493f (Task 2 - E2E test)

---
*Phase: 01-foundation*
*Completed: 2026-02-26*
