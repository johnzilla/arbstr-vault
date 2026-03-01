---
phase: 01-foundation
plan: 04
subsystem: payments
tags: [better-sqlite3, drizzle-orm, fastify, zod, vitest, sqlite]

# Dependency graph
requires:
  - phase: 01-03
    provides: policy engine, ledger repo, audit repo, simulated wallet
  - phase: 01-02
    provides: agents repo, agentAuth middleware, buildApp factory
  - phase: 01-01
    provides: db schema, migrations, types (TransactionId, generateTransactionId)
provides:
  - POST /agents/:id/pay endpoint with Zod-validated request body
  - paymentsService.processPayment: policy -> wallet -> ledger -> audit orchestration
  - Atomic IMMEDIATE transactions for policy read + audit write, and ledger debit + settlement audit
  - 12 integration tests covering all deny reasons, audit completeness, auth, validation, time filter
affects: [02-lightning, 03-cashu, 04-approvals]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-phase sync transaction: Phase 1 (policy + PAYMENT_REQUEST audit), wallet call, Phase 2 (ledger debit + PAYMENT_SETTLED audit)"
    - "Fail-closed service: outer try/catch converts any error to DENY, never throws"
    - "Always-200 payment endpoint: HTTP status reflects request processing, policy_decision field carries outcome"

key-files:
  created:
    - src/modules/payments/payments.service.ts
    - src/routes/agent/payments.routes.ts
    - tests/integration/payments.test.ts
  modified:
    - src/app.ts

key-decisions:
  - "better-sqlite3 sync transaction constraint: transaction callbacks cannot return promises; extracted wallet call between two sync IMMEDIATE transactions"
  - "Two-phase transaction structure acceptable: Phase 1 reads state and writes PAYMENT_REQUEST audit atomically; Phase 2 writes ledger debit + PAYMENT_SETTLED audit atomically; TOCTOU window is narrow and acceptable for simulated Phase 1"
  - "POST /agents/:id/pay always returns 200; policy_decision field (ALLOW/DENY/REQUIRE_HUMAN_APPROVAL) carries outcome — HTTP status reflects request processing success"
  - "Dual Db type casting: agentsRepo uses BetterSQLite3Database<typeof schema>; ledger/audit repos use BetterSQLite3Database<Record<string, never>>; cast via unknown at call site"

patterns-established:
  - "Service-level fail-closed: outer try/catch in processPayment returns DENY with reason: internal_error on any unexpected error"
  - "Sync-first repo design: all repo methods synchronous (.run()/.get()) enabling sync transaction callbacks"

requirements-completed:
  - PAY-01
  - SEC-02
  - OBSV-02
  - OBSV-03

# Metrics
duration: 4min
completed: 2026-02-26
---

# Phase 1 Plan 4: Payment Orchestration Summary

**Atomic payment endpoint: POST /agents/:id/pay with policy->wallet->ledger->audit in two-phase IMMEDIATE transactions, 12 integration tests all green**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-26T14:31:14Z
- **Completed:** 2026-02-26T14:35:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- `paymentsService.processPayment` orchestrates the full payment flow with fail-closed semantics at policy and service level
- `POST /agents/:id/pay` endpoint with strict Zod validation on all fields — no z.any() or unvalidated inputs (SEC-03)
- DENY path: PAYMENT_REQUEST audit entry written, no ledger entry, balance unchanged
- ALLOW path: wallet executed, ledger debited, PAYMENT_REQUEST + PAYMENT_SETTLED both audited
- 12 integration tests: happy path, balance verification, all 4 deny reasons (max_tx, daily_limit, insufficient_balance, deny_all), audit completeness, 401/403 auth checks, Zod 400 validation, time-range filter
- All 48 tests across the entire project pass (no regressions)

## Task Commits

1. **Task 1: Payment service with atomic transaction orchestration** - `7a28abe` (feat)
2. **Task 2: Payment route, app wiring, and integration tests** - `4507f58` (feat)

**Plan metadata:** (pending)

## Files Created/Modified

- `src/modules/payments/payments.service.ts` - Payment orchestration service with two-phase sync transactions
- `src/routes/agent/payments.routes.ts` - POST /agents/:id/pay Fastify plugin with Zod schema
- `src/app.ts` - Registered agentPaymentRoutes alongside existing routes
- `tests/integration/payments.test.ts` - 12 end-to-end integration tests

## Decisions Made

- **Two-phase sync transaction structure:** better-sqlite3 rejects async transaction callbacks. Solution: Phase 1 sync IMMEDIATE tx (read balance/spend, evaluate policy, write PAYMENT_REQUEST audit), then async wallet call, then Phase 2 sync IMMEDIATE tx (write ledger debit + PAYMENT_SETTLED audit). The two phases are each internally atomic; ledger and settlement audit are atomic with each other.
- **Always-200 response:** payment endpoint always returns 200 — denied payments are not HTTP errors, they are processed policy decisions. `policy_decision` field carries ALLOW/DENY/REQUIRE_HUMAN_APPROVAL.
- **Dual DB type casting:** `agentsRepo.getWithPolicy` requires full-schema DB; ledger/audit repos use narrow `Record<string, never>` type. Cast via `unknown` at each call site inside the transaction callback.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Sync transaction adapter for better-sqlite3**
- **Found during:** Task 1 (payment service implementation) — surfaced during Task 2 tests
- **Issue:** Plan specified `db.transaction(async (tx) => { ... })` but better-sqlite3 throws "Transaction function cannot return a promise" for async callbacks
- **Fix:** Restructured to two synchronous IMMEDIATE transactions with the async wallet call extracted between them. Phase 1: policy evaluation + PAYMENT_REQUEST audit. Phase 2: ledger debit + PAYMENT_SETTLED audit. The wallet call (always synchronously resolved in Phase 1) runs between the two DB transactions.
- **Files modified:** `src/modules/payments/payments.service.ts`
- **Verification:** All 12 integration tests pass; ledger and audit entries confirmed atomic
- **Committed in:** `7a28abe` (revised in `4507f58`)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Required structural adaptation to better-sqlite3's sync constraint. All critical invariants maintained: DENY always audited, ALLOW always produces ledger debit + settlement audit, fail-closed at both policy and service level.

## Issues Encountered

- TypeScript type mismatch between `BetterSQLite3Database<typeof schema>` (agentsRepo) and `BetterSQLite3Database<Record<string, never>>` (ledger/audit repos) — resolved by casting transaction handle via `unknown` at each call site, matching the pattern established in Plans 02/03.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 1 complete: full simulated payment pipeline working end-to-end
- Ready for Plan 05 (if any remaining foundation tasks) or Phase 2 (Lightning integration)
- LND payment state machine edge cases (TrackPaymentV2, retry semantics, HTLC slot exhaustion) noted as warranting targeted research before Phase 2 planning

## Self-Check: PASSED

All created files found on disk. All task commits exist in git history.

- FOUND: src/modules/payments/payments.service.ts
- FOUND: src/routes/agent/payments.routes.ts
- FOUND: tests/integration/payments.test.ts
- FOUND: .planning/phases/01-foundation/01-04-SUMMARY.md
- FOUND commit: 7a28abe (Task 1 - payment service)
- FOUND commit: 4507f58 (Task 2 - routes, wiring, tests)

---
*Phase: 01-foundation*
*Completed: 2026-02-26*
