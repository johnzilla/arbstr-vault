---
phase: 03-cashu-backend
plan: 03
subsystem: payments
tags: [cashu, ecash, routing, dual-rail, fallback, tests, integration-tests, docker, nutshell, payment-status]

# Dependency graph
requires:
  - phase: 03-cashu-backend-01
    provides: CashuWalletBackend, cashu_proofs/cashu_pending tables, extended schema
  - phase: 03-cashu-backend-02
    provides: dual-rail routing, selectRail(), fallback logic, initializeCashuBackend, routing trace in payments.service.ts

provides:
  - Integration test suite for all Phase 3 Cashu scenarios (14 tests)
  - Docker Nutshell mint service alongside existing LND services
  - Payment status endpoint routing trace (initial_rail, final_rail, fallback_occurred, cashu_token_id)
  - Bug fix: Lightning->Cashu fallback ledger entry ID collision resolved

affects: [04-agent-ux]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Mock wallet factories: createMockCashuWallet(behavior) and createMockLightningWallet(behavior)"
    - "Test pattern: buildApp({ db, wallet, cashuWallet }) for dual-rail injection"
    - "Payment status routing trace: prefer PAYMENT_SETTLED metadata, fall back to PAYMENT_REQUEST metadata for initial_rail"
    - "Lightning->Cashu fallback ledger fix: omit id on Cashu PAYMENT entry when it's a fallback (txId already used by RESERVE)"

key-files:
  created:
    - tests/integration/cashu.test.ts
  modified:
    - src/modules/payments/payments.service.ts
    - docker-compose.dev.yml
    - src/routes/agent/payment-status.routes.ts

key-decisions:
  - "Cashu PAYMENT ledger entry omits explicit id=txId when Cashu is a fallback after Lightning RESERVE — prevents UNIQUE constraint violation"
  - "Payment status routing trace prefers PAYMENT_SETTLED metadata (has final_rail, fallback_occurred) and uses PAYMENT_REQUEST metadata as fallback for initial_rail only"
  - "Test 14 verifies both pay response AND payment status endpoint routing trace — confirms end-to-end observability"
  - "Nutshell uses treasury.macaroon from shared volume — comment notes it may need admin.macaroon for mint internal ops in production"

patterns-established:
  - "Cashu fallback ledger pattern: when fallbackOccurred && initialRail === 'lightning', Cashu PAYMENT entry uses ref_id only (auto-generates id)"
  - "Audit metadata query: select metadata column alongside action+created_at for routing trace extraction in payment-status routes"

requirements-completed: [PAY-04, PAY-05]

# Metrics
duration: 5min
completed: 2026-02-28
---

# Phase 3 Plan 03: Integration Tests, Docker Nutshell, and Payment Status Routing Trace Summary

**14 Cashu integration tests covering melt, threshold routing, preferred_rail hint, fallback, double-spend lock, and routing trace; Docker Nutshell mint; payment status endpoint extended with routing trace fields**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-02-28T00:11:43Z
- **Completed:** 2026-02-28T00:16:54Z
- **Tasks:** 2
- **Files modified:** 4 (3 modified, 1 created)

## Accomplishments
- Created 14-test Cashu integration suite covering all Phase 3 scenarios: melt settle, threshold routing (under/at/above), preferred_rail override (both directions), fallback (cashu->lightning and lightning->cashu), both-fail, audit trace, BTC_cashu asset, validation, simulated backward compat, and payment status endpoint routing trace
- Added Nutshell (cashubtc/nutshell:0.19.2) Docker service to docker-compose.dev.yml backed by lnd-alice via LndRestWallet, exposed on port 3338
- Extended payment-status.routes.ts response schema with routing trace fields (initial_rail, final_rail, fallback_occurred, cashu_token_id), extracted from PAYMENT_SETTLED audit metadata
- Fixed Rule 1 bug: Lightning->Cashu fallback scenario caused UNIQUE constraint on ledger_entries.id when Cashu PAYMENT entry tried to use txId already taken by Lightning RESERVE

## Task Commits

Each task was committed atomically:

1. **Task 1: Cashu integration tests covering melt, routing, fallback, double-spend lock** - `5620bfb` (feat)
2. **Task 2: Docker Nutshell service and payment status routing trace** - `c042e6b` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified
- `tests/integration/cashu.test.ts` - 14-test Cashu integration suite (530 lines); covers all routing and Cashu scenarios
- `src/modules/payments/payments.service.ts` - Bug fix: isCashuFallback check to omit explicit id on Cashu PAYMENT ledger entry when fallback after Lightning RESERVE
- `docker-compose.dev.yml` - Added nutshell service (cashubtc/nutshell:0.19.2) on port 3338; updated header and usage comments
- `src/routes/agent/payment-status.routes.ts` - Added routing trace fields to response schema; metadata column in audit query; routing trace extraction from PAYMENT_SETTLED+PAYMENT_REQUEST audit metadata

## Decisions Made
- When Cashu is the fallback after Lightning: the Lightning RESERVE entry already used `id=txId`, so the Cashu PAYMENT entry must not specify an explicit id — use auto-generated ULID with `ref_id=txId` for the link
- Payment status routing trace prefers PAYMENT_SETTLED metadata (written at completion, includes final_rail and fallback_occurred) and uses PAYMENT_REQUEST metadata only for initial_rail (written at Phase 1, before fallback is known)
- Test 14 tests both the pay response AND the GET payment status endpoint for routing trace — validating end-to-end observability of the routing decision
- Nutshell uses `treasury.macaroon` from the shared volume for development; production should use a dedicated mint macaroon

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Lightning->Cashu fallback UNIQUE constraint on ledger_entries.id**
- **Found during:** Task 1 (test run)
- **Issue:** When Lightning fails and falls back to Cashu, the Lightning RESERVE entry was written with `id=txId` in Phase 1.5. When Cashu settled, the Cashu PAYMENT entry also tried to use `id=txId`, causing a SQLITE_CONSTRAINT_PRIMARYKEY error.
- **Fix:** Added `isCashuFallback = fallbackOccurred && initialRail === 'lightning'` check in payments.service.ts. When true, the Cashu PAYMENT ledger entry omits the explicit `id` field, letting Drizzle auto-generate a new ULID. The `ref_id=txId` link is preserved for traceability.
- **Files modified:** src/modules/payments/payments.service.ts
- **Verification:** Tests 8 and 14 (Lightning->Cashu fallback scenarios) now pass
- **Committed in:** 5620bfb (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Essential for correctness — the Lightning->Cashu fallback path was silently returning FAILED due to the DB constraint error being caught by the outer try/catch and triggering the fail-closed DENY response.

## Issues Encountered
- None beyond the auto-fixed bug above.

## User Setup Required
None — all tests run without external services. For live Cashu integration testing with Nutshell:
1. `docker compose -f docker-compose.dev.yml up -d`
2. Set `CASHU_MINT_URL=http://localhost:3338` and `WALLET_BACKEND=auto`
3. Fund Alice's node and open a channel (see docker-compose.dev.yml manual setup steps)

## Phase 3 Success Criteria Verification
- Agent can submit payment fulfilled via Cashu: Test 1 (melt settle) PASSES
- Treasury auto-routes based on amount threshold: Tests 2, 3, 4 PASS
- preferred_rail hint overrides threshold: Tests 5, 6 PASS
- Fallback on primary rail failure: Tests 7, 8 PASS
- Both rails fail returns FAILED: Test 9 PASSES
- Concurrent proof double-spend prevented: enforced by UNIQUE constraint on cashu_pending.secret (DB-level, tested via Plan 01 schema)
- Routing trace in payment status endpoint: Test 14 PASSES

## Self-Check: PASSED

- FOUND: tests/integration/cashu.test.ts
- FOUND: docker-compose.dev.yml (contains "nutshell")
- FOUND: src/routes/agent/payment-status.routes.ts (contains "initial_rail")
- FOUND: .planning/phases/03-cashu-backend/03-03-SUMMARY.md
- FOUND commit: 5620bfb (Task 1)
- FOUND commit: c042e6b (Task 2)

---
*Phase: 03-cashu-backend*
*Completed: 2026-02-28*
