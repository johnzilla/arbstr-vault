# Roadmap: Agent Treasury Service (Vaultwarden)

## Overview

Vaultwarden is built in four phases that follow the dependency graph of a financial system: the audit log and ledger exist before any payment logic; the simulated wallet validates the full API contract before real funds flow; Lightning is the primary rail and integrates first; Cashu drops in as a second rail once Lightning is stable; advanced policy and operator tooling complete the system once both rails are proven. Every security constraint is a Phase 1 requirement, not a Phase 4 afterthought.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Data model, auth, policy engine, audit log, and simulated wallet — the entire API contract with no real funds
- [x] **Phase 2: Lightning Backend** - Real BOLT11 payment execution via LND with correct payment state machine (completed 2026-02-27)
- [ ] **Phase 3: Cashu Backend** - Self-hosted Nutshell mint as hot wallet plus automatic payment rail routing
- [ ] **Phase 4: Operator Experience and Advanced Policy** - Human approval workflow, remaining policy primitives, versioning, and operator endpoints

## Phase Details

### Phase 1: Foundation
**Goal**: Operators can register agents, configure per-agent policies, and simulate the entire payment lifecycle end-to-end — with an immutable audit log, atomic policy enforcement, and all security foundations in place
**Depends on**: Nothing (first phase)
**Requirements**: AGNT-01, AGNT-02, AGNT-03, AGNT-04, AGNT-05, PAY-01, PAY-02, PLCY-01, PLCY-02, PLCY-03, PLCY-04, PLCY-05, OBSV-01, OBSV-02, OBSV-03, OBSV-04, OBSV-05, SEC-01, SEC-02, SEC-03, SEC-06
**Success Criteria** (what must be TRUE):
  1. Operator can register an agent via API and receive a unique agent_id plus a static bearer token that authenticates all subsequent requests
  2. Agent can submit a payment request and receive a simulated response — identical API surface to real payments — with the policy decision (ALLOW, DENY, or REQUIRE_HUMAN_APPROVAL) and a transaction reference in the response body
  3. A payment request that would exceed the per-agent max-transaction limit or daily spend limit is denied before any ledger entry is written
  4. Every financial action and policy decision produces an append-only audit log entry, written in the same database transaction as the ledger update, and retrievable via filtered API query
  5. Agent bearer tokens and wallet credentials never appear in log output; the service starts in fail-closed mode such that a policy engine error produces DENY, not ALLOW
**Plans**: 5 plans

Plans:
- [x] 01-01-PLAN.md — Project scaffolding, DB schema, config, types, and Fastify app skeleton
- [x] 01-02-PLAN.md — Agent management, auth middleware, and agent API routes
- [x] 01-03-PLAN.md — Policy engine, ledger module, audit module, and simulated wallet
- [x] 01-04-PLAN.md — Payment service orchestration and payment API route
- [x] 01-05-PLAN.md — Security hardening, token redaction, and full E2E verification

### Phase 2: Lightning Backend
**Goal**: Agents can pay real BOLT11 Lightning invoices within their policy limits, with a correct payment state machine that never produces false refunds or double-debits
**Depends on**: Phase 1
**Requirements**: PAY-03, PAY-06, SEC-04, SEC-05
**Success Criteria** (what must be TRUE):
  1. Agent can submit a BOLT11 payment request and the Treasury pays the invoice via LND; the payment response includes the payment_hash as a transaction reference
  2. If LND returns a network timeout or ambiguous status, the payment stays PENDING in the ledger until resolved via TrackPaymentV2 — no automatic refund on transient failure
  3. The LND macaroon used by the Treasury is scoped to invoice and offchain operations only; the admin macaroon is never referenced in Treasury code or configuration
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md — Schema extension (payment_hash, max_fee_msat, RESERVE/RELEASE), config, LND client with macaroon verification
- [x] 02-02-PLAN.md — LightningWallet class, payment service RESERVE/RELEASE refactor, startup wiring with crash recovery
- [x] 02-03-PLAN.md — Payment status endpoint, Docker dev environment, and Lightning integration tests

### Phase 3: Cashu Backend
**Goal**: Agents can execute payments via the self-hosted Cashu hot wallet as a second rail, and the Treasury automatically routes payments between Lightning and Cashu based on amount and destination type
**Depends on**: Phase 2
**Requirements**: PAY-04, PAY-05
**Success Criteria** (what must be TRUE):
  1. Agent can submit a payment request that the Treasury fulfills by minting, melting, or swapping Cashu tokens against the self-hosted Nutshell mint
  2. Treasury automatically routes a payment request to Lightning or Cashu without the agent specifying a rail — routing decision is observable in the audit log entry for that payment
  3. Concurrent redemption of Cashu proofs does not produce a double-spend; identical proof submissions are rejected by the PENDING lock before either settles
**Plans**: 3 plans

Plans:
- [ ] 03-01-PLAN.md — Schema extensions, Cashu config, cashu-ts client, proof repo, and CashuWalletBackend
- [ ] 03-02-PLAN.md — Payment routing layer, payments.service dual-rail refactor, Cashu startup with crash recovery
- [ ] 03-03-PLAN.md — Cashu integration tests, Docker Nutshell service, payment status routing trace

### Phase 4: Operator Experience and Advanced Policy
**Goal**: Operators have full visibility and control over all agents — including human approval for over-limit transactions, versioned policy history, balance alerts, and a complete operator dashboard endpoint
**Depends on**: Phase 3
**Requirements**: PAY-07, PLCY-06, PLCY-07, PLCY-08, PLCY-09, OBSV-06, OBSV-07
**Success Criteria** (what must be TRUE):
  1. A payment request that triggers REQUIRE_HUMAN_APPROVAL enters a pending queue visible to the operator; if not approved within the configured timeout it automatically resolves to DENY
  2. Operator can view all registered agents with their current balances, recent spend totals, daily utilization, and active policy state in a single API call
  3. Policy changes are versioned with effective-from timestamps; a payment request evaluated after a policy change uses the policy version that was active at the time of the request
  4. When an agent balance drops below a configured floor, the operator receives a notification — the threshold is per-agent and configurable via API
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 5/5 | Complete | 2026-02-26 |
| 2. Lightning Backend | 3/3 | Complete   | 2026-02-27 |
| 3. Cashu Backend | 1/3 | In Progress|  |
| 4. Operator Experience and Advanced Policy | 0/TBD | Not started | - |
