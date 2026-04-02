---
phase: 05-internal-auth-and-reserve
plan: 02
subsystem: api
tags: [fastify, zod, sqlite, ledger, billing, reserve]

# Dependency graph
requires:
  - phase: 05-01
    provides: internalAuth middleware for X-Internal-Token validation

provides:
  - POST /internal/reserve endpoint for arbstr core to reserve agent funds
  - RESERVE ledger entry pattern (negative amount_msat, mode simulated)
  - Conditional route registration based on VAULT_INTERNAL_TOKEN config
  - Integration test suite (9 tests) for internal billing flow

affects:
  - 05-03 (settle endpoint — consumes reservation_id from this plan)
  - future internal billing phases

# Tech tracking
tech-stack:
  added: []
  patterns:
    - internalBillingRoutes FastifyPluginAsync plugin pattern
    - Token-based agent resolution via hashToken + agentsRepo.findByTokenHash
    - RESERVE/RELEASE ledger entry pattern with negative amounts
    - Conditional route registration gated by config.VAULT_INTERNAL_TOKEN

key-files:
  created:
    - src/middleware/internalAuth.ts
    - src/routes/internal/reserve.routes.ts
    - tests/integration/internal-billing.test.ts
  modified:
    - src/config.ts
    - src/app.ts
    - vitest.config.ts

key-decisions:
  - "Always include VAULT_INTERNAL_TOKEN in vitest.config.ts test env to ensure module-level config parse sees the token"
  - "Route registered conditionally via config.VAULT_INTERNAL_TOKEN check in buildApp"
  - "model field accepted in request body for forward-compat but not persisted in RESERVE ledger entry"

patterns-established:
  - "RESERVE ledger entries use negative amount_msat to reduce available balance"
  - "correlation_id stored as ref_id on ledger entry for end-to-end tracing"
  - "All internal billing uses mode simulated (no real wallet calls)"

requirements-completed: [BILL-01, BILL-02, BILL-03, BILL-04]

# Metrics
duration: 3min
completed: 2026-04-02
---

# Phase 5 Plan 02: Internal Reserve Route Summary

**POST /internal/reserve endpoint allowing arbstr core to hold funds against agent balances via negative RESERVE ledger entries**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-02T22:20:27Z
- **Completed:** 2026-04-02T22:23:39Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Created POST /internal/reserve route with Zod schema validation (body: agent_token, amount_msats, correlation_id, model)
- Implemented agent resolution via token hash lookup, balance check, and atomic RESERVE ledger insertion
- Registered route conditionally in app.ts when VAULT_INTERNAL_TOKEN is set; protected by internalAuth hook
- 9 integration tests covering 200/401/402/400 paths, ledger entry verification, and balance reduction

## Task Commits

1. **Task 1: Create POST /internal/reserve route** - `fd427aa` (feat)
2. **Task 2: Register route in app.ts and create integration tests** - `0f18d28` (feat)

## Files Created/Modified

- `src/middleware/internalAuth.ts` — Fastify onRequest hook, validates X-Internal-Token via timingSafeEqual
- `src/config.ts` — Added VAULT_INTERNAL_TOKEN: z.string().min(32).optional()
- `src/routes/internal/reserve.routes.ts` — internalBillingRoutes plugin with POST /internal/reserve
- `src/app.ts` — Import and conditional registration of internalBillingRoutes
- `vitest.config.ts` — Added VAULT_INTERNAL_TOKEN to test env for module-level config parse
- `tests/integration/internal-billing.test.ts` — 9 integration tests for reserve endpoint

## Decisions Made

- Added VAULT_INTERNAL_TOKEN to vitest.config.ts test env rather than relying on in-test process.env assignment (ESM hoisting means static imports execute before top-level test code, so the config module was parsed without the token if set only in the test file)
- The `model` field is accepted in the request body schema for forward compatibility with future phases but is not persisted in the RESERVE ledger entry in v1.1

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created internalAuth.ts and updated config.ts from Plan 05-01 dependency**
- **Found during:** Task 1 setup
- **Issue:** Plan 05-01 executes in a parallel worktree; this worktree did not have `src/middleware/internalAuth.ts` or `VAULT_INTERNAL_TOKEN` in `src/config.ts`
- **Fix:** Created `src/middleware/internalAuth.ts` and added `VAULT_INTERNAL_TOKEN` schema field to `src/config.ts`, matching the Plan 05-01 implementation from the other agent's worktree
- **Files modified:** src/middleware/internalAuth.ts (created), src/config.ts
- **Verification:** TypeScript compiles, all tests pass
- **Committed in:** fd427aa

**2. [Rule 3 - Blocking] Added VAULT_INTERNAL_TOKEN to vitest.config.ts test env**
- **Found during:** Task 2 integration tests
- **Issue:** ESM static import hoisting causes `config.ts` to parse `process.env` before test-file top-level `process.env.VAULT_INTERNAL_TOKEN = ...` assignments execute. The conditional route registration used `config.VAULT_INTERNAL_TOKEN` which was undefined at parse time, causing all requests to return 404.
- **Fix:** Added `VAULT_INTERNAL_TOKEN: 'test-internal-token-min-32-characters-long'` to `vitest.config.ts` env block (same pattern as the existing `VAULTWARDEN_ADMIN_TOKEN`)
- **Files modified:** vitest.config.ts
- **Verification:** All 9 integration tests pass; full suite 122/122 pass
- **Committed in:** 0f18d28

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both fixes required for functionality. No scope creep.

## Issues Encountered

ESM module hoisting meant `process.env` assignments in test files run after static imports, so the config singleton was parsed without `VAULT_INTERNAL_TOKEN`. Fixed by adding it to vitest.config.ts where it's set before any module evaluation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- POST /internal/reserve is live and tested; ready for Phase 05-03 (settle endpoint)
- RESERVE ledger entries use `id` as the `reservation_id` — the settle endpoint needs this ID to find and complete the reservation
- `ref_id` on RESERVE entries holds the `correlation_id` for end-to-end tracing

## Self-Check: PASSED

- internalAuth.ts: FOUND
- reserve.routes.ts: FOUND
- internal-billing.test.ts: FOUND
- 05-02-SUMMARY.md: FOUND
- commit fd427aa: FOUND
- commit 0f18d28: FOUND

---
*Phase: 05-internal-auth-and-reserve*
*Completed: 2026-04-02*
