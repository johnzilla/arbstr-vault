---
phase: 04-operator-experience-and-advanced-policy
plan: 03
subsystem: payments
tags: [fastify, zod, drizzle, sqlite, alerts, webhooks, dashboard]

# Dependency graph
requires:
  - phase: 04-operator-experience-and-advanced-policy
    plan: 01
    provides: webhookService, policyVersionsRepo, agentsRepo with alert_floor/cooldown fields
  - phase: 04-operator-experience-and-advanced-policy
    plan: 02
    provides: approvalsRepo.create, approvalsRepo.countPending, approvalsService

provides:
  - POST /agents/:id/withdrawals — agent withdrawal request with policy check and approval queue
  - GET /operator/dashboard — per-agent financial state snapshot with all Phase 4 fields
  - alertsService.checkAndNotify — balance alert with per-agent cooldown tracking
  - Post-settlement balance alert hooks in all three SETTLED paths (lightning, cashu, simulated)

affects:
  - Any future phase adding settlement or balance-changing operations (must call alertsService.checkAndNotify)
  - Any phase adding new agent-facing financial operations (withdrawal pattern)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Fire-and-forget async checks after synchronous DB transactions (.catch(() => {}))
    - In-memory cooldown map with module singleton for rate-limiting webhook delivery
    - N+1 query pattern accepted at personal-use scale (10-50 agents) per documented research decision
    - Policy check gate before approval queue — DENY prevents queue entry, ALLOW still routes to approval

key-files:
  created:
    - src/routes/agent/withdrawals.routes.ts
    - src/routes/admin/dashboard.routes.ts
    - src/modules/alerts/alerts.service.ts
    - tests/unit/withdrawals-dashboard.test.ts
  modified:
    - src/modules/payments/payments.service.ts
    - src/modules/audit/audit.repo.ts
    - src/app.ts

key-decisions:
  - "Withdrawals always enter approval queue regardless of ALLOW policy outcome (locked decision from PLAN.md)"
  - "Policy DENY (exceeds daily_limit_msat etc.) prevents withdrawal from entering queue — Research Pitfall 6"
  - "Alert cooldown tracked in-memory Map (not DB) — restarts reset cooldowns, acceptable for personal-use"
  - "N+1 queries in dashboard are acceptable at personal-use scale (10-50 agents, sub-ms each on SQLite)"
  - "getLastPaymentTimestamp added to auditRepo as helper — cleaner than inline query in dashboard route"
  - "daily_utilization_pct uses Math.round — 12.5% rounds to 13% (JavaScript rounding behavior confirmed in tests)"

patterns-established:
  - "Pattern 1: Withdrawal as approval — same approvalsRepo.create with type='withdrawal'; approve route pays BOLT11"
  - "Pattern 2: Post-settlement hooks — alertsService.checkAndNotify after each SETTLED transaction block"
  - "Pattern 3: Dashboard aggregation — per-agent N+1 queries accepted at personal scale per research"

requirements-completed: [PAY-07, OBSV-06, OBSV-07]

# Metrics
duration: 7min
completed: 2026-02-28
---

# Phase 4 Plan 3: Operator Control Plane Summary

**Agent withdrawal requests via BOLT11 invoice with policy gate, balance floor alerts with cooldown, and per-agent operator dashboard (PAY-07, OBSV-06, OBSV-07)**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-28T04:18:40Z
- **Completed:** 2026-02-28T04:26:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- POST /agents/:id/withdrawals: policy-checked, creates RESERVE + pending_approvals with type='withdrawal', fires webhook
- alertsService with per-agent in-memory cooldown tracks balance_floor alerts post-settlement across all three rails
- GET /operator/dashboard: per-agent snapshots with balance, daily spend, utilization %, pending count, policy, last payment, floor alert; sortable by balance/daily_spend/name
- 11 new tests all pass; 112 total tests pass with no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Withdrawal endpoint, balance alert service, and post-settlement alert check** - `f45fa6d` (feat)
2. **Task 2: Operator dashboard endpoint, app wiring, and comprehensive tests** - `78be19e` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified
- `src/routes/agent/withdrawals.routes.ts` - POST /agents/:id/withdrawals with policy gate and approval queue entry
- `src/modules/alerts/alerts.service.ts` - Balance alert service with in-memory cooldown Map
- `src/modules/payments/payments.service.ts` - Added alertsService.checkAndNotify after all three SETTLED paths
- `src/routes/admin/dashboard.routes.ts` - GET /operator/dashboard with per-agent aggregated snapshots
- `src/modules/audit/audit.repo.ts` - Added getLastPaymentTimestamp helper and inArray import
- `src/app.ts` - Registered agentWithdrawalRoutes and adminDashboardRoutes
- `tests/unit/withdrawals-dashboard.test.ts` - 11 tests covering withdrawals, alerts, and dashboard

## Decisions Made
- Withdrawals always enter approval queue regardless of policy outcome — ALLOW still routes to PENDING_APPROVAL (locked decision from plan frontmatter)
- Policy DENY gates the queue — amounts exceeding daily_limit_msat are rejected before creating approval row
- Alert cooldown in-memory Map accepted (not DB-persisted) — process restarts reset cooldowns, fine for personal use
- dashboard_utilization_pct uses Math.round: 10000/80000*100 = 12.5 rounds to 13 per JS behavior

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added getLastPaymentTimestamp helper to auditRepo**
- **Found during:** Task 2 (dashboard route implementation)
- **Issue:** Plan suggested inline query or new helper for last_payment_at; added as clean helper method
- **Fix:** Added `getLastPaymentTimestamp(db, agentId)` to auditRepo with inArray filter on PAYMENT_SETTLED/PAYMENT_FAILED
- **Files modified:** src/modules/audit/audit.repo.ts
- **Verification:** Dashboard test 8 verifies last_payment_at is populated after payment
- **Committed in:** 78be19e (Task 2 commit)

**2. [Rule 1 - Bug] Fixed test expectation for deny-all policy (403 vs 400)**
- **Found during:** Task 2 (test execution)
- **Issue:** Test 3 expected 403 (no_policy_configured) but agents always get a deny-all default policy on registration — so getCurrent returns non-null and policy evaluation returns DENY (deny_all_policy) with 400
- **Fix:** Updated test 3 to test the deny-all policy scenario instead (400 with deny_all_policy code)
- **Files modified:** tests/unit/withdrawals-dashboard.test.ts
- **Verification:** Test 3 now passes correctly
- **Committed in:** 78be19e (Task 2 commit)

**3. [Rule 1 - Bug] Fixed alertCooldownMs validation constraint**
- **Found during:** Task 2 (test execution)
- **Issue:** Test 5 used alertCooldownMs: 1_000 which fails API validation (min: 60_000 per agents.routes.ts schema)
- **Fix:** Changed to alertCooldownMs: 60_000 (minimum allowed)
- **Files modified:** tests/unit/withdrawals-dashboard.test.ts
- **Verification:** Test 5 passes and alert fires correctly
- **Committed in:** 78be19e (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 bug fixes, 1 missing helper)
**Impact on plan:** All fixes were necessary for correctness. No scope creep.

## Issues Encountered
- Cashu test 13 showed intermittent failure when run in full suite — confirmed as pre-existing flakiness unrelated to this plan's changes (passes consistently when run in isolation or fresh suite runs)

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 4 is complete — all 3 plans executed
- Full operator control plane: policy versioning, approval lifecycle, withdrawal requests, balance alerts, operator dashboard
- Requirements PAY-07, OBSV-06, OBSV-07 satisfied
- Project milestone v1.0 complete

---
*Phase: 04-operator-experience-and-advanced-policy*
*Completed: 2026-02-28*
