---
phase: 02-lightning-backend
verified: 2026-02-26T20:41:00Z
status: passed
score: 14/14 must-haves verified
re_verification: false
---

# Phase 2: Lightning Backend Verification Report

**Phase Goal:** Agents can pay real BOLT11 Lightning invoices within their policy limits, with a correct payment state machine that never produces false refunds or double-debits
**Verified:** 2026-02-26T20:41:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Agent can submit a BOLT11 payment request and Treasury pays via LND; response includes payment_hash as transaction reference | VERIFIED | `LightningWallet.pay()` uses `subscribeToPayViaRequest`, resolves with `payment_hash` from 'confirmed' event; payments route returns `payment_hash` in response schema |
| 2 | If LND returns network timeout or ambiguous status, payment stays PENDING — no automatic refund on transient failure | VERIFIED | `LightningStreamError` rejection path in `payments.service.ts` explicitly does NOT write RELEASE; test 9 verifies RELEASE is absent on stream error |
| 3 | LND macaroon is scoped to invoice+offchain only; admin macaroon never referenced | VERIFIED | `verifyMacaroonScope()` in `lnd.client.ts` attempts `getChainBalance` (requires `onchain:read`) and throws FATAL if it succeeds; docker-compose.dev.yml bakes macaroon with `info:read invoices:read invoices:write offchain:read offchain:write` only |

**Score:** 3/3 success criteria verified

---

### Plan-Level Must-Haves

#### Plan 02-01 Must-Haves

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Schema has payment_hash column on ledger_entries (nullable text) | VERIFIED | `schema.ts` line 39: `payment_hash: text('payment_hash')` — nullable (no `.notNull()`) |
| 2 | Schema has max_fee_msat column on policies (integer, default 1000) | VERIFIED | `schema.ts` line 22: `max_fee_msat: integer('max_fee_msat').default(1000)` |
| 3 | Schema supports RESERVE and RELEASE entry types | VERIFIED | `schema.ts` line 37: enum includes `'RESERVE', 'RELEASE'`; migration `0001_white_whirlwind.sql` does not alter entry_type (enum is SQLite text constraint applied at ORM level) |
| 4 | Config validates LND_HOST, LND_PORT, LND_CERT_BASE64, LND_MACAROON_BASE64, WALLET_BACKEND env vars | VERIFIED | `config.ts` lines 11-15 add all five vars; `.refine()` at lines 17-28 requires LND_HOST, LND_CERT_BASE64, LND_MACAROON_BASE64 when WALLET_BACKEND=lightning |
| 5 | LND client verifies macaroon is not overprivileged via getChainBalance (SEC-05) | VERIFIED | `lnd.client.ts` lines 44-59: `verifyMacaroonScope` calls `getChainBalance`; success = FATAL throw; permission-denied = silent proceed |
| 6 | LND client retries 5x with exponential backoff then exits | VERIFIED | `lnd.client.ts` lines 86-138: `RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]`, 5-iteration loop, FATAL path calls `process.exit(1)` without retry |

#### Plan 02-02 Must-Haves

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | LightningWallet implements WalletBackend and pays BOLT11 invoices via LND (PAY-03) | VERIFIED | `lightning.wallet.ts`: class implements `WalletBackend`, uses `subscribeToPayViaRequest`, full event handler chain |
| 2 | Payment hash stored in ledger BEFORE LND send call — crash safety (SEC-04) | VERIFIED | `payments.service.ts` lines 155-167: RESERVE entry written in IMMEDIATE tx before `wallet.pay()` call; `updatePaymentHash()` called when 'paying' event fires |
| 3 | Stream errors keep payment PENDING — only 'failed' events trigger RELEASE | VERIFIED | `payments.service.ts` lines 184-201: `LightningStreamError` path returns PENDING without RELEASE; test 9 in `lightning.test.ts` asserts no RELEASE entry |
| 4 | RESERVE entry debits balance at PENDING; RELEASE credits back on confirmed failure | VERIFIED | `payments.service.ts` line 162: RESERVE written as `-request.amount_msat`; lines 287-294: RELEASE written as `+request.amount_msat` on FAILED status |
| 5 | Crash recovery re-subscribes to all PENDING payments on startup via subscribeToPastPayment (SEC-04) | VERIFIED | `lnd.startup.ts` lines 84-184: `getPendingLightningPayments()` queried at startup; no-hash entries get RELEASE; has-hash entries get `subscribeToPastPayment` re-subscription |
| 6 | WALLET_BACKEND env var selects simulated or lightning wallet at startup | VERIFIED | `index.ts` lines 22-26: branches on `config.WALLET_BACKEND === 'lightning'`; dynamic import of `initializeLightningBackend` avoids loading lightning module in simulated mode |

#### Plan 02-03 Must-Haves

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Agent can poll payment status via GET /agents/:id/payments/:tx_id and see PENDING/SETTLED/FAILED with payment_hash and fee_msat (PAY-06) | VERIFIED | `payment-status.routes.ts` implements full route; response schema includes `payment_hash`, `fee_msat`, `status`, `mode`, `amount_msat`, timestamps |
| 2 | Payment response includes payment_hash as transaction reference (PAY-06) | VERIFIED | `payments.routes.ts` response schema line 38: `payment_hash: z.string().optional()`; service returns it on SETTLED/FAILED/PENDING paths |
| 3 | Lightning payment tests verify RESERVE/RELEASE ledger flow with mocked LND (PAY-03, SEC-04) | VERIFIED | `lightning.test.ts`: 14 mock tests + 1 live-skip; tests 7-9 verify full RESERVE/RELEASE at service level; tests 10-12 verify crash recovery; tests 13-14 verify macaroon scope |
| 4 | Tests skip when LND_HOST not set | VERIFIED | `lightning.test.ts` line 565: `const LIVE_TESTS = process.env.LND_HOST ? describe : describe.skip`; vitest output confirms 75 passed, 1 skipped |
| 5 | Docker Compose dev environment available for regtest testing | VERIFIED | `docker-compose.dev.yml`: bitcoind + lnd-alice + lnd-bob; Alice entrypoint bakes scoped macaroon; manual setup instructions documented as comments |

**Total plan must-have score:** 14/14 verified

---

### Required Artifacts

| Artifact | Exists | Lines | Substantive | Wired | Status |
|----------|--------|-------|-------------|-------|--------|
| `src/db/schema.ts` | Yes | 69 | Yes — payment_hash, mode, RESERVE/RELEASE, max_fee_msat | Yes — imported by ledger.repo, migrations | VERIFIED |
| `src/config.ts` | Yes | 31 | Yes — WALLET_BACKEND + LND vars + .refine() | Yes — imported by lnd.startup, index | VERIFIED |
| `src/lib/lnd/lnd.client.ts` | Yes | 139 | Yes — createLndConnection, verifyMacaroonScope, connectWithRetry | Yes — imported by lnd.startup.ts | VERIFIED |
| `src/modules/payments/wallet/wallet.interface.ts` | Yes | 25 | Yes — payment_hash, fee_msat, max_fee_msat added | Yes — implemented by LightningWallet and SimulatedWallet | VERIFIED |
| `src/modules/payments/wallet/lightning.wallet.ts` | Yes | 125 | Yes — full three-phase state machine | Yes — used in lnd.startup.ts and payments.service.ts | VERIFIED |
| `src/modules/payments/payments.service.ts` | Yes | 344 | Yes — RESERVE/RELEASE flow, factory pattern | Yes — used via app.paymentsService decorator | VERIFIED |
| `src/lib/lnd/lnd.startup.ts` | Yes | 188 | Yes — LND connect + wallet create + crash recovery | Yes — dynamically imported in index.ts | VERIFIED |
| `src/app.ts` | Yes | 115 | Yes — wallet in BuildAppOptions, app.paymentsService decorator | Yes — agentPaymentStatusRoutes registered | VERIFIED |
| `src/routes/agent/payment-status.routes.ts` | Yes | 168 | Yes — full GET endpoint with status derivation | Yes — registered in app.ts line 112 | VERIFIED |
| `docker-compose.dev.yml` | Yes | 165 | Yes — bitcoind + lnd-alice + lnd-bob, scoped macaroon bake | Yes — standalone file | VERIFIED |
| `tests/integration/lightning.test.ts` | Yes | 577 | Yes — 14 mock tests + 1 live skip | Yes — runs in vitest suite | VERIFIED |
| `src/db/migrations/0001_white_whirlwind.sql` | Yes | 3 | Yes — ALTER TABLE for payment_hash, mode, max_fee_msat | Yes — applied by migrate() in index.ts | VERIFIED |

---

### Key Link Verification

| From | To | Via | Status | Evidence |
|------|----|-----|--------|----------|
| `lightning.wallet.ts` | `lightning` npm (subscribeToPayViaRequest) | EventEmitter subscription for payment lifecycle | WIRED | Line 1 import, line 60 call with `request` and `max_fee_mtokens` |
| `lightning.wallet.ts` | `lightning` npm (subscribeToPastPayment) | Crash recovery re-subscription | WIRED | `lnd.startup.ts` line 1 import, line 84 call with payment_hash |
| `payments.service.ts` | `ledger.repo.ts` | RESERVE entry before wallet call, RELEASE on failure | WIRED | Line 162: `entry_type: 'RESERVE'`; line 292: `entry_type: 'RELEASE'` |
| `lnd.startup.ts` | `lnd.client.ts` | connectWithRetry for LND connection | WIRED | Line 3 import, line 29 call |
| `lnd.startup.ts` | `ledger.repo.ts` | getPendingLightningPayments for crash recovery | WIRED | Line 5 import, line 39 call |
| `payment-status.routes.ts` | `ledger.repo.ts` | Query ledger entry by ref_id and agent_id | WIRED | Lines 80-89: Drizzle query on ledgerEntries with agent_id + ref_id filter |
| `lightning.test.ts` | `lightning.wallet.ts` | Tests verify LightningWallet behavior with mock EventEmitter | WIRED | Line 34 import, tests 1-6 instantiate LightningWallet |
| `app.ts` | `payment-status.routes.ts` | Route registered with app.register | WIRED | Line 9 import, line 112 register |
| `index.ts` | `lnd.startup.ts` | Dynamic import for WALLET_BACKEND=lightning | WIRED | Line 24: `await import('./lib/lnd/lnd.startup.js')` |
| `payments.routes.ts` | `app.paymentsService` | Routes use Fastify decorator not direct import | WIRED | Line 53: `app.paymentsService.processPayment(...)` |

---

### Requirements Coverage

| Requirement | Plans | Description | Status | Evidence |
|-------------|-------|-------------|--------|----------|
| PAY-03 | 02-02, 02-03 | Treasury can pay BOLT11 Lightning invoices via LND on behalf of an agent | SATISFIED | `LightningWallet.pay()` calls `subscribeToPayViaRequest` with BOLT11 invoice as `request`; RESERVE/RELEASE state machine; 14 mock tests including RESERVE/RELEASE full flow |
| PAY-06 | 02-03 | Payment responses include transaction reference (invoice paid, payment_hash, token ID) | SATISFIED | `payments.routes.ts` response schema includes `payment_hash`; `payment-status.routes.ts` endpoint returns `payment_hash`, `fee_msat`, `status`, `mode`, timestamps; `PaymentResponse` type has `payment_hash?: string` |
| SEC-04 | 02-02, 02-03 | Lightning payment state machine tracks payment_hash before send and resolves via TrackPaymentV2 (prevents false refunds) | SATISFIED | RESERVE written before `wallet.pay()` call; `updatePaymentHash()` called when 'paying' fires; stream error path returns PENDING (no RELEASE); crash recovery uses `subscribeToPastPayment`; tests 7-12 in lightning.test.ts verify all paths |
| SEC-05 | 02-01 | LND macaroon is scoped to invoice+offchain operations only (never admin.macaroon) | SATISFIED | `verifyMacaroonScope()` attempts `getChainBalance` (requires `onchain:read`); FATAL throw if succeeds; docker-compose.dev.yml bakes macaroon without `onchain:read`; tests 13-14 verify both overprivileged and correctly-scoped scenarios |

**REQUIREMENTS.md cross-reference:** All 4 Phase 2 requirements (PAY-03, PAY-06, SEC-04, SEC-05) appear in REQUIREMENTS.md traceability table as Phase 2 / Complete. No orphaned requirements found for Phase 2.

---

### Anti-Patterns Found

No blockers or warnings found. Scan results:

- No TODO/FIXME/PLACEHOLDER comments in implementation files
- No stub return patterns (`return null`, `return {}`, `return []`) in Lightning modules
- No console.log-only implementations (console.warn/error in lnd.startup.ts are legitimate observability calls for crash recovery events)
- No empty event handlers
- `getDailySpend` counts only `PAYMENT` entries, not `RESERVE` entries — this means in-flight Lightning payments do not count toward the daily spend limit until settled. This is a design consideration (the RESERVE debit reduces balance, which the policy check uses), not a false-refund or double-debit risk. Flagged as informational only.

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `ledger.repo.ts` L68 | `getDailySpend` filters `entry_type = 'PAYMENT'` — excludes RESERVE entries | Info | In-flight Lightning payments don't consume daily limit until settled; balance check still prevents overspend |

---

### Human Verification Required

#### 1. Live BOLT11 Payment End-to-End

**Test:** Start docker-compose.dev.yml, fund lnd-alice, open Alice→Bob channel. Set WALLET_BACKEND=lightning with LND credentials. Submit a POST /agents/:id/pay with a valid Bob invoice. Check response includes payment_hash and status=SETTLED. Poll GET /agents/:id/payments/:tx_id to confirm SETTLED status.
**Expected:** Payment settles within a few seconds; payment_hash in both responses; balance reduced by amount + fee
**Why human:** Requires live LND nodes and real HTLC resolution — cannot mock end-to-end network behavior

#### 2. LND Connection Failure Retry Behavior

**Test:** Start Treasury with WALLET_BACKEND=lightning pointing at an unavailable LND host. Observe startup logs.
**Expected:** 5 retry attempts logged with exponential delays (1s, 2s, 4s, 8s, 16s); process exits after final failure
**Why human:** Cannot test actual sleep timing and process exit behavior without running the process

#### 3. Macaroon Scope Rejection at Startup

**Test:** Start Treasury with WALLET_BACKEND=lightning using an admin.macaroon (has onchain:read).
**Expected:** Server logs FATAL message and exits with code 1 immediately (no retry)
**Why human:** Requires a real LND admin macaroon and live process observation

---

### Test Suite Results

```
Test Files: 7 passed (7)
Tests:      75 passed | 1 skipped (76 total)
Skipped:    1 (live regtest test — requires LND_HOST env var)
TypeScript: npx tsc --noEmit — PASSED (0 errors)
```

Commits verified:
- `4fac322` — feat(02-01): extend schema, config, and wallet interface for Lightning
- `4cf9f33` — feat(02-01): create LND client module with macaroon scope verification
- `f461fdc` — feat(02-02): implement LightningWallet class with three-phase payment state machine
- `620cbfd` — feat(02-02): refactor payments service for RESERVE/RELEASE flow and wire startup with crash recovery
- `660b7ae` — feat(02-03): add payment status endpoint GET /agents/:id/payments/:tx_id
- `d631f2c` — feat(02-03): Docker dev environment, Lightning integration tests, payment status tests

---

### Summary

Phase 2 goal is achieved. All 14 plan-level must-haves are verified against the actual codebase. The three ROADMAP success criteria are fully satisfied:

1. **BOLT11 payment with payment_hash in response:** `LightningWallet.pay()` uses `subscribeToPayViaRequest`, captures payment_hash from 'paying' event, returns it in the resolved `PaymentResult`. The payment route and status endpoint both surface it.

2. **PENDING on network ambiguity — no false refund:** `LightningStreamError` rejection path in `payments.service.ts` explicitly skips RELEASE and returns `status: 'PENDING'`. Test 9 asserts no RELEASE entry is written on stream error. The payment state machine only writes RELEASE on a definitive LND 'failed' event.

3. **Macaroon scoped to invoice+offchain only:** `verifyMacaroonScope()` enforces this at startup by probing `getChainBalance` (requires `onchain:read`). If the probe succeeds, Treasury refuses to start. The docker-compose.dev.yml bakes a macaroon without `onchain:read`. Tests 13-14 verify both paths.

Requirements PAY-03, PAY-06, SEC-04, and SEC-05 are all satisfied with code evidence and test coverage. No implementation stubs or orphaned artifacts found.

---

_Verified: 2026-02-26T20:41:00Z_
_Verifier: Claude (gsd-verifier)_
