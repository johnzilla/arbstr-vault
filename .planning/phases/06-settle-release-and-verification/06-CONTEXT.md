# Phase 6: Settle, Release, and Verification - Context

**Gathered:** 2026-04-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Arbstr core can settle reservations at actual cost (partial settlement), release unused reservations, and all operations are safe to retry. Delivers: `POST /internal/settle` and `POST /internal/release` routes added to the existing `internalBillingRoutes` plugin, plus full integration test coverage including the end-to-end deposit→reserve→settle→balance flow.

</domain>

<decisions>
## Implementation Decisions

### Reservation Lookup
- **D-01:** Find RESERVE entry by primary key (`id = reservation_id`). The `reservation_id` returned by Phase 5's reserve route IS the ledger entry's PK (`tx_` ULID).
- **D-02:** Return 404 if RESERVE entry not found for the given `reservation_id`.

### Settle Route
- **D-03:** Settle atomically inserts two entries in a single transaction: RELEASE (credit back full reserved amount) + PAYMENT (debit actual cost). Both entries use `ref_id = reservation_id` to link back to the original RESERVE.
- **D-04:** Rich success response: `{settled: true, refunded_msats, actual_msats, remaining_balance_msats}`
- **D-05:** Settle metadata (tokens_in, tokens_out, provider, latency_ms) stored via `auditRepo.insert()` with action `PAYMENT_SETTLED` and metadata JSON. No schema migration needed — audit module already supports `metadata: Record<string, unknown>`.

### Release Route
- **D-06:** Release inserts a single RELEASE entry with `ref_id = reservation_id` and `amount_msat = +reserved_amount` (credit back the full hold).
- **D-07:** Success response: `{released: true}`

### Idempotency
- **D-08:** Both settle and release check for existing RELEASE entry: `SELECT id FROM ledger_entries WHERE ref_id = reservation_id AND entry_type = 'RELEASE'`. If found, return success without inserting duplicates.
- **D-09:** Idempotent settle returns the same `{settled: true, ...}` shape. Idempotent release returns `{released: true}`.

### Carried Forward from Phase 5
- **D-10:** All routes use `internalAuth` middleware (constant-time `X-Internal-Token` comparison) — already wired via `app.addHook('onRequest', internalAuth)` in the existing plugin.
- **D-11:** Error shape: `{error: {code, message}}` for all error responses.
- **D-12:** No policy checks — trusted internal caller.
- **D-13:** All entries use `mode: 'simulated'` — no real wallet calls.

### Claude's Discretion
- Transaction wrapper implementation (Drizzle's `db.transaction()` or manual)
- Exact Zod schema structure for settle/release request/response
- How to extract reserved_amount from the RESERVE entry for the RELEASE credit
- Whether to add a `findById` method to ledgerRepo or query inline

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 5 implementation (the code this phase extends)
- `src/routes/internal/reserve.routes.ts` — Existing plugin where settle/release routes are added
- `src/middleware/internalAuth.ts` — Auth hook already applied to the plugin

### Ledger operations
- `src/modules/ledger/ledger.repo.ts` — `insert()` for RELEASE/PAYMENT entries, `getBalance()` for remaining balance, `getPendingLightningPayments()` shows pattern for finding unresolved RESERVE entries
- `src/db/schema.ts:50-63` — `ledgerEntries` table schema (id, agent_id, amount_msat, entry_type, ref_id, payment_hash, mode, created_at)

### Audit module
- `src/modules/audit/audit.repo.ts` — `auditRepo.insert()` with `PAYMENT_SETTLED` action and `metadata` JSON field

### Types
- `src/types.ts` — `generateTransactionId()` for new entry IDs

### Test patterns
- `tests/integration/internal-billing.test.ts` — Existing reserve tests; settle/release tests extend this file

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `internalBillingRoutes` plugin: Settle and release routes add directly to this existing plugin — no new file needed
- `ledgerRepo.insert()`: Direct reuse for RELEASE and PAYMENT entries
- `ledgerRepo.getBalance()`: For remaining balance in settle response
- `auditRepo.insert()`: For metadata storage on PAYMENT_SETTLED with JSON metadata
- `generateTransactionId()`: For new ledger entry IDs

### Established Patterns
- Reserve route uses `ref_id: correlation_id` — settle/release will use `ref_id: reservation_id` to link entries
- `getPendingLightningPayments()` demonstrates the pattern: find RESERVE entries that have no matching RELEASE/PAYMENT via subquery — adapt for idempotency check
- `db.transaction()` available via Drizzle for atomic settle (RELEASE + PAYMENT in one tx)

### Integration Points
- `src/routes/internal/reserve.routes.ts` — Add settle and release routes to same plugin
- `tests/integration/internal-billing.test.ts` — Extend with settle/release test cases
- `src/modules/audit/audit.repo.ts` — `AuditAction` type needs `'BILLING_SETTLED'` added (or reuse `'PAYMENT_SETTLED'`)

</code_context>

<specifics>
## Specific Ideas

- Settle's RELEASE+PAYMENT pattern: RELEASE credits back full reserved amount, PAYMENT debits actual cost. Net effect = agent charged actual_msats. Append-only ledger preserved.
- Example: Reserve 8000, actual 3200 → RELEASE +8000, PAYMENT -3200. Balance change = -3200.
- Idempotency via RELEASE existence check means settle and release share the same guard — if RELEASE exists for that reservation_id, the operation already happened.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-settle-release-and-verification*
*Context gathered: 2026-04-02*
