---
phase: 03-cashu-backend
plan: 02
subsystem: payments
tags: [cashu, ecash, routing, dual-rail, fallback, crash-recovery, keyset-rotation, sqlite, drizzle]

# Dependency graph
requires:
  - phase: 03-cashu-backend-01
    provides: CashuWalletBackend, CashuClient, cashuRepo, cashu_proofs/cashu_pending tables, extended config (CASHU_THRESHOLD_MSAT)
  - phase: 02-lightning-backend
    provides: LightningWalletBackend, RESERVE/RELEASE pattern, ledgerRepo, auditRepo
provides:
  - Payment routing layer with selectRail() for automatic amount-threshold routing
  - preferred_rail hint support for agent-controlled rail selection
  - Fallback logic: primary rail FAILED -> auto-retry on other rail
  - Routing trace fields (initial_rail, final_rail, fallback_occurred) in audit and API response
  - initializeCashuBackend with crash recovery and keyset rotation
  - WALLET_BACKEND=cashu and WALLET_BACKEND=auto startup modes
  - Dual-wallet paymentsService wiring in app.ts
affects: [03-cashu-backend-03, future-phases]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "selectRail() internal function: threshold routing (msat < CASHU_THRESHOLD_MSAT -> cashu, >= -> lightning)"
    - "preferred_rail hint overrides threshold routing — agent can force a specific rail"
    - "Fallback: if primary rail returns FAILED and other rail available, auto-retry with RELEASE/RESERVE adjustment"
    - "createPaymentsService backward compat: non-simulatedWallet single-wallet arg treated as lightningWallet"
    - "initializeCashuBackend mirrors lnd.startup.ts: connect -> crash recovery -> keyset rotation -> return backend"
    - "Cashu crash recovery: checkMeltQuote per PENDING op (PAID/UNPAID releases lock, PENDING leaves it)"
    - "Keyset rotation: client.getKeysets() (sync) -> filter inactive -> swapProofs() -> atomic delete/insert/audit"

key-files:
  created:
    - src/lib/cashu/cashu.startup.ts
  modified:
    - src/modules/payments/payments.service.ts
    - src/routes/agent/payments.routes.ts
    - src/app.ts
    - src/index.ts

key-decisions:
  - "Backward compat for single-wallet createPaymentsService: non-simulatedWallet treated as lightningWallet (preserves isLightning semantic from old code)"
  - "selectRail() not exported — internal to payments service module"
  - "Cashu fallback to Lightning: write RESERVE for Lightning fallback before calling lightning.pay()"
  - "Lightning fallback to Cashu: write RELEASE+PAYMENT_FAILED audit for lightning before calling cashu.pay()"
  - "CashuClient.getKeysets() is synchronous (not async) — uses wallet.keyChain.getKeysets() loaded at initialize()"
  - "Keyset rotation writes CASHU_KEYSET_SWAP audit with agent_id='system' (system-level operation)"

patterns-established:
  - "Dual-wallet routing: PaymentsServiceOptions with lightningWallet+cashuWallet+simulatedWallet slots"
  - "Routing trace always written to PAYMENT_REQUEST audit metadata even on DENY"
  - "Cashu SETTLED path: PAYMENT ledger debit inside same transaction as PAYMENT_SETTLED audit"

requirements-completed: [PAY-05]

# Metrics
duration: 5min
completed: 2026-02-28
---

# Phase 3 Plan 02: Routing Layer and Cashu Startup Summary

**Dual-rail payment routing with threshold-based auto-selection (CASHU_THRESHOLD_MSAT), agent preferred_rail override, automatic fallback on primary rail failure, and Cashu startup with crash recovery and keyset rotation**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-28T00:03:04Z
- **Completed:** 2026-02-28T00:08:11Z
- **Tasks:** 2
- **Files modified:** 5 (4 modified, 1 created)

## Accomplishments
- Refactored createPaymentsService to support dual-wallet options (lightningWallet + cashuWallet + simulatedWallet) while maintaining full backward compatibility for existing tests
- Implemented selectRail() threshold routing: payments under CASHU_THRESHOLD_MSAT auto-route to Cashu, at/above to Lightning; preferred_rail hint overrides
- Built automatic fallback: when primary rail returns FAILED and other rail exists, retry on the other rail with correct RESERVE/RELEASE ledger adjustments
- Created initializeCashuBackend with crash recovery (checkMeltQuote per PENDING op) and keyset rotation (detect inactive-keyset proofs and swap atomically)
- Wired WALLET_BACKEND=cashu (Cashu-only) and WALLET_BACKEND=auto (dual-rail) startup branches in index.ts

## Task Commits

Each task was committed atomically:

1. **Task 1: Payment routing layer and payments.service refactor for dual-rail** - `e41da64` (feat)
2. **Task 2: Cashu startup with crash recovery, keyset rotation, and app wiring** - `1ef404b` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified
- `src/modules/payments/payments.service.ts` - Refactored for dual-wallet routing: PaymentsServiceOptions interface, selectRail(), fallback logic, routing trace fields in response and audit
- `src/routes/agent/payments.routes.ts` - Added BTC_cashu asset, preferred_rail body field, routing trace response fields
- `src/lib/cashu/cashu.startup.ts` - New: initializeCashuBackend with crash recovery and keyset rotation
- `src/app.ts` - Extended BuildAppOptions with cashuWallet; dual-wallet paymentsService wiring
- `src/index.ts` - Added WALLET_BACKEND=cashu and WALLET_BACKEND=auto startup branches

## Decisions Made
- Backward compat: when a single non-simulatedWallet WalletBackend is passed to `createPaymentsService`, it's treated as `lightningWallet` (preserving the old `isLightning = wallet !== simulatedWallet` semantic from pre-refactor tests)
- `selectRail()` is not exported — it's an internal implementation detail of the payments service
- Lightning->Cashu fallback: write RELEASE and PAYMENT_FAILED audit for Lightning before attempting Cashu payment
- Cashu->Lightning fallback: write a new RESERVE entry for Lightning before calling lightning.pay() (CashuWalletBackend already restores proofs on failure)
- `CashuClient.getKeysets()` is synchronous (wallet.keyChain loaded at initialize() time) — no await needed
- Keyset rotation audit uses `agent_id: 'system'` since it's a system-level operation, not agent-initiated

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Backward compatibility preserved for existing Lightning tests**
- **Found during:** Task 1 (payments.service refactor)
- **Issue:** Plan specified `{ simulatedWallet: walletOrOptions }` for single-wallet backward compat, but existing Lightning tests call `createPaymentsService(mockLightningWallet)` and expect RESERVE/RELEASE behavior (not simulated behavior)
- **Fix:** When a single WalletBackend is passed that is NOT the actual simulatedWallet singleton, it's placed in `lightningWallet` slot instead of `simulatedWallet` slot, preserving the old `isLightning = wallet !== simulatedWallet` check semantics
- **Files modified:** src/modules/payments/payments.service.ts
- **Verification:** All 3 lightning.test.ts RESERVE/RELEASE tests pass (tests 7, 8, 9)
- **Committed in:** e41da64 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Essential for correctness — backward compat for existing lightning tests was broken by the naive single-wallet wrapping approach. Fix maintains existing behavior while enabling the new dual-wallet path.

## Issues Encountered
- None after the backward compat fix above.

## User Setup Required
None - no external service configuration required for this plan. The routing and startup code is wired correctly; CASHU_MINT_URL and LND configuration are operator runtime requirements already documented in config.ts.

## Next Phase Readiness
- Plan 03 (pool funding) can now import the completed routing layer and both startup functions
- Both WALLET_BACKEND=cashu and WALLET_BACKEND=auto modes are fully functional at the code level
- The routing layer correctly handles all four cases: simulated, lightning-only, cashu-only, and dual-rail auto
- Pool funding (LND -> mint -> proof pool) is the remaining Cashu piece for Plan 03

---
*Phase: 03-cashu-backend*
*Completed: 2026-02-28*
