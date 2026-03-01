---
phase: 02-lightning-backend
plan: 03
subsystem: payments
tags: [lightning, lnd, payment-status, docker, regtest, integration-tests, macaroon, crash-recovery, typescript]

# Dependency graph
requires:
  - phase: 02-lightning-backend
    plan: 02
    provides: "LightningWallet, RESERVE/RELEASE flow, crash recovery, createPaymentsService factory, app.paymentsService decorator"
provides:
  - "GET /agents/:id/payments/:tx_id — payment status polling endpoint (PAY-06)"
  - "Payment status determined via audit_log (authoritative) + ledger entry types (fallback)"
  - "docker-compose.dev.yml with bitcoind + lnd-alice + lnd-bob in regtest mode"
  - "Scoped macaroon bake in lnd-alice entrypoint (info:read invoices:read invoices:write offchain:read offchain:write)"
  - "tests/integration/lightning.test.ts — 14 mock tests covering full Lightning state machine"
  - "Crash recovery tests for no-hash and has-hash RESERVE entries"
  - "Macaroon scope verification tests (SEC-05: FATAL on overprivileged, OK on scoped)"
  - "Payment status endpoint tests in payments.test.ts (tests m+n)"
affects: [phase-03-cashu]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "vi.mock('lightning', ...) hoisted before module imports — mocks LND npm without live node"
    - "EventEmitter.createMockSubscription pattern — emits 'paying'/'confirmed'/'failed'/'error' asynchronously via setTimeout(0)"
    - "Audit log as authoritative payment status source — ledger entry types as fallback"
    - "docker-compose.dev.yml entrypoint script: waits for LND readiness, then bakes scoped macaroon"
    - "describe.skip pattern for live tests requiring LND_HOST env var"

key-files:
  created:
    - src/routes/agent/payment-status.routes.ts
    - docker-compose.dev.yml
    - tests/integration/lightning.test.ts
  modified:
    - src/routes/agent/payments.routes.ts
    - src/app.ts
    - tests/integration/payments.test.ts

key-decisions:
  - "Audit log is authoritative for payment status (PAYMENT_SETTLED/PAYMENT_FAILED actions); ledger entry types are fallback for status determination"
  - "Payment status route queries both ref_id=tx_id AND id=tx_id to handle simulated PAYMENT entries (id=txId pattern) and lightning RESERVE entries"
  - "verifyMacaroonScope throws FATAL error (not calls process.exit directly); connectWithRetry catches FATAL and calls process.exit(1)"
  - "Mock tests always run (no LND_HOST needed); live regtest tests use describe.skip pattern"
  - "docker-compose.dev.yml lnd-alice command uses shell entrypoint to wait for LND readiness before baking macaroon"

requirements-completed: [PAY-06, PAY-03, SEC-04]

# Metrics
duration: 5min
completed: 2026-02-27
---

# Phase 2 Plan 03: Payment Status Endpoint, Docker Dev Environment, and Lightning Integration Tests Summary

**GET /agents/:id/payments/:tx_id status polling endpoint with audit-log-based status determination, regtest Docker Compose environment with scoped macaroon baking, and 14 Lightning mock tests covering the full RESERVE/RELEASE state machine, crash recovery, and macaroon scope verification**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-02-27T01:32:10Z
- **Completed:** 2026-02-27T01:36:40Z
- **Tasks:** 2
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments

- Implemented `GET /agents/:id/payments/:tx_id` status endpoint (PAY-06)
- Status determination: audit_log (PAYMENT_SETTLED/PAYMENT_FAILED) as authoritative source; ledger entry types (RESERVE/RELEASE/PAYMENT) as fallback
- Response includes: transaction_id, payment_hash, status, mode, amount_msat, fee_msat, created_at, settled_at
- 404 returned for unknown tx_id or wrong agent_id
- Updated `payments.routes.ts` asset enum to include `BTC_lightning`
- Registered `agentPaymentStatusRoutes` in `app.ts`
- Created `docker-compose.dev.yml` with bitcoind (regtest) + lnd-alice + lnd-bob
- lnd-alice entrypoint script: waits for LND readiness, bakes scoped macaroon, copies TLS cert to shared volume
- Macaroon scope: `info:read invoices:read invoices:write offchain:read offchain:write` (intentionally excludes `onchain:read`)
- Created `tests/integration/lightning.test.ts` with 14 mock tests + 1 live (skipped without LND_HOST)
- Mock tests cover: SETTLED/FAILED/stream-error flows, payment_hash capture, RESERVE/RELEASE full state machine
- Crash recovery tests verify: no-hash RESERVE detection, has-hash RESERVE detection for re-subscription
- Macaroon scope tests verify: FATAL error on overprivileged macaroon, silent OK on correctly scoped macaroon
- Added tests m+n to `payments.test.ts`: payment status endpoint for simulated SETTLED + 404 for unknown tx_id
- Total test count: 75 passing + 1 skipped (live regtest test)

## Task Commits

Each task was committed atomically:

1. **Task 1: Payment status endpoint and payment route response updates** - `660b7ae` (feat)
2. **Task 2: Docker dev environment and Lightning integration tests** - `d631f2c` (feat)

## Files Created/Modified

- `src/routes/agent/payment-status.routes.ts` - NEW: GET /agents/:id/payments/:tx_id with audit-log-based status
- `docker-compose.dev.yml` - NEW: Regtest environment with bitcoind, lnd-alice (Treasury), lnd-bob (test payee)
- `tests/integration/lightning.test.ts` - NEW: 14 mock tests + 1 live (skipped); full state machine coverage
- `src/routes/agent/payments.routes.ts` - Added BTC_lightning to asset enum
- `src/app.ts` - Registered agentPaymentStatusRoutes
- `tests/integration/payments.test.ts` - Added tests m and n for payment status endpoint

## Decisions Made

- Audit log is authoritative for payment status — PAYMENT_SETTLED/PAYMENT_FAILED actions unambiguously determine final state without interpreting entry type combinations
- Payment status route queries ledger by both `ref_id=tx_id` (for entries in the RESERVE/RELEASE flow) and `id=tx_id` (for the initiating entry that may not have ref_id set equal to tx_id in all code paths); merged to find all related entries
- `verifyMacaroonScope` throws a FATAL Error (message starts with "FATAL:"); `connectWithRetry` catches it and calls `process.exit(1)` — the test correctly tests the function that throws, not the wrapper
- Mock tests use `vi.mock('lightning', ...)` hoisted by Vitest before module graph loads — no live LND needed
- Live regtest tests use `const LIVE_TESTS = process.env.LND_HOST ? describe : describe.skip` pattern per locked decision

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test 7 used invalid Drizzle `.where()` callback syntax**
- **Found during:** Task 2 (Lightning integration tests)
- **Issue:** Test 7 initially used `.where((columns) => columns)` — Drizzle's `.where()` does not accept a callback; it requires a SQL condition or nothing
- **Fix:** Removed the invalid `.where()` call and dead code; replaced with a plain `.all()` to select all ledger entries (correct since each test uses an isolated in-memory DB)
- **Files modified:** `tests/integration/lightning.test.ts`
- **Committed in:** `d631f2c` (Task 2 commit)

**2. [Rule 1 - Bug] Test 13 wrong expectation for macaroon scope verification**
- **Found during:** Task 2 (Macaroon scope tests)
- **Issue:** Test expected `process.exit` to be called by `verifyMacaroonScope`, but `verifyMacaroonScope` only throws a FATAL Error; `process.exit` is called in `connectWithRetry` (the wrapper). The test was testing the wrong behavior.
- **Fix:** Updated test to verify that `verifyMacaroonScope` throws an Error with "FATAL:" in its message, which is the correct contract for the function being tested
- **Files modified:** `tests/integration/lightning.test.ts`
- **Committed in:** `d631f2c` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 test bugs — invalid Drizzle API usage and wrong function contract expectation)
**Impact on plan:** No behavioral impact — both were test-only fixes. The implementation itself matches the plan spec exactly.

## Issues Encountered

- None beyond the two auto-fixed test bugs noted above.

## User Setup Required

For live regtest testing:
1. `docker compose -f docker-compose.dev.yml up -d`
2. Fund lnd-alice with regtest BTC (mine blocks to Alice's address)
3. Open Lightning channel: Alice -> Bob
4. Set env vars: `WALLET_BACKEND=lightning`, `LND_HOST`, `LND_PORT`, `LND_CERT_BASE64`, `LND_MACAROON_BASE64`
5. Live tests run automatically when `LND_HOST` is set

## Next Phase Readiness

- Phase 2 (02-lightning-backend) is COMPLETE — all 3 plans executed
- All Phase 2 requirements satisfied: PAY-03, PAY-06, SEC-04, SEC-05
- 75 tests passing + 1 live regtest test (skipped in CI, runs with Docker env)
- Ready to proceed to Phase 3 (Cashu hot wallet integration)

---
*Phase: 02-lightning-backend*
*Completed: 2026-02-27*

## Self-Check: PASSED

All files exist and all commits verified:
- FOUND: src/routes/agent/payment-status.routes.ts
- FOUND: docker-compose.dev.yml
- FOUND: tests/integration/lightning.test.ts
- FOUND: .planning/phases/02-lightning-backend/02-03-SUMMARY.md
- FOUND: Task 1 commit 660b7ae
- FOUND: Task 2 commit d631f2c
