---
phase: 04-operator-experience-and-advanced-policy
plan: "04"
subsystem: payments-approval
tags: [approval-execution, ledger, wallet, gap-closure]
dependency_graph:
  requires: ["04-02"]
  provides: ["executeApprovedPayment", "approval-settlement-verification"]
  affects: ["src/modules/payments/payments.service.ts", "src/routes/admin/approvals.routes.ts", "tests/unit/approvals.test.ts"]
tech_stack:
  added: []
  patterns: ["RESERVE+RELEASE+PAYMENT triple-entry", "fail-closed async execution", "wallet-injection via decorator"]
key_files:
  created: []
  modified:
    - src/modules/payments/payments.service.ts
    - src/routes/admin/approvals.routes.ts
    - tests/unit/approvals.test.ts
decisions:
  - "RESERVE+RELEASE+PAYMENT triple-entry pattern for approved payments: avoids upgrading existing RESERVE entry type; RELEASE cancels hold, PAYMENT is actual debit"
  - "executeApprovedPayment uses options.simulatedWallet directly; approval was created in simulated mode so simulated wallet is always correct for execution"
  - "Wallet call exceptions caught at inner try/catch level and treated as FAILED (not re-thrown to outer catch), to avoid double RELEASE"
  - "TransactionId branded type cast required when passing stored transactionId string to wallet PaymentRequest"
metrics:
  duration: "3 minutes"
  completed_date: "2026-02-28"
  tasks_completed: 2
  files_modified: 3
---

# Phase 04 Plan 04: Approval Execution Gap Closure Summary

**One-liner:** Closed the approval execution gap by adding `executeApprovedPayment` (RESERVE+RELEASE+PAYMENT triple-entry) that fires the wallet payment after operator approval, writing a verified PAYMENT_SETTLED ledger sequence rather than leaving a leaked RESERVE.

## What Was Built

### Task 1: executeApprovedPayment method + approve route wiring

**`src/modules/payments/payments.service.ts`** — Added `executeApprovedPayment` alongside `processPayment` inside the `createPaymentsService` factory return:

- Calls `options.simulatedWallet.pay()` with a wallet request constructed from the approval's `transactionId`, `amountMsat`, and `destination`
- On SETTLED: writes three ledger entries atomically in a single IMMEDIATE transaction:
  - PAYMENT: `-amountMsat` (actual debit) — new auto-generated id, not `transactionId` (RESERVE owns that)
  - RELEASE: `+amountMsat` (cancels the original RESERVE hold)
  - PAYMENT_SETTLED audit: `{ approval_execution: true }`
- On FAILED: writes RELEASE + PAYMENT_FAILED audit (restores reserved balance, net = 0)
- Fail-closed: any unexpected exception writes RELEASE + PAYMENT_FAILED and returns FAILED
- Post-settlement: fires `alertsService.checkAndNotify` fire-and-forget (OBSV-06)

**Net ledger effect for settled approval:**
```
RESERVE (written at PENDING_APPROVAL):  -amount_msat
RELEASE (written at executeApproved):   +amount_msat
PAYMENT (written at executeApproved):   -amount_msat
Net:                                    -amount_msat  (correct — agent spent the funds)
```

**`src/routes/admin/approvals.routes.ts`** — Updated the POST `/operator/approvals/:id/approve` handler:

- Added `import type * as schema from '../../db/schema.js'` and `type DB` for full-schema typing
- After APPROVAL_GRANTED audit, calls `app.paymentsService.executeApprovedPayment(...)` with `app.db as unknown as DB`
- Response schema changed: `payment_status: z.enum(['APPROVED'])` → `z.enum(['SETTLED', 'FAILED'])`
- Response body and webhook payload now include `executionResult.status` (actual wallet outcome)

### Task 2: Approval test updates

**`tests/unit/approvals.test.ts`** — Updated and extended the test suite:

- **Test 2** updated: asserts `payment_status: 'SETTLED'` (not `'APPROVED'`), verifies balance is `90_000` after approval, and confirms payment status route returns `'SETTLED'`
- **Test 4** updated: asserts `payment_status: 'SETTLED'` on first approve (before the 409 double-resolve check)
- **Test 8** added: explicit gap closure verification
  1. Deposit 100_000, set policy, submit 10_000 payment → PENDING_APPROVAL
  2. Balance before approve: 90_000 (RESERVE active)
  3. Approve → payment_status: SETTLED
  4. Balance after approve: still 90_000 (RELEASE+PAYMENT net = same as RESERVE)
  5. Payment status route: SETTLED

All 8 approval tests pass. Full suite: 113 passed / 1 skipped / 0 failed.

## Decisions Made

1. **RESERVE+RELEASE+PAYMENT triple-entry pattern** (not RESERVE upgrade): Avoids fragile mutation of existing entry type. RELEASE cancels the hold cleanly; PAYMENT is the canonical debit. Mirrors deny/timeout paths (RELEASE only).

2. **No explicit `id` on PAYMENT entry**: The RESERVE entry already owns `id = transactionId`. If PAYMENT tried to reuse the same id, it would hit a UNIQUE constraint. Drizzle auto-generates the PAYMENT entry's id.

3. **Inner try/catch for wallet call**: Wallet exceptions caught at inner level and converted to a `FAILED` PaymentResult. This prevents the outer catch from executing (which would attempt a duplicate RELEASE if the inner path had already started).

4. **`TransactionId` branded cast**: The `transactionId` parameter on `executeApprovedPayment` is `string` (comes from the approval row). The wallet `PaymentRequest.transaction_id` is `TransactionId = `tx_${string}`` branded. Cast via `transactionId as TransactionId` — safe because all transaction IDs are generated by `generateTransactionId()`.

5. **Simulated wallet always correct for execution**: The approval was created during simulated-mode payment processing. Using `options.simulatedWallet.pay()` is correct for the initial implementation; real rails would require storing the original rail choice in the approval row and selecting the matching wallet.

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

- TypeScript: `npx tsc --noEmit` — no errors
- Approval tests: `npx vitest run tests/unit/approvals.test.ts` — 8/8 passed
- Full suite: `npx vitest run` — 113 passed, 1 skipped, 0 failed
- Gap closure verified: POST /operator/approvals/:id/approve now returns `payment_status: 'SETTLED'`, PAYMENT+RELEASE+PAYMENT_SETTLED entries written, agent balance reflects -amount_msat
- Deny path unaffected: Test 3 (deny) still passes, balance restores to 100_000
- Timeout path unaffected: Test 6 (timeout) still passes, balance restores to 100_000

## Self-Check: PASSED

Files exist:
- src/modules/payments/payments.service.ts — contains `executeApprovedPayment`
- src/routes/admin/approvals.routes.ts — contains `executeApprovedPayment` call and `payment_status: z.enum(['SETTLED', 'FAILED'])`
- tests/unit/approvals.test.ts — contains 8 tests including Test 8 gap closure

Commits exist:
- e624aef: feat(04-04): add executeApprovedPayment and wire into approve route
- 3d4ceb0: test(04-04): update approval tests to verify settlement after approve
