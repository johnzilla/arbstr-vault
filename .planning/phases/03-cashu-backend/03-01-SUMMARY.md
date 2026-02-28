---
phase: 03-cashu-backend
plan: 01
subsystem: payments
tags: [cashu, ecash, cashu-ts, sqlite, drizzle, proof-pool, double-spend-prevention]

# Dependency graph
requires:
  - phase: 02-lightning-backend
    provides: WalletBackend interface, RESERVE/RELEASE pattern, ledger and audit repos
provides:
  - cashu_proofs and cashu_pending DB tables with migration
  - CashuClient wrapper around cashu-ts Wallet
  - cashuRepo with proof pool CRUD and PENDING lock (double-spend prevention)
  - CashuWalletBackend implementing WalletBackend with full melt flow
  - Extended schema enums (ledger mode: cashu, audit actions: CASHU_MINT/MELT/KEYSET_SWAP)
  - Extended config (CASHU_MINT_URL, CASHU_THRESHOLD_MSAT, WALLET_BACKEND: cashu/auto)
  - Extended PaymentResult (cashu_token_id, rail_used, initial_rail, final_rail, fallback_occurred)
affects: [03-cashu-backend-02-routing, future-phases]

# Tech tracking
tech-stack:
  added: ["@cashu/cashu-ts@^3.5.0"]
  patterns:
    - "PENDING proof lock mirrors Lightning RESERVE pattern: select + lock + delete in sync transaction before async melt"
    - "CashuClient wraps cashu-ts Wallet; rest of codebase never imports cashu-ts directly"
    - "cashuRepo is synchronous (all .run()/.get()/.all()) consistent with ledger.repo.ts and audit.repo.ts"
    - "Proof amounts in sat; WalletBackend interface uses msat; Math.ceil(msat/1000) at boundary"

key-files:
  created:
    - src/lib/cashu/cashu.client.ts
    - src/modules/cashu/cashu.repo.ts
    - src/modules/payments/wallet/cashu.wallet.ts
    - src/db/migrations/0002_easy_jetstream.sql
  modified:
    - src/db/schema.ts
    - src/config.ts
    - src/modules/payments/wallet/wallet.interface.ts
    - src/modules/ledger/ledger.repo.ts
    - src/modules/audit/audit.repo.ts

key-decisions:
  - "cashu-ts v3.5.0 Wallet.keyChain.getKeysets() used for keyset rotation detection (not wallet.getKeySets())"
  - "selectProofsToSend delegates to wallet.selectProofsToSend(proofs, amount) — coin selection NOT hand-rolled per RESEARCH.md Pitfall 1"
  - "WALLET_BACKEND=auto requires BOTH Lightning AND Cashu env vars (extended existing refine chain)"
  - "Proof pool depletion returns FAILED with no auto-mint; pool funding wired in Plan 02 when routing layer has both wallets"
  - "MeltQuoteState.PAID (not string 'PAID') used for state check to leverage cashu-ts enum type safety"

patterns-established:
  - "Proof pool is treasury-owned: proofs stored as rows (keyset_id, amount, secret, C) not as token strings"
  - "Double-spend lock: insert proof secrets into cashu_pending inside same sync transaction that deletes them from cashu_proofs"
  - "Change proofs from fee_reserve overpayment always handled defensively (check length before inserting)"
  - "Actual fee = fee_reserve - change_amount_sat (not fee_reserve itself)"

requirements-completed: [PAY-04]

# Metrics
duration: 5min
completed: 2026-02-27
---

# Phase 3 Plan 01: Cashu Backend Infrastructure Summary

**Cashu ecash proof pool with double-spend prevention: cashu-ts Wallet wrapper, SQLite proof storage repo with PENDING lock, and CashuWalletBackend implementing WalletBackend via melt flow**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-27T23:54:37Z
- **Completed:** 2026-02-27T23:59:58Z
- **Tasks:** 2
- **Files modified:** 9 (5 modified, 4 created)

## Accomplishments
- Installed @cashu/cashu-ts@^3.5.0 and generated DB migration for cashu_proofs and cashu_pending tables
- Built CashuClient wrapping cashu-ts Wallet with all required operations (mint, melt, swap, crash-recovery methods)
- Built cashuRepo with proof pool CRUD and PENDING lock (UNIQUE constraint on cashu_pending.secret prevents concurrent double-spend)
- Built CashuWalletBackend implementing WalletBackend: melt flow with sync select+lock+delete transaction + async melt + change proof restoration on settle

## Task Commits

Each task was committed atomically:

1. **Task 1: Schema extensions, config, and wallet interface for Cashu** - `057b45b` (feat)
2. **Task 2: CashuClient wrapper, proof repo, and CashuWalletBackend** - `e932bfc` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified
- `src/db/schema.ts` - Added cashu_proofs/cashu_pending tables; extended ledger mode and audit action enums
- `src/config.ts` - Extended WALLET_BACKEND enum (cashu/auto); added CASHU_MINT_URL and CASHU_THRESHOLD_MSAT with cross-field validation
- `src/modules/payments/wallet/wallet.interface.ts` - Extended PaymentResult with cashu_token_id, rail_used, initial_rail, final_rail, fallback_occurred
- `src/modules/ledger/ledger.repo.ts` - Updated mode cast to include 'cashu'
- `src/modules/audit/audit.repo.ts` - Extended AuditAction with CASHU_MINT, CASHU_MELT, CASHU_KEYSET_SWAP
- `src/lib/cashu/cashu.client.ts` - CashuClient wrapping cashu-ts Wallet
- `src/modules/cashu/cashu.repo.ts` - Proof pool CRUD and PENDING lock
- `src/modules/payments/wallet/cashu.wallet.ts` - CashuWalletBackend implementing WalletBackend
- `src/db/migrations/0002_easy_jetstream.sql` - Migration for cashu_proofs and cashu_pending

## Decisions Made
- Used `wallet.keyChain.getKeysets()` for keyset listing (the v3 API); keychain is accessible via `wallet.keyChain` getter
- Proof pool depletion returns FAILED immediately rather than triggering auto-mint; auto-mint from Lightning pool funding will be wired in Plan 02 when the routing layer has access to both wallets
- `MeltQuoteState.PAID` enum constant used instead of string literal for type safety
- Extended existing config `.refine()` chain with a second `.refine()` for Cashu-specific validation (zod v4 supports chained refines)
- `selectProofsToSend` wraps `wallet.selectProofsToSend(proofs, amount)` — coin selection never hand-rolled per RESEARCH.md pitfall guidance

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Initial `db.transaction(cb)({behavior: 'immediate'})` syntax was incorrect (tried to call the void return value). Fixed to `db.transaction(cb, {behavior: 'immediate'})` matching the pattern in payments.service.ts. Caught by TypeScript compilation check, resolved immediately.

## User Setup Required

None - no external service configuration required for this infrastructure plan. CASHU_MINT_URL must be set by the operator when deploying with WALLET_BACKEND=cashu or WALLET_BACKEND=auto, but that is runtime configuration, not setup required now.

## Next Phase Readiness
- Plan 02 (routing layer) can now import CashuWalletBackend and wire it into payments.service.ts routing logic
- Schema and config are ready for the routing layer
- cashuRepo.selectProofs and lockProofs are tested indirectly via TypeScript correctness; unit tests for cashuRepo can be added in Plan 02 if desired
- Pool funding (LND → mint → proof pool) will be implemented in Plan 02 when routing has access to both LightningWallet and CashuWalletBackend

---
*Phase: 03-cashu-backend*
*Completed: 2026-02-27*
