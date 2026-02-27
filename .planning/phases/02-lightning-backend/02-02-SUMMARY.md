---
phase: 02-lightning-backend
plan: 02
subsystem: payments
tags: [lightning, lnd, wallet, payment-state-machine, crash-recovery, reserve-release, typescript]

# Dependency graph
requires:
  - phase: 02-lightning-backend
    plan: 01
    provides: "Extended schema (payment_hash, mode, RESERVE/RELEASE, max_fee_msat), LND client (connectWithRetry), wallet.interface.ts extensions"
provides:
  - "LightningWallet class implementing WalletBackend with three-phase payment state machine"
  - "LightningStreamError class for gRPC stream error discrimination"
  - "createPaymentsService(wallet) factory — dynamic wallet backend injection"
  - "RESERVE/RELEASE ledger flow: balance debited at PENDING, credited back on confirmed failure"
  - "Payment hash stored in memory before async wallet completion (crash safety SEC-04)"
  - "initializeLightningBackend: LND connect + wallet creation + crash recovery startup"
  - "Crash recovery: RELEASE for no-hash PENDING; subscribeToPastPayment for hashed PENDING"
  - "ledgerRepo.updatePaymentHash() for recording payment_hash on RESERVE entries"
  - "app.paymentsService decorator for route-level wallet access (no hardcoded singleton)"
  - "index.ts: WALLET_BACKEND=lightning branch initializes LND before buildApp"
affects: [02-03, phase-03-cashu]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "subscribeToPayViaRequest EventEmitter bridge to Promise — payment state machine"
    - "Synchronous in-memory payment_hash capture in 'paying' handler (Pitfall 2 prevention)"
    - "LightningStreamError class discriminates stream errors from payment failures"
    - "RESERVE/RELEASE ledger pattern: RESERVE before LND call, RELEASE only on 'failed' event"
    - "Factory function createPaymentsService(wallet) for testable wallet injection"
    - "Fastify app.paymentsService decorator for route-level wallet access"
    - "subscribeToPastPayment for crash recovery re-subscription to in-flight HTLCs"

key-files:
  created:
    - src/modules/payments/wallet/lightning.wallet.ts
    - src/lib/lnd/lnd.startup.ts
  modified:
    - src/modules/payments/wallet/wallet.interface.ts
    - src/modules/payments/payments.service.ts
    - src/modules/ledger/ledger.repo.ts
    - src/modules/agents/agents.repo.ts
    - src/app.ts
    - src/routes/agent/payments.routes.ts
    - src/index.ts

key-decisions:
  - "LightningStreamError rejects Promise but does NOT trigger RELEASE — stream errors keep ledger PENDING"
  - "payment_hash stored synchronously in closure variable (not async DB write) in 'paying' handler — Pitfall 2 prevention"
  - "createPaymentsService(wallet) factory replaces module-level singleton; backward-compat paymentsService singleton exported for tests"
  - "app.paymentsService decorator set at buildApp time — routes use app decorator, not direct import"
  - "initializeLightningBackend dynamically imported in index.ts to avoid loading LND module when WALLET_BACKEND=simulated"
  - "agentsRepo.getWithPolicy() extended to return max_fee_msat in policy — fee limit propagation to wallet call"
  - "ledgerRepo.updatePaymentHash() added for post-call payment_hash recording on RESERVE entries"
  - "Fee debit written as separate PAYMENT entry (not adjusted RESERVE) — cleaner balance math"

requirements-completed: [PAY-03, SEC-04]

# Metrics
duration: 5min
completed: 2026-02-27
---

# Phase 2 Plan 02: LightningWallet, RESERVE/RELEASE Flow, and Startup Crash Recovery Summary

**LightningWallet class with three-phase payment state machine (subscribeToPayViaRequest), RESERVE/RELEASE ledger pattern before LND send with RELEASE-only-on-failure guarantee, and startup crash recovery via subscribeToPastPayment for all in-flight HTLCs**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-02-27T01:24:41Z
- **Completed:** 2026-02-27T01:29:10Z
- **Tasks:** 2
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- Implemented `LightningWallet` class implementing `WalletBackend` with `subscribeToPayViaRequest`
- Three-phase payment state machine: 'paying' (hash capture), 'confirmed' (SETTLED), 'failed' (FAILED)
- `LightningStreamError` class correctly discriminates gRPC stream errors from payment failures
- Added `max_fee_msat?: number` to `PaymentRequest` interface for per-agent fee limits
- Refactored `paymentsService` to factory pattern: `createPaymentsService(wallet)` with backward-compat singleton
- RESERVE ledger entry written before LND call — crash safety invariant (SEC-04)
- RELEASE only on 'failed' event, never on 'error' — no false refunds (Pitfall 1 prevention)
- Fee debit written as separate PAYMENT entry on SETTLED for clear balance accounting
- `updatePaymentHash()` added to `ledgerRepo` for post-call hash recording on RESERVE entries
- `agentsRepo.getWithPolicy()` extended to expose `max_fee_msat` for fee limit propagation
- Created `lnd.startup.ts` with `initializeLightningBackend()`: connect, create wallet, crash recovery
- Crash recovery: RELEASE for no-hash PENDING (crashed before LND send), `subscribeToPastPayment` for hashed PENDING
- `buildApp()` accepts `wallet` in `BuildAppOptions`, decorates app with `app.paymentsService`
- `payments.routes.ts` uses `app.paymentsService` instead of hardcoded singleton
- `index.ts` branches on `WALLET_BACKEND=lightning` to initialize LND before `buildApp`
- All 59 existing tests continue to pass (simulated wallet path unchanged)

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement LightningWallet class** - `f461fdc` (feat)
2. **Task 2: Refactor payment service and wire startup** - `620cbfd` (feat)

## Files Created/Modified

- `src/modules/payments/wallet/lightning.wallet.ts` - NEW: LightningWallet class + LightningStreamError
- `src/lib/lnd/lnd.startup.ts` - NEW: initializeLightningBackend with crash recovery
- `src/modules/payments/wallet/wallet.interface.ts` - Added max_fee_msat to PaymentRequest
- `src/modules/payments/payments.service.ts` - Factory pattern, RESERVE/RELEASE flow, fee debit
- `src/modules/ledger/ledger.repo.ts` - Added updatePaymentHash()
- `src/modules/agents/agents.repo.ts` - Added max_fee_msat to AgentWithPolicy.policy
- `src/app.ts` - wallet in BuildAppOptions, app.paymentsService decorator
- `src/routes/agent/payments.routes.ts` - Use app.paymentsService; add payment_hash/fee_msat to response schema
- `src/index.ts` - WALLET_BACKEND=lightning startup branch with dynamic import

## Decisions Made

- `LightningStreamError` rejects the Promise but payment service does NOT write RELEASE on stream errors — correctly keeps ledger PENDING for crash recovery
- `payment_hash` stored synchronously in closure (`paymentHashInMemory`) before any async operation — prevents race condition where regtest emits 'confirmed' synchronously after 'paying'
- Factory pattern `createPaymentsService(wallet)` enables wallet injection without module mocking in tests; backward-compat `paymentsService` singleton uses `simulatedWallet`
- `app.paymentsService` Fastify decorator established at `buildApp()` time — routes read from decorator, decoupling them from the wallet selection logic
- Dynamic import of `lnd.startup.ts` in `index.ts` avoids loading the `lightning` npm module when `WALLET_BACKEND=simulated`
- Fee debit is a separate `PAYMENT` ledger entry (not baked into RESERVE) — cleaner balance math and audit trail
- `agentsRepo.getWithPolicy()` returns `max_fee_msat` — the single source of truth for per-agent fee limits is the policy table

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] agentsRepo.getWithPolicy() missing max_fee_msat**
- **Found during:** Task 2 (payments service refactor)
- **Issue:** The plan specifies using `max_fee_msat` from the agent policy, but `agentsRepo.getWithPolicy()` did not include `max_fee_msat` in its returned policy shape — the field existed in the schema but was not surfaced in the API
- **Fix:** Added `max_fee_msat: number | null` to `AgentWithPolicy.policy` interface and updated `getWithPolicy()` to include it in the returned object
- **Files modified:** `src/modules/agents/agents.repo.ts`
- **Verification:** `npx tsc --noEmit` passes; payment service now accesses `agent.policy?.max_fee_msat` directly without type casts
- **Committed in:** `620cbfd` (Task 2 commit)

**2. [Rule 2 - Missing Critical Functionality] ledgerRepo.updatePaymentHash() not in plan**
- **Found during:** Task 2 (RESERVE entry needs payment_hash update after wallet 'paying' event)
- **Issue:** The plan specifies updating the RESERVE entry's payment_hash after the wallet call captures it from the 'paying' event; however, no ledger method existed to do this update. Adding `updatePaymentHash()` is required for crash recovery to work correctly (a RESERVE entry with a payment_hash triggers `subscribeToPastPayment`, while one without triggers RELEASE).
- **Fix:** Added `updatePaymentHash(db, entryId, paymentHash)` method to `ledgerRepo`
- **Files modified:** `src/modules/ledger/ledger.repo.ts`
- **Verification:** `npx tsc --noEmit` passes; method used in payment service stream error path and SETTLED path
- **Committed in:** `620cbfd` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 missing critical functionality)
**Impact on plan:** Minimal — both were straightforward additions required to wire the specified data flows correctly. No behavioral changes to the payment state machine itself.

## Issues Encountered

- None beyond the two auto-fixed deviations noted above.

## User Setup Required

None for this plan. The Lightning wallet requires `WALLET_BACKEND=lightning` + LND credentials at runtime, but those are environment variables configured separately.

## Next Phase Readiness

- LightningWallet and startup wiring are complete — Phase 3 (02-03: Integration tests + Docker) can proceed
- All simulated tests continue to pass unchanged — safe to merge
- The `app.paymentsService` decorator pattern is established for future wallet backends

---
*Phase: 02-lightning-backend*
*Completed: 2026-02-27*

## Self-Check: PASSED

All files exist and all commits verified.
