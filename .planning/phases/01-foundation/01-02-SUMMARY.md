---
phase: 01-foundation
plan: 02
subsystem: api
tags: [fastify, drizzle, sqlite, zod, auth, agents, bearer-token, sha256, cursor-pagination]

requires:
  - phase: 01-01
    provides: drizzle-schema, fastify-app-factory, shared-types-id-generators, sqlite-client-wal

provides:
  - agent-registration-api
  - agent-query-api
  - agent-deposit-api
  - admin-auth-middleware
  - agent-auth-middleware
  - two-scope-bearer-auth
  - agent-balance-endpoint
  - agent-history-endpoint

affects:
  - 01-03 (policy engine will plug into agent auth scope)
  - 01-04 (payment routes use agent auth middleware)
  - all subsequent agent-facing features

tech-stack:
  added: []
  patterns:
    - buildApp(injectedDb?) factory — optional db injection for test isolation via app.db decorator
    - agentAuth uses request.server.db (not direct import) for testability
    - Vitest env config sets env vars before ESM config module evaluates
    - Cursor pagination: WHERE id > cursor ORDER BY id ASC LIMIT n+1, has_more = len > n
    - Balance derived from SUM(ledger_entries.amount_msat) — never a mutable counter
    - Deny-all policy (0/0 msat limits) created atomically with agent registration
    - AGENT_REGISTERED audit log entry inserted at registration time
    - timingSafeEqual for both admin token and agent token comparison

key-files:
  created:
    - src/modules/tokens/tokens.service.ts
    - src/modules/agents/agents.repo.ts
    - src/modules/agents/agents.service.ts
    - src/middleware/adminAuth.ts
    - src/middleware/agentAuth.ts
    - src/routes/admin/agents.routes.ts
    - src/routes/admin/deposit.routes.ts
    - src/routes/agent/balance.routes.ts
    - src/routes/agent/history.routes.ts
    - tests/modules/agents.test.ts
    - vitest.config.ts
  modified:
    - src/app.ts

key-decisions:
  - "buildApp() accepts optional injected db to enable test isolation — routes use app.db decorator"
  - "agentAuth reads db from request.server.db (not direct import) for same testability reason"
  - "vitest.config.ts sets VAULTWARDEN_ADMIN_TOKEN before ESM module graph loads (config.ts evaluates at import)"
  - "Deposit and audit log inserted atomically in db.transaction() to prevent partial state"
  - "Agent scope enforcement in agentAuth hook: if :id param exists and mismatches authenticated agent, return 403"

requirements-completed: [AGNT-01, AGNT-02, AGNT-03, AGNT-04, AGNT-05, SEC-01, SEC-03]

duration: 7min
completed: 2026-02-26
---

# Phase 1 Plan 2: Agent Management API Summary

**Two-scope bearer auth (admin VAULTWARDEN_ADMIN_TOKEN + agent vtk_ tokens) with full agent CRUD, deposit, balance, and cursor-paginated history — 11 integration tests, all green.**

## Performance

- **Duration:** ~7 minutes
- **Started:** 2026-02-26T14:21:30Z
- **Completed:** 2026-02-26T14:28:30Z
- **Tasks:** 2
- **Files modified:** 12 (11 created, 1 modified)

## Accomplishments

- Complete agent management API: registration, list, get-by-id, policy update, deposit, balance, history
- Two-scope auth: admin (`VAULTWARDEN_ADMIN_TOKEN` with `timingSafeEqual`) and agent (`vtk_` tokens via SHA-256 hash lookup)
- Agent identity scoping enforced in `agentAuth` hook — agents get 403 when accessing another agent's `:id`
- In-memory SQLite test isolation via `buildApp(injectedDb)` pattern — 11 integration tests covering all endpoints and auth paths
- Balance derived from `SUM(ledger_entries.amount_msat)` — never a mutable counter

## Task Commits

1. **Task 1: Token service, agent repo/service, and auth middleware** — `efc4179` (feat)
2. **Task 2: Admin and agent API routes with Zod schemas, plus agent management tests** — `3ff960e` (feat)

## Files Created/Modified

- `src/modules/tokens/tokens.service.ts` — generateToken(), hashToken(), verifyTokenConstantTime()
- `src/modules/agents/agents.repo.ts` — CRUD + cursor pagination + token hash lookup + balance query
- `src/modules/agents/agents.service.ts` — register (with deny-all policy + audit log), list, getById, updatePolicy
- `src/middleware/adminAuth.ts` — timing-safe admin token validation, 401 on any failure
- `src/middleware/agentAuth.ts` — vtk_ token auth, identity injection, agent-owns-resource 403 enforcement
- `src/routes/admin/agents.routes.ts` — POST /agents, GET /agents, GET /agents/:id, PUT /agents/:id/policy
- `src/routes/admin/deposit.routes.ts` — POST /agents/:id/deposit (atomic ledger + audit)
- `src/routes/agent/balance.routes.ts` — GET /agents/:id/balance (SUM of ledger)
- `src/routes/agent/history.routes.ts` — GET /agents/:id/history (cursor-paginated audit log with filters)
- `src/app.ts` — updated: registers all route plugins, accepts optional db for injection
- `tests/modules/agents.test.ts` — 11 integration tests (in-memory SQLite)
- `vitest.config.ts` — env vars set before ESM module graph loads

## Decisions Made

- **DB injection via decorator:** `buildApp(injectedDb?)` decorates app with `app.db`; routes and middleware use this instead of importing db directly — enables clean test isolation without module mocking
- **vitest.config.ts env:** ESM config modules evaluate at import time (before test file body runs), so env vars must be set in vitest config, not in test file
- **Deposit transaction:** Ledger entry + audit log inserted in `db.transaction()` — both succeed or both fail, no partial deposit state possible
- **Agent scope in agentAuth hook:** Hook runs before route handler; checks `request.params.id` against authenticated agent id — returns 403 before any data is accessed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Drizzle query type error in agents.repo.ts list() method**
- **Found during:** Task 1 (TypeScript check)
- **Issue:** Conditional reassignment of a Drizzle query builder variable caused TS2741 type error — the `where` method was missing from the inferred type when reassigning
- **Fix:** Used ternary expression to build two separate complete query chains instead of reassigning
- **Files modified:** src/modules/agents/agents.repo.ts
- **Verification:** `npx tsc --noEmit` exits 0
- **Committed in:** efc4179 (Task 1 commit)

**2. [Rule 3 - Blocking] Added vitest.config.ts to fix test env bootstrap**
- **Found during:** Task 2 (test run)
- **Issue:** All admin auth checks were returning 401 in tests — `config.ts` evaluates `process.env` at import time (ESM module graph) before test file body sets the env var; `VAULTWARDEN_ADMIN_TOKEN` was undefined, failing Zod validation
- **Fix:** Created `vitest.config.ts` with `test.env` block setting `VAULTWARDEN_ADMIN_TOKEN` and `NODE_ENV` — Vitest sets these before the module graph loads
- **Files modified:** vitest.config.ts (new)
- **Verification:** All 11 tests pass
- **Committed in:** 3ff960e (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both auto-fixes necessary for correctness and test function. No scope creep.

## Issues Encountered

None beyond the auto-fixed deviations above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Agent management API complete and tested — all subsequent plans can authenticate as admin or agent
- `app.db` decorator pattern established for future route modules
- Policy engine (01-03) can plug directly into agentService.getById() for policy evaluation
- Lightning payment routes (01-04) can add agentAuth hook and call agentsService directly

## Self-Check: PASSED

All created files verified to exist. Both commits verified in git log.
