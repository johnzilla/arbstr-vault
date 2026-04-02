---
phase: 05-internal-auth-and-reserve
plan: 01
subsystem: auth
tags: [fastify, middleware, crypto, timingSafeEqual, config, zod]

requires: []
provides:
  - "internalAuth Fastify onRequest hook (src/middleware/internalAuth.ts)"
  - "VAULT_INTERNAL_TOKEN optional config field with min 32 char validation"
  - "X-Internal-Token header-based authentication for /internal/* routes"
affects: [05-02-reserve-route, any plan adding /internal/* routes]

tech-stack:
  added: []
  patterns:
    - "Mirror adminAuth.ts pattern for new middleware: timingSafeEqual, same error shape"
    - "Optional config fields with min-length validation for security-sensitive tokens"

key-files:
  created:
    - src/middleware/internalAuth.ts
    - tests/unit/internal-auth.test.ts
  modified:
    - src/config.ts
    - .env.example

key-decisions:
  - "VAULT_INTERNAL_TOKEN is optional in config so service starts normally without it; internal routes simply return 401 when unconfigured"
  - "Uses X-Internal-Token header (not Authorization/Bearer) to distinguish from agent/admin auth"
  - "When token unconfigured, middleware returns 401 immediately (fail-closed)"

patterns-established:
  - "New middleware pattern: mirror adminAuth.ts with different header and config field"

requirements-completed: [IAUTH-01, IAUTH-02]

duration: 8min
completed: 2026-04-02
---

# Phase 05 Plan 01: Internal Auth Middleware Summary

**Fastify internalAuth middleware using X-Internal-Token header and constant-time timingSafeEqual, with optional VAULT_INTERNAL_TOKEN config field gating /internal/* routes**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-02T18:16:00Z
- **Completed:** 2026-04-02T18:17:30Z
- **Tasks:** 1 (TDD)
- **Files modified:** 4

## Accomplishments
- Created `src/middleware/internalAuth.ts` mirroring adminAuth.ts pattern with X-Internal-Token header
- Added optional `VAULT_INTERNAL_TOKEN` field (min 32 chars) to config schema
- Updated `.env.example` to document the new optional env var
- 9 unit tests covering all auth cases (valid token, missing, wrong, empty, unconfigured) and config validation

## Task Commits

Each task was committed atomically:

1. **Task 1: Add VAULT_INTERNAL_TOKEN to config and create internalAuth middleware** - `9a4f2f8` (feat)

**Plan metadata:** (docs commit follows)

_Note: TDD task — tests written first (RED), then implementation (GREEN), both in single atomic commit_

## Files Created/Modified
- `src/middleware/internalAuth.ts` - Internal auth onRequest hook using X-Internal-Token header with timingSafeEqual
- `src/config.ts` - Added optional VAULT_INTERNAL_TOKEN z.string().min(32).optional() field
- `.env.example` - Documented VAULT_INTERNAL_TOKEN with usage comment
- `tests/unit/internal-auth.test.ts` - 9 unit tests (5 middleware + 4 config schema tests)

## Decisions Made
- Used optional config field so service boots without internal auth configured; routes individually gated
- Fail-closed: if VAULT_INTERNAL_TOKEN is undefined, all requests to internalAuth-gated routes get 401

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None — tests, implementation, and integration all passed cleanly.

## User Setup Required
None - no external service configuration required. `VAULT_INTERNAL_TOKEN` is optional.

## Next Phase Readiness
- `internalAuth` middleware is ready for Plan 05-02 to apply as `preHandler` on the reserve route
- No blockers

---
*Phase: 05-internal-auth-and-reserve*
*Completed: 2026-04-02*
