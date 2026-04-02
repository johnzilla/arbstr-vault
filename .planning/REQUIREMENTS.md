# Requirements: Agent Treasury Service (Vaultwarden)

**Defined:** 2026-04-02
**Core Value:** Agents can request and execute payments within explicit policy limits, with all keys and connections centralized in the Treasury Service — never in the agents themselves

## v1.1 Requirements

Requirements for Internal Billing API. Each maps to roadmap phases.

### Internal Auth

- [x] **IAUTH-01**: Service-to-service requests authenticated via `X-Internal-Token` header matched against `VAULT_INTERNAL_TOKEN` env var
- [x] **IAUTH-02**: Missing or invalid internal token returns 401

### Billing — Reserve

- [x] **BILL-01**: Arbstr core can reserve funds against an agent's balance by providing the agent's `vtk_` token, amount, correlation ID, and model
- [x] **BILL-02**: Reserve validates the agent token via existing `hashToken()` + `findByTokenHash()` flow, returning 401 for invalid tokens
- [x] **BILL-03**: Reserve checks agent balance is sufficient, returning 402 if not
- [x] **BILL-04**: Reserve inserts a RESERVE ledger entry (negative amount, `mode: 'simulated'`) and returns a `reservation_id`

### Billing — Settle

- [ ] **BILL-05**: Arbstr core can settle a reservation at the actual cost (which may differ from reserved amount)
- [ ] **BILL-06**: Settle atomically inserts RELEASE (credit back full reserve) + PAYMENT (debit actual cost) in one transaction
- [ ] **BILL-07**: Settle is idempotent — settling an already-settled reservation returns success
- [ ] **BILL-08**: Settle records audit metadata (tokens_in, tokens_out, provider, latency_ms)

### Billing — Release

- [ ] **BILL-09**: Arbstr core can release a reservation to restore the full reserved amount
- [ ] **BILL-10**: Release is idempotent — releasing an already-released reservation returns success

## Future Requirements

Deferred to future milestones. Tracked but not in current roadmap.

### Advanced Policy

- **PLCY-10**: Per-agent max balance limit
- **PLCY-11**: Per-agent daily loss limit with net position tracking
- **PLCY-12**: Per-agent whitelisted destinations
- **PLCY-13**: Per-agent active time windows

### Payments

- **PAY-08**: L402 payment proxying
- **PAY-09**: Automated top-up and rebalancing between rails

### Observability

- **OBSV-08**: Cashu NUT-07 state verification
- **OBSV-09**: Reconciliation job: treasury ledger vs external node/mint state

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Policy checks on reserve | Deferred — arbstr core is trusted internal service |
| Real wallet calls from billing routes | All billing uses `mode: 'simulated'` — no Lightning/Cashu |
| Renaming vaultwarden to @arbstr/vault | Separate task |
| Modifying existing routes or ledger logic | Additive only — no changes to v1.0 surface |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| IAUTH-01 | Phase 5 | Complete |
| IAUTH-02 | Phase 5 | Complete |
| BILL-01 | Phase 5 | Complete |
| BILL-02 | Phase 5 | Complete |
| BILL-03 | Phase 5 | Complete |
| BILL-04 | Phase 5 | Complete |
| BILL-05 | Phase 6 | Pending |
| BILL-06 | Phase 6 | Pending |
| BILL-07 | Phase 6 | Pending |
| BILL-08 | Phase 6 | Pending |
| BILL-09 | Phase 6 | Pending |
| BILL-10 | Phase 6 | Pending |

**Coverage:**
- v1.1 requirements: 12 total
- Mapped to phases: 12
- Unmapped: 0

---
*Requirements defined: 2026-04-02*
*Last updated: 2026-04-02 after roadmap creation*
