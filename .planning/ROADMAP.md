# Roadmap: Agent Treasury Service (Vaultwarden)

## Milestones

- ✅ **v1.0 MVP** -- Phases 1-4 (shipped 2026-02-28)
- 🚧 **v1.1 Internal Billing API** -- Phases 5-6 (in progress)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-4) -- SHIPPED 2026-02-28</summary>

- [x] Phase 1: Foundation (5/5 plans) -- completed 2026-02-26
- [x] Phase 2: Lightning Backend (3/3 plans) -- completed 2026-02-27
- [x] Phase 3: Cashu Backend (3/3 plans) -- completed 2026-02-28
- [x] Phase 4: Operator Experience and Advanced Policy (4/4 plans) -- completed 2026-02-28

</details>

### 🚧 v1.1 Internal Billing API (In Progress)

**Milestone Goal:** Add internal billing routes (reserve/settle/release) for arbstr core to call for per-request LLM billing, with shared-secret auth and idempotent operations.

- [x] **Phase 5: Internal Auth and Reserve** - Auth middleware and reserve route for holding funds against agent balances
- [ ] **Phase 6: Settle, Release, and Verification** - Partial settlement, release, idempotency, and full test coverage

## Phase Details

### Phase 5: Internal Auth and Reserve
**Goal**: Arbstr core can authenticate as an internal service and reserve funds against an agent's balance before an LLM call
**Depends on**: Phase 4 (v1.0 ledger and agent infrastructure)
**Requirements**: IAUTH-01, IAUTH-02, BILL-01, BILL-02, BILL-03, BILL-04
**Success Criteria** (what must be TRUE):
  1. A request with a valid `X-Internal-Token` header passes through to the billing route; a request with a missing or wrong token gets 401
  2. Arbstr core can POST to `/internal/reserve` with an agent token, amount, correlation ID, and model, and receive back a `reservation_id`
  3. Reserve with an invalid agent token returns 401; reserve with insufficient balance returns 402
  4. After a successful reserve, the agent's available balance is reduced by the reserved amount (RESERVE ledger entry exists)
**Plans:** 2 plans

Plans:
- [x] 05-01-PLAN.md — Internal auth middleware and VAULT_INTERNAL_TOKEN config
- [x] 05-02-PLAN.md — POST /internal/reserve route, app registration, and integration tests

### Phase 6: Settle, Release, and Verification
**Goal**: Arbstr core can settle reservations at actual cost, release unused reservations, and all operations are safe to retry
**Depends on**: Phase 5
**Requirements**: BILL-05, BILL-06, BILL-07, BILL-08, BILL-09, BILL-10
**Success Criteria** (what must be TRUE):
  1. Settling a reservation inserts RELEASE (full credit) + PAYMENT (actual cost) atomically, and the agent's balance reflects the actual cost, not the reserved amount
  2. Settling an already-settled reservation returns success without creating duplicate ledger entries
  3. Releasing a reservation restores the full reserved amount to the agent's available balance
  4. Releasing an already-released reservation returns success without creating duplicate ledger entries
  5. Settle records audit metadata (tokens_in, tokens_out, provider, latency_ms) on the PAYMENT entry
**Plans:** 2 plans

Plans:
- [x] 06-01-PLAN.md — Settle and release routes with ledgerRepo helpers
- [ ] 06-02-PLAN.md — Integration tests for settle, release, idempotency, and end-to-end flow

## Progress

**Execution Order:** Phase 5 then Phase 6.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 5/5 | Complete | 2026-02-26 |
| 2. Lightning Backend | v1.0 | 3/3 | Complete | 2026-02-27 |
| 3. Cashu Backend | v1.0 | 3/3 | Complete | 2026-02-28 |
| 4. Operator Experience | v1.0 | 4/4 | Complete | 2026-02-28 |
| 5. Internal Auth and Reserve | v1.1 | 2/2 | Complete | 2026-04-02 |
| 6. Settle, Release, and Verification | v1.1 | 0/2 | Not started | - |
