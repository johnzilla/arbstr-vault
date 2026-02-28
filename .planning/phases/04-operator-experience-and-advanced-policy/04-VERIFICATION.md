---
phase: 04-operator-experience-and-advanced-policy
verified: 2026-02-28T17:36:00Z
status: passed
score: 12/12 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 11/12
  gaps_closed:
    - "Operator can approve via POST /operator/approvals/:id/approve — payment proceeds through the wallet and settles"
  gaps_remaining: []
  regressions: []
human_verification: []
---

# Phase 04: Operator Experience and Advanced Policy Verification Report

**Phase Goal:** Operators have full visibility and control over all agents — including human approval for over-limit transactions, versioned policy history, balance alerts, and a complete operator dashboard endpoint
**Verified:** 2026-02-28T17:36:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure plan 04-04 (executeApprovedPayment RESERVE+RELEASE+PAYMENT pattern)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Policy changes create new version rows with effective_from timestamps — old versions are never deleted | VERIFIED | `policyVersionsRepo.insertVersion` in agents.repo.ts always inserts; agents.service.ts `updatePolicy` appends to policy_versions. Test: "creates version 1 on first PATCH, version 2 on second PATCH" passes. |
| 2 | PATCH /operator/agents/:id/policy creates a new version and returns the version number | VERIFIED | agents.routes.ts registers `PATCH /operator/agents/:id/policy`; response schema includes `version: z.number()`. Test confirms version increments from 1 to 2. |
| 3 | Payment evaluation reads the policy version whose effective_from <= request timestamp, not the latest version | VERIFIED | payments.service.ts line 298: `requestTimestamp = Date.now()` captured before Phase 1 tx; line 336: `policyVersionsRepo.getVersionAt(tx, agentId, requestTimestamp)` — point-in-time lookup confirmed. Policy-versioning test 2 passes. |
| 4 | Webhook service exists and can POST JSON to a configured URL with HMAC-SHA256 signature and exponential backoff retry | VERIFIED | webhook.service.ts exports `webhookService` and `createWebhookService`. Uses `createHmac('sha256', secret)`, 3-retry loop with delays `[1000, 5000, 15000]`, 10s AbortSignal timeout. Substantive implementation — not a stub. |
| 5 | A payment that triggers REQUIRE_HUMAN_APPROVAL writes a RESERVE entry and creates a pending_approvals row, then returns status PENDING_APPROVAL | VERIFIED | payments.service.ts: REQUIRE_HUMAN_APPROVAL branch at line 399; IMMEDIATE tx writes RESERVE + approvalsRepo.create + APPROVAL_REQUESTED audit; returns `{ status: 'PENDING_APPROVAL' }`. Test 1 in approvals.test.ts passes. |
| 6 | Operator can approve via POST /operator/approvals/:id/approve — payment proceeds through the wallet and settles | VERIFIED | approvals.routes.ts line 81: `await app.paymentsService.executeApprovedPayment(...)` called after CAS claim and APPROVAL_GRANTED audit. payments.service.ts `executeApprovedPayment` (lines 144-259): calls `options.simulatedWallet.pay()`, on SETTLED writes PAYMENT + RELEASE + PAYMENT_SETTLED audit in IMMEDIATE tx, fires alertsService. Response schema: `payment_status: z.enum(['SETTLED', 'FAILED'])`. Test 2 verifies `payment_status: 'SETTLED'` and `balance_msat: 90_000`. Test 8 (gap closure) explicitly validates no RESERVE leak. All 8 approval tests pass. |
| 7 | Operator can deny via POST /operator/approvals/:id/deny — RELEASE is written and payment status becomes FAILED | VERIFIED | approvals.routes.ts deny handler calls `claimForResolution('denied')`, writes RELEASE + APPROVAL_DENIED audit in IMMEDIATE tx, fires webhook. Test 3 (deny) passes: balance restored to 100_000, status FAILED. |
| 8 | Pending approvals that exceed expires_at are automatically resolved to timed_out with RELEASE and APPROVAL_TIMEOUT audit | VERIFIED | approvals.service.ts `expireTimedOut` polls `findExpired`, CAS-claims as `timed_out`, writes RELEASE + APPROVAL_TIMEOUT in IMMEDIATE tx. index.ts setInterval calls it every 30s. Test 6 passes. |
| 9 | Agent polling GET /agents/:id/payments/:tx_id for an approval-pending payment sees PENDING_APPROVAL (not PENDING) | VERIFIED | payment-status.routes.ts: after determining PENDING from ledger, queries pending_approvals for transaction_id with status='pending'; if found, returns PENDING_APPROVAL. Test 5 passes. |
| 10 | Agent can submit a withdrawal request via POST /agents/:id/withdrawals — the withdrawal enters the approval queue and always requires operator approval | VERIFIED | withdrawals.routes.ts: policy evaluated, IMMEDIATE tx writes RESERVE + approvalsRepo.create(type='withdrawal') + WITHDRAWAL_REQUESTED audit; returns `{ status: 'PENDING_APPROVAL' }`. Test 1 (withdrawal) passes. |
| 11 | After each payment settles, the system checks if the agent's balance dropped below alert_floor_msat and fires a balance_alert webhook with cooldown | VERIFIED | alerts.service.ts `checkAndNotify` checks `alert_floor_msat`, cooldown via in-memory Map, writes BALANCE_ALERT audit, fires webhook. payments.service.ts calls it after all three SETTLED paths; executeApprovedPayment also calls it post-settlement (line 204). Tests 5-7 (alert) pass. |
| 12 | GET /operator/dashboard returns per-agent snapshots with balance, daily spend, daily utilization %, pending approvals count, active policy version, last payment timestamp, and balance below floor status | VERIFIED | dashboard.routes.ts aggregates via agentsRepo.list, ledgerRepo.getBalance/getDailySpend, policyVersionsRepo.getCurrent, approvalsRepo.countPending, auditRepo.getLastPaymentTimestamp. Response includes all required fields. Tests 8-11 (dashboard) pass. |

**Score:** 12/12 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/db/schema.ts` | policyVersions table with version, effective_from, approval_timeout_ms, alert_floor_msat, alert_cooldown_ms | VERIFIED | All columns present and confirmed in file. pendingApprovals table also present. auditLog enum extended with 8 Phase 4 actions. |
| `src/modules/webhook/webhook.service.ts` | Fire-and-forget webhook delivery with 3x retry and HMAC signing | VERIFIED | Exports `webhookService` and `createWebhookService`. Retry with delays [1000, 5000, 15000]. HMAC-SHA256 when secret configured. |
| `src/modules/agents/agents.repo.ts` | Point-in-time policy version lookup via policyVersionsRepo | VERIFIED | `policyVersionsRepo.getVersionAt` uses `lte(effective_from, new Date(timestamp)).orderBy(desc(effective_from)).limit(1)`. `getCurrent`, `insertVersion`, `countByAgent` all present. |
| `src/modules/approvals/approvals.repo.ts` | CRUD for pending_approvals table with atomic CAS updates | VERIFIED | Exports `approvalsRepo` with `create`, `findById`, `findByTransactionId`, `claimForResolution` (CAS WHERE status='pending'), `findExpired`, `countPending`, `listPending`. |
| `src/modules/approvals/approvals.service.ts` | Approval lifecycle: create, resolve (approve/deny), expire timed-out | VERIFIED | Exports `approvalsService` with `createApproval`, `resolveApproval`, `expireTimedOut`. All use IMMEDIATE transactions. |
| `src/modules/payments/payments.service.ts` | `executeApprovedPayment` method with RESERVE+RELEASE+PAYMENT triple-entry pattern | VERIFIED | Method exists at line 144. Calls `options.simulatedWallet.pay()`. On SETTLED: writes PAYMENT (-amountMsat) + RELEASE (+amountMsat) + PAYMENT_SETTLED audit in a single IMMEDIATE tx. On FAILED: writes RELEASE + PAYMENT_FAILED. Fail-closed outer try/catch. Post-settlement alertsService call at line 204. |
| `src/routes/admin/approvals.routes.ts` | POST /operator/approvals/:id/approve calls executeApprovedPayment and returns SETTLED/FAILED | VERIFIED | Line 81: `await app.paymentsService.executeApprovedPayment(app.db as unknown as DB, ...)`. Response schema `payment_status: z.enum(['SETTLED', 'FAILED'])`. Webhook payload includes `payment_status: executionResult.status`. |
| `src/routes/agent/withdrawals.routes.ts` | POST /agents/:id/withdrawals endpoint with policy check and approval queue entry | VERIFIED | Policy evaluated via `evaluatePolicy`; IMMEDIATE tx: RESERVE + approvalsRepo.create(type='withdrawal') + WITHDRAWAL_REQUESTED audit; returns PENDING_APPROVAL. |
| `src/routes/admin/dashboard.routes.ts` | GET /operator/dashboard with per-agent aggregated snapshots | VERIFIED | Full implementation with balance, daily_spend, utilization%, pending count, policy version, last_payment_at, balance_below_floor. Sorting by balance/daily_spend/name supported. |
| `src/modules/alerts/alerts.service.ts` | Balance alert check with per-agent cooldown tracking | VERIFIED | In-memory `lastAlertTime` Map, checks `alert_floor_msat` and `alert_cooldown_ms`, writes BALANCE_ALERT audit, fires webhook. `_resetCooldowns` helper for tests. |
| `tests/unit/policy-versioning.test.ts` | Tests for policy version creation, point-in-time reads, and payment evaluation with versioned policy | VERIFIED | 5 tests, all pass: version increments, point-in-time semantics, registration creates policy_versions v1, GET returns policy_versions, new fields preserved. |
| `tests/unit/approvals.test.ts` | 8 tests covering approval lifecycle including gap closure test | VERIFIED | 8 tests, all pass: PENDING_APPROVAL, approve (SETTLED + balance check + status check), deny, double-resolve 409, status disambiguation, expireTimedOut, no-approval=DENY, Test 8 explicit gap closure. |
| `tests/unit/withdrawals-dashboard.test.ts` | Tests for withdrawal flow, balance alerts, and dashboard response | VERIFIED | 11 tests, all pass: withdrawal PENDING_APPROVAL, daily limit deny, deny-all deny, RESERVE debit, alert fires, cooldown, no alert above floor, dashboard fields, pending count, sorting, below-floor. |
| `src/db/migrations/0003_watery_paibok.sql` | Migration for policy_versions and pending_approvals tables | VERIFIED | Both CREATE TABLE statements present with correct columns. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/routes/admin/approvals.routes.ts` | `src/modules/payments/payments.service.ts` | `app.paymentsService.executeApprovedPayment` | WIRED | Line 81: `await app.paymentsService.executeApprovedPayment(app.db as unknown as DB, claimed.agent_id, claimed.transaction_id, claimed.amount_msat, claimed.destination ?? null)`. Previously NOT WIRED — gap now closed. |
| `src/routes/admin/approvals.routes.ts` | `src/modules/ledger/ledger.repo.ts` | PAYMENT_SETTLED written after wallet settles (via executeApprovedPayment) | WIRED | `executeApprovedPayment` in payments.service.ts lines 193-200 writes `action: 'PAYMENT_SETTLED'` inside IMMEDIATE tx on SETTLED result. The route calls executeApprovedPayment which handles ledger writes internally. |
| `payments.service.ts` | `agents.repo.ts` | `policyVersionsRepo.getVersionAt(tx, agentId, requestTimestamp)` | WIRED | `import { agentsRepo, policyVersionsRepo }` at line 3; `policyVersionsRepo.getVersionAt(...)` called with requestTimestamp at line 336. |
| `routes/admin/agents.routes.ts` | `agents.service.ts` | `agentsService.updatePolicy` inserts into policy_versions | WIRED | agents.service.ts `updatePolicy` uses `policyVersionsRepo.insertVersion` in IMMEDIATE tx. PATCH route calls `agentsService.updatePolicy` and returns `version` field. |
| `payments.service.ts` | `approvals.repo.ts` | `approvalsRepo.create` in REQUIRE_HUMAN_APPROVAL branch | WIRED | `import { approvalsRepo }` at line 6; `approvalsRepo.create(tdb, {...})` inside IMMEDIATE tx in REQUIRE_HUMAN_APPROVAL block at line 417. |
| `src/index.ts` | `approvals.service.ts` | `setInterval` polls `expireTimedOut` | WIRED | index.ts imports `approvalsService`; `setInterval(() => approvalsService.expireTimedOut(db), 30_000)` with cleanup via `onClose` hook. |
| `withdrawals.routes.ts` | `approvals.repo.ts` | `approvalsRepo.create` with type='withdrawal' | WIRED | withdrawals.routes.ts imports `approvalsRepo`; `approvalsRepo.create(tdb, { type: 'withdrawal', ... })` in IMMEDIATE tx. |
| `payments.service.ts` | `alerts.service.ts` | `alertsService.checkAndNotify` post-settlement | WIRED | `import { alertsService }` at line 15; called after all three SETTLED paths (lines 652, 700, 724) and also inside `executeApprovedPayment` at line 204. |
| `dashboard.routes.ts` | `agents.repo.ts` | `agentsRepo.list` for dashboard aggregation | WIRED | dashboard.routes.ts imports `agentsRepo, policyVersionsRepo`; `agentsRepo.list(db, { limit: 1000 })` used for dashboard aggregation. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| PLCY-08 | 04-01 | Policy changes are versioned with effective-from timestamps | SATISFIED | `policyVersions` table in schema; `insertVersion` in agents.repo.ts; `updatePolicy` appends to policy_versions; test suite verifies version increments. |
| PLCY-09 | 04-01 | Policy evaluation uses the version active at payment request time | SATISFIED | `requestTimestamp = Date.now()` before Phase 1 tx; `getVersionAt(tx, agentId, requestTimestamp)` in payments.service.ts; point-in-time test passes. |
| PLCY-06 | 04-02 | Over-limit transactions route to pending state with operator notification | SATISFIED | REQUIRE_HUMAN_APPROVAL path: RESERVE + pending_approvals + APPROVAL_REQUESTED audit + webhook. Returns PENDING_APPROVAL. Approval execution now completes the full cycle: approved payments settle via executeApprovedPayment. |
| PLCY-07 | 04-02 | Pending approvals time out to DENY after configurable interval | SATISFIED | `expireTimedOut` in approvals.service.ts; CAS claim as 'timed_out'; RELEASE + APPROVAL_TIMEOUT audit; setInterval in index.ts. Test 6 (expire) passes. |
| PAY-07 | 04-03 | Agent can propose a withdrawal to a master wallet or external address | SATISFIED | POST /agents/:id/withdrawals; policy gate; RESERVE + pending_approvals(type='withdrawal') + WITHDRAWAL_REQUESTED audit; returns PENDING_APPROVAL. |
| OBSV-06 | 04-03 | Per-agent configurable balance alert threshold that notifies operator when balance drops below floor | SATISFIED | alertsService.checkAndNotify checks alert_floor_msat with cooldown; writes BALANCE_ALERT audit; fires balance_alert webhook. Called after all settlement paths including executeApprovedPayment (line 204). |
| OBSV-07 | 04-03 | Operator can view all agents, their balances, recent spend, policy state, and daily utilization via API | SATISFIED | GET /operator/dashboard returns agents array with balance_msat, daily_spend_msat, daily_utilization_pct, pending_approvals_count, policy (with version), last_payment_at, balance_below_floor, sort support. |

All 7 requirement IDs declared across the four plans are accounted for. No orphaned requirements mapped to Phase 4 in REQUIREMENTS.md traceability table that are absent from the plans.

### Anti-Patterns Found

None. The approve-without-wallet-execution blocker from the initial verification has been resolved. No new anti-patterns detected in the modified files.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | — | — | — |

### Human Verification Required

None. All automated checks are sufficient for this phase. The gap closure is fully verifiable programmatically: `executeApprovedPayment` exists, is called from the approve route, writes the correct ledger entries, and 8 integration tests (including an explicit gap closure test) confirm the expected balance and settlement behavior.

### Re-Verification: Gap Closure Summary

**Gap closed:** "Operator can approve via POST /operator/approvals/:id/approve — payment proceeds through the wallet and settles"

**What was added (plan 04-04):**

1. `executeApprovedPayment` method in `src/modules/payments/payments.service.ts` (lines 144-259):
   - Calls `options.simulatedWallet.pay()` with the approval's transaction details
   - On SETTLED: writes PAYMENT (-amountMsat) + RELEASE (+amountMsat) + PAYMENT_SETTLED audit atomically in IMMEDIATE tx
   - On FAILED: writes RELEASE (+amountMsat) + PAYMENT_FAILED audit (restores reserved balance)
   - Fail-closed outer try/catch: any unexpected error writes RELEASE + PAYMENT_FAILED and returns FAILED
   - Post-settlement: fires `alertsService.checkAndNotify` fire-and-forget

2. Approve route in `src/routes/admin/approvals.routes.ts` wired to call `executeApprovedPayment` (line 81):
   - Response schema changed from `payment_status: z.enum(['APPROVED'])` to `z.enum(['SETTLED', 'FAILED'])`
   - Webhook payload now includes actual wallet execution outcome

3. `tests/unit/approvals.test.ts` updated:
   - Test 2 now verifies `payment_status: 'SETTLED'`, `balance_msat: 90_000`, and payment status route returns `'SETTLED'`
   - Test 4 updated to expect `payment_status: 'SETTLED'` on first approve
   - Test 8 added: explicit gap closure test validates the full RESERVE+RELEASE+PAYMENT triple-entry ledger sequence

**Net ledger effect for settled approved payment:**
```
RESERVE (written at PENDING_APPROVAL):  -amount_msat
RELEASE (written at executeApprovedPayment):  +amount_msat
PAYMENT (written at executeApprovedPayment):  -amount_msat
Net:  -amount_msat  (correct — agent spent the payment amount)
```

**Regressions:** None. Full test suite: 113 passed, 1 skipped, 0 failed. TypeScript: 0 errors.

---

_Verified: 2026-02-28T17:36:00Z_
_Verifier: Claude (gsd-verifier)_
_Re-verification after: plan 04-04 gap closure_
