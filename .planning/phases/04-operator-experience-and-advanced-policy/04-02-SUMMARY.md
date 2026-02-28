---
phase: 04-operator-experience-and-advanced-policy
plan: 02
subsystem: approvals
tags: [approvals, operator, policy, PLCY-06, PLCY-07, CAS, webhook]
dependency_graph:
  requires:
    - 04-01  # policy_versions table, webhookService, policyVersionsRepo
  provides:
    - approvalsRepo (CRUD for pending_approvals with atomic CAS)
    - approvalsService (createApproval, resolveApproval, expireTimedOut)
    - adminApprovalsRoutes (POST /operator/approvals/:id/approve, /deny; GET /operator/approvals)
    - REQUIRE_HUMAN_APPROVAL activated in payments.service
    - PENDING_APPROVAL status in payment-status route
    - Approval timeout checker in index.ts
  affects:
    - src/modules/payments/payments.service.ts (REQUIRE_HUMAN_APPROVAL path + PENDING_APPROVAL status)
    - src/routes/agent/payment-status.routes.ts (PENDING_APPROVAL disambiguation)
    - src/routes/agent/payments.routes.ts (PENDING_APPROVAL in Zod schema)
    - src/modules/policy/policy.engine.ts (REQUIRE_HUMAN_APPROVAL for exceeds_max_transaction)
    - src/modules/audit/audit.repo.ts (approval action types extended)
    - src/modules/agents/agents.repo.ts (null propagation for optional policy fields)
tech_stack:
  added: []
  patterns:
    - CAS (Compare-And-Swap) via WHERE status='pending' UPDATE to prevent race conditions
    - Atomic RESERVE + pending_approvals in single IMMEDIATE transaction
    - Fail-closed approval evaluation: null approval_timeout_ms = no approval configured
key_files:
  created:
    - src/modules/approvals/approvals.repo.ts
    - src/modules/approvals/approvals.service.ts
    - src/routes/admin/approvals.routes.ts
    - tests/unit/approvals.test.ts
  modified:
    - src/modules/payments/payments.service.ts
    - src/modules/policy/policy.engine.ts
    - src/modules/audit/audit.repo.ts
    - src/modules/agents/agents.repo.ts
    - src/routes/agent/payment-status.routes.ts
    - src/routes/agent/payments.routes.ts
    - src/app.ts
    - src/index.ts
decisions:
  - "REQUIRE_HUMAN_APPROVAL activated only when approval_timeout_ms > 0 in policy — null = DENY (not approval)"
  - "Atomic RESERVE + pending_approvals in single IMMEDIATE transaction prevents crash-split state"
  - "CAS claimForResolution prevents double-resolve race between concurrent approve/deny/timeout"
  - "expireTimedOut runs in index.ts setInterval (not buildApp) — keeps tests unaffected by timer"
  - "policyVersionsRepo.insertVersion uses null (not undefined) for unset optional fields — prevents SQLite DEFAULT(300_000) from silently enabling approval on all policies"
  - "approve route writes audit and fires webhook but delegates actual wallet execution to caller (approve means unblock, not auto-pay)"
  - "PENDING_APPROVAL disambiguation: query pending_approvals table only when ledger-derived status is PENDING"
metrics:
  duration: ~12 minutes
  completed_date: "2026-02-28"
  tasks_completed: 2
  files_modified: 12
---

# Phase 04 Plan 02: Approval Lifecycle Summary

**One-liner:** Full REQUIRE_HUMAN_APPROVAL lifecycle with atomic RESERVE+pending_approvals, CAS-protected operator approve/deny endpoints, auto-timeout expiry, and PENDING_APPROVAL payment-status disambiguation.

## What Was Built

### Task 1: Approvals repo, service, and REQUIRE_HUMAN_APPROVAL payment path

**approvalsRepo** (`src/modules/approvals/approvals.repo.ts`):
- `create`: Inserts pending_approvals row, returns inserted row
- `findById`: Lookup by primary key
- `findByTransactionId`: Used by payment-status disambiguation
- `claimForResolution`: Atomic CAS UPDATE — sets status=newStatus WHERE status='pending'. Returns undefined if already resolved.
- `findExpired`: Finds pending rows where expires_at <= now
- `countPending`: Count pending approvals per agent (for dashboard)
- `listPending`: All pending approvals (for operator dashboard)

**approvalsService** (`src/modules/approvals/approvals.service.ts`):
- `createApproval`: IMMEDIATE tx writes RESERVE + pending_approvals + APPROVAL_REQUESTED audit; fires approval_required webhook
- `resolveApproval`: CAS claim → if denied: writes RELEASE + APPROVAL_DENIED audit + webhook; if approved: writes APPROVAL_GRANTED audit
- `expireTimedOut`: Polls findExpired, CAS claims as timed_out, writes RELEASE + APPROVAL_TIMEOUT audit, fires webhook

**Policy engine update** (`src/modules/policy/policy.engine.ts`):
- `PolicyConfig.approval_timeout_ms?: number | null` field added
- Check 3 (exceeds_max_transaction): returns REQUIRE_HUMAN_APPROVAL instead of DENY when approval_timeout_ms > 0

**Payment service update** (`src/modules/payments/payments.service.ts`):
- REQUIRE_HUMAN_APPROVAL path intercepts before generic DENY
- Writes atomic RESERVE + pending_approvals + audit in single IMMEDIATE transaction
- Fires approval_required webhook non-blocking
- Returns `{ status: 'PENDING_APPROVAL', policy_decision: 'REQUIRE_HUMAN_APPROVAL' }`
- Added PENDING_APPROVAL to PaymentResponse status union

### Task 2: Operator approve/deny routes, payment-status update, timeout checker, app wiring, and tests

**adminApprovalsRoutes** (`src/routes/admin/approvals.routes.ts`):
- `POST /operator/approvals/:id/approve`: findById → 404; claimForResolution → 409 if conflict; write APPROVAL_GRANTED audit; fire webhook; return 200
- `POST /operator/approvals/:id/deny`: Same pattern; writes RELEASE + APPROVAL_DENIED audit
- `GET /operator/approvals?status=pending|all`: Lists approvals for operator dashboard

**Payment-status route** (`src/routes/agent/payment-status.routes.ts`):
- Added PENDING_APPROVAL to response Zod schema
- After determining PENDING status from ledger: queries pending_approvals table for transaction_id with status='pending'. If found, returns PENDING_APPROVAL. Prevents confusion between Lightning in-flight PENDING and human-approval-waiting PENDING_APPROVAL.

**App wiring**:
- `src/app.ts`: Registers adminApprovalsRoutes
- `src/index.ts`: setInterval every 30s calling approvalsService.expireTimedOut; cleared on onClose hook

**agents.repo.ts fix**: policyVersionsRepo.insertVersion now explicitly passes `null` (not `undefined`) for unset optional fields, preventing SQLite DEFAULT(300_000) from silently enabling approval on policies that don't explicitly configure it.

**7 passing tests** in `tests/unit/approvals.test.ts`:
1. Over-limit payment with approval_timeout_ms -> PENDING_APPROVAL
2. Operator approve -> approved state
3. Operator deny -> RELEASE written, balance restored, status FAILED
4. Double-resolve -> 409 Conflict (CAS works)
5. Payment status returns PENDING_APPROVAL (not PENDING)
6. expireTimedOut -> timed_out status, RELEASE written, balance restored
7. No approval_timeout_ms -> DENY (not PENDING_APPROVAL)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript type narrowing on denyOutcome variable**
- **Found during:** Task 1 implementation
- **Issue:** TypeScript narrowed `let denyOutcome: PolicyOutcome = 'DENY'` to literal type `'DENY'` (callback assignment not tracked by control flow), making `denyOutcome === 'REQUIRE_HUMAN_APPROVAL'` report as always false
- **Fix:** Added explicit cast `(denyOutcome as PolicyOutcome) === 'REQUIRE_HUMAN_APPROVAL'`
- **Files modified:** `src/modules/payments/payments.service.ts`
- **Commit:** 57cc216

**2. [Rule 1 - Bug] Pre-existing Db/DB type mismatch in payments.service.ts**
- **Found during:** Task 1 TypeScript check
- **Issue:** `tx as unknown as Db` (narrow) passed to `policyVersionsRepo.getVersionAt` which expects `DB` (full-schema) — pre-existing since Plan 01
- **Fix:** Changed cast to `tx as unknown as DB`
- **Files modified:** `src/modules/payments/payments.service.ts`
- **Commit:** 57cc216

**3. [Rule 2 - Missing critical functionality] SQLite DEFAULT silently enabling approval on all policies**
- **Found during:** Task 2 test (Test 7: "payment without approval_timeout_ms returns FAILED")
- **Issue:** `policyVersionsRepo.insertVersion` passed `undefined` for optional fields, causing SQLite to use `DEFAULT(300_000)`. This meant every new policy version got `approval_timeout_ms = 300_000` even when not configured, making ALL over-limit payments route to PENDING_APPROVAL instead of DENY.
- **Fix:** Changed all optional fields in insertVersion to use `?? null` — explicitly stores NULL to prevent DEFAULT activation
- **Files modified:** `src/modules/agents/agents.repo.ts`
- **Commit:** 0cfc42e

**4. [Rule 2 - Missing critical functionality] Approval action types missing from audit.repo.ts AuditAction union**
- **Found during:** Task 1 TypeScript check
- **Issue:** AuditAction type did not include APPROVAL_REQUESTED, APPROVAL_GRANTED, APPROVAL_DENIED, APPROVAL_TIMEOUT (needed by approvals.service.ts)
- **Fix:** Added all approval action types plus WITHDRAWAL_REQUESTED, WITHDRAWAL_COMPLETED, WEBHOOK_DELIVERY_FAILED, BALANCE_ALERT to match schema
- **Files modified:** `src/modules/audit/audit.repo.ts`
- **Commit:** 57cc216

**5. [Rule 3 - Blocking] Zod schema in payments.routes.ts rejected PENDING_APPROVAL status**
- **Found during:** Task 1 TypeScript check
- **Issue:** payments.routes.ts Zod response schema had `status: z.enum(['SETTLED', 'PENDING', 'FAILED'])` which would reject PENDING_APPROVAL responses
- **Fix:** Added PENDING_APPROVAL to the enum
- **Files modified:** `src/routes/agent/payments.routes.ts`
- **Commit:** 57cc216

### Test Strategy Adjustments

**Test 6 (timeout expiry)**: PATCH validation requires `approval_timeout_ms >= 30_000`, so 1ms timeout can't be set via API. Instead: submit payment with 30s timeout, then directly update `expires_at` to 1ms-ago in the test DB before calling `expireTimedOut`. This tests the actual timeout logic correctly without bypassing business constraints.

## Self-Check

### Files Exist
- [x] `src/modules/approvals/approvals.repo.ts` — created
- [x] `src/modules/approvals/approvals.service.ts` — created
- [x] `src/routes/admin/approvals.routes.ts` — created
- [x] `tests/unit/approvals.test.ts` — created

### Commits Exist
- [x] 57cc216 — Task 1: approvals repo, service, REQUIRE_HUMAN_APPROVAL path
- [x] 0cfc42e — Task 2: operator routes, payment-status, timeout checker, tests

### Tests Pass
- [x] 7 new approval tests pass
- [x] 101 total tests pass (1 pre-existing skip)
- [x] No regressions to existing test suite

## Self-Check: PASSED
