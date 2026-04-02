---
phase: 05-internal-auth-and-reserve
verified: 2026-04-02T18:28:00Z
status: passed
score: 11/11 must-haves verified
---

# Phase 5: Internal Auth and Reserve Verification Report

**Phase Goal:** Arbstr core can authenticate as an internal service and reserve funds against an agent's balance before an LLM call
**Verified:** 2026-04-02T18:28:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A request with valid X-Internal-Token header passes through to the next handler | VERIFIED | Unit test passes; middleware does not set 401 when tokens match (internalAuth.ts:29) |
| 2 | A request with missing X-Internal-Token header receives 401 | VERIFIED | Unit test + integration test (internal-billing.test.ts Test 2) both pass |
| 3 | A request with wrong X-Internal-Token header receives 401 | VERIFIED | Unit test + integration test (internal-billing.test.ts Test 3) both pass |
| 4 | When VAULT_INTERNAL_TOKEN env var is unset, config parses successfully (field is optional) | VERIFIED | Config schema uses `z.string().min(32).optional()` (config.ts:20); unit test confirms safeParse succeeds with empty object |
| 5 | Token comparison uses constant-time algorithm (timingSafeEqual) | VERIFIED | `timingSafeEqual` imported from crypto and used at internalAuth.ts:29 |
| 6 | Arbstr core can POST /internal/reserve with agent_token, amount_msats, correlation_id, model and receive a reservation_id | VERIFIED | Integration test Test 1: returns 200 with reservation_id matching /^tx_/ and remaining_balance_msats |
| 7 | Reserve with invalid agent token returns 401 | VERIFIED | Integration test Test 4: 401 with "Invalid agent token" message |
| 8 | Reserve with insufficient balance returns 402 with balance info | VERIFIED | Integration test Test 5: 402 with current_balance_msats=100000, requested_msats=200000 |
| 9 | After successful reserve, agent balance is reduced by reserved amount | VERIFIED | Integration test Test 6: remaining_balance_msats = 100000 - 30000 = 70000 |
| 10 | A RESERVE ledger entry exists with negative amount and mode simulated | VERIFIED | Integration test Test 7: queries DB directly, confirms amount_msat=-50000, entry_type='RESERVE', mode='simulated', ref_id=correlation_id |
| 11 | Success response includes reservation_id and remaining_balance_msats | VERIFIED | Integration test Test 1: response body has both fields, reservation_id starts with tx_ |

**Score:** 11/11 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/middleware/internalAuth.ts` | Internal auth onRequest hook | VERIFIED | 40 lines, exports internalAuth, uses timingSafeEqual, reads x-internal-token header |
| `src/config.ts` | VAULT_INTERNAL_TOKEN in config schema | VERIFIED | Line 20: `VAULT_INTERNAL_TOKEN: z.string().min(32).optional()` |
| `tests/unit/internal-auth.test.ts` | Unit tests for internal auth middleware | VERIFIED | 140 lines, 9 test cases, all pass |
| `.env.example` | Documentation for VAULT_INTERNAL_TOKEN | VERIFIED | Line 33: commented example with description |
| `src/routes/internal/reserve.routes.ts` | POST /internal/reserve route | VERIFIED | 85 lines, exports internalBillingRoutes, full Zod schema validation, agent resolution, balance check, RESERVE ledger insertion |
| `src/app.ts` | Route registration for internal billing | VERIFIED | Lines 13, 144-146: conditional registration gated by config.VAULT_INTERNAL_TOKEN |
| `tests/integration/internal-billing.test.ts` | Integration tests for reserve endpoint | VERIFIED | 250 lines, 9 test cases covering 200/401/402/400 paths, all pass |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/middleware/internalAuth.ts` | `src/config.ts` | imports config.VAULT_INTERNAL_TOKEN | WIRED | Line 3: `import { config }`, line 13: `config.VAULT_INTERNAL_TOKEN` |
| `reserve.routes.ts` | `internalAuth.ts` | addHook onRequest | WIRED | Line 14: `app.addHook('onRequest', internalAuth)` |
| `reserve.routes.ts` | `ledger.repo.ts` | ledgerRepo.insert | WIRED | Line 68: `ledgerRepo.insert(app.db, {...})` with RESERVE entry |
| `reserve.routes.ts` | `agents.repo.ts` | agentsRepo.findByTokenHash | WIRED | Line 47: `agentsRepo.findByTokenHash(app.db, tokenHash)` |
| `reserve.routes.ts` | `ledger.repo.ts` | ledgerRepo.getBalance | WIRED | Lines 55, 78: balance check before reserve and remaining balance after |
| `src/app.ts` | `reserve.routes.ts` | app.register(internalBillingRoutes) | WIRED | Line 146: `app.register(internalBillingRoutes)` inside config guard |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All phase 05 unit tests pass | `npx vitest run tests/unit/internal-auth.test.ts` | 9/9 passed | PASS |
| All phase 05 integration tests pass | `npx vitest run tests/integration/internal-billing.test.ts` | 9/9 passed | PASS |
| Full test suite passes (no regressions) | `npx vitest run` | 253 passed, 0 failed, 2 skipped (25 test files) | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| IAUTH-01 | 05-01 | Service-to-service requests authenticated via X-Internal-Token header matched against VAULT_INTERNAL_TOKEN env var | SATISFIED | internalAuth.ts reads x-internal-token header, compares via timingSafeEqual against config.VAULT_INTERNAL_TOKEN |
| IAUTH-02 | 05-01 | Missing or invalid internal token returns 401 | SATISFIED | Middleware returns 401 for missing, wrong, empty, or unconfigured token; verified by 5 unit tests + 2 integration tests |
| BILL-01 | 05-02 | Arbstr core can reserve funds against agent's balance by providing agent_token, amount_msats, correlation_id, and model | SATISFIED | POST /internal/reserve accepts all 4 fields in Zod-validated body, returns reservation_id + remaining_balance_msats |
| BILL-02 | 05-02 | Reserve validates agent token via hashToken() + findByTokenHash() flow, returning 401 for invalid tokens | SATISFIED | reserve.routes.ts lines 46-52: hashToken then findByTokenHash, 401 on null |
| BILL-03 | 05-02 | Reserve checks agent balance is sufficient, returning 402 if not | SATISFIED | reserve.routes.ts lines 55-62: getBalance check, 402 with current_balance_msats and requested_msats |
| BILL-04 | 05-02 | Reserve inserts a RESERVE ledger entry (negative amount, mode simulated) and returns reservation_id | SATISFIED | reserve.routes.ts lines 67-75: insert with -amount_msats, entry_type RESERVE, mode simulated; integration test Test 7 verifies DB state directly |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No anti-patterns detected in any phase 05 files |

### Human Verification Required

No items require human verification. All phase 05 deliverables are backend API middleware and routes testable via automated integration tests. No UI, visual, or external service dependencies.

### Gaps Summary

No gaps found. All 11 observable truths verified. All 7 artifacts exist, are substantive, and are wired. All 6 key links confirmed. All 6 requirement IDs (IAUTH-01, IAUTH-02, BILL-01 through BILL-04) satisfied with direct code evidence. Full test suite passes with zero regressions.

---

_Verified: 2026-04-02T18:28:00Z_
_Verifier: Claude (gsd-verifier)_
