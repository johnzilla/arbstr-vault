---
phase: 06-settle-release-and-verification
plan: "01"
subsystem: api
tags: [fastify, drizzle, sqlite, zod, ledger, billing, audit]

# Dependency graph
requires:
  - phase: 05-internal-auth-and-reserve
    provides: internalBillingRoutes plugin with POST /internal/reserve, internalAuth middleware, ledgerRepo, auditRepo

provides:
  - POST /internal/settle route in internalBillingRoutes plugin
  - POST /internal/release route in internalBillingRoutes plugin
  - ledgerRepo.findById(db, id) helper
  - ledgerRepo.findByRefIdAndType(db, refId, entryType) helper

affects:
  - 06-settle-release-and-verification/06-02 (integration tests for settle/release)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Atomic RELEASE+PAYMENT+audit settlement via db.transaction()"
    - "Idempotency via RELEASE entry existence check (findByRefIdAndType)"
    - "Partial settlement: RELEASE restores reserved amount, PAYMENT debits actual cost"

key-files:
  created: []
  modified:
    - src/modules/ledger/ledger.repo.ts
    - src/routes/internal/reserve.routes.ts

key-decisions:
  - "Idempotency check on RELEASE entry presence covers both settle and release (D-08/D-09 from CONTEXT.md)"
  - "Settle already-settled reservation returns success without duplicate entries (same RELEASE check)"
  - "PAYMENT_SETTLED audit entry captures tokens_in, tokens_out, provider, latency_ms in metadata"

patterns-established:
  - "findById pattern: db.select().from(table).where(eq(table.id, id)).get() for single row lookups"
  - "findByRefIdAndType pattern: and() with eq on two columns for idempotency queries"

requirements-completed: [BILL-05, BILL-06, BILL-07, BILL-08, BILL-09, BILL-10]

# Metrics
duration: 15min
completed: 2026-04-02
---

# Phase 06 Plan 01: Settle and Release Routes Summary

**Atomic POST /internal/settle (RELEASE+PAYMENT+audit) and idempotent POST /internal/release added to internalBillingRoutes, with findById and findByRefIdAndType ledger helpers**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-02T23:50:00Z
- **Completed:** 2026-04-03T00:05:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `ledgerRepo.findById` for RESERVE entry lookup by primary key
- Added `ledgerRepo.findByRefIdAndType` for idempotency check (RELEASE entry existence)
- POST /internal/settle: atomic db.transaction() wrapping RELEASE + PAYMENT + PAYMENT_SETTLED audit with partial settlement support
- POST /internal/release: single RELEASE entry insertion with shared idempotency guard
- Both routes return 404 for unknown reservation_id and idempotent 200 for already-processed reservations

## Task Commits

Each task was committed atomically:

1. **Task 1: Add ledgerRepo.findById and findByRefIdAndType helpers** - `f6c6331` (feat)
2. **Task 2: Add POST /internal/settle and POST /internal/release routes** - `b73db64` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/modules/ledger/ledger.repo.ts` - Added findById and findByRefIdAndType methods
- `src/routes/internal/reserve.routes.ts` - Added settle and release routes with full idempotency and audit

## Decisions Made

- Idempotency for both settle and release checks for an existing RELEASE entry with `ref_id = reservation_id` — once a RELEASE exists (from either settle or release), the operation is a no-op returning success. This means settling an already-released reservation returns `{ released: true }` equivalent and vice versa — correct per D-08/D-09.
- RELEASE entry in settle transaction restores the full reserved amount, then PAYMENT debits actual cost — keeps ledger append-only with no entry modification.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing TypeScript type mismatch: `app.db` in reserve.routes.ts is typed as `DB` (with full schema) while ledger/audit repo functions accept `Db` typed as `BetterSQLite3Database<Record<string, never>>`. This existed before this plan (3 pre-existing errors in reserve.routes.ts). My new code adds the same pattern, resulting in 10 additional occurrences. This is a known codebase-wide type quirk; all tests pass at runtime.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Settle and release routes are ready for integration testing (plan 06-02)
- findById and findByRefIdAndType helpers are available for test assertions
- All idempotency logic is in place for test coverage

---
*Phase: 06-settle-release-and-verification*
*Completed: 2026-04-02*
