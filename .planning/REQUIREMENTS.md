# Requirements: Agent Treasury Service (Vaultwarden)

**Defined:** 2026-02-26
**Core Value:** Agents can request and execute payments within explicit policy limits, with all keys and connections centralized in the Treasury Service

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Agent Management

- [ ] **AGNT-01**: Operator can register a new agent and receive a unique agent_id and static bearer token
- [ ] **AGNT-02**: Each agent has an isolated sub-account with independent balance tracking
- [ ] **AGNT-03**: Agent can query its own balance per asset (e.g., BTC_on_LN, BTC_cashu)
- [ ] **AGNT-04**: Agent can view its own payment history filtered by date range and action type
- [ ] **AGNT-05**: Agent metadata and current policy snapshot are retrievable via API

### Payments

- [ ] **PAY-01**: Agent can submit a payment request specifying amount, asset, purpose, destination type, and destination details
- [ ] **PAY-02**: Payment requests work in simulated mode with identical API surface (no real funds moved)
- [ ] **PAY-03**: Treasury can pay BOLT11 Lightning invoices via LND on behalf of an agent
- [ ] **PAY-04**: Treasury can mint, melt, and swap Cashu tokens via self-hosted Nutshell mint on behalf of an agent
- [ ] **PAY-05**: Treasury auto-routes payments to Lightning or Cashu based on amount, fee, and destination type
- [ ] **PAY-06**: Payment responses include transaction reference (invoice paid, payment_hash, token ID)
- [ ] **PAY-07**: Agent can propose a withdrawal to a master wallet or external address

### Policy Engine

- [ ] **PLCY-01**: Policy engine evaluates every payment request before dispatch — no bypass path
- [ ] **PLCY-02**: Per-agent configurable maximum single transaction amount
- [ ] **PLCY-03**: Per-agent configurable daily spend limit (resets on 24h window)
- [ ] **PLCY-04**: Policy engine returns ALLOW, DENY, or REQUIRE_HUMAN_APPROVAL for each request
- [ ] **PLCY-05**: Policy engine defaults to DENY on any internal error (fail-closed)
- [ ] **PLCY-06**: Over-limit transactions route to pending state with operator notification
- [ ] **PLCY-07**: Pending approvals time out to DENY after configurable interval
- [ ] **PLCY-08**: Policy changes are versioned with effective-from timestamps
- [ ] **PLCY-09**: Policy evaluation uses the version active at payment request time

### Observability

- [ ] **OBSV-01**: Append-only audit log records every financial action with timestamp, agent_id, action type, parameters, policy decision, and result
- [ ] **OBSV-02**: Audit log entries are written in the same database transaction as the ledger update they describe
- [ ] **OBSV-03**: Audit log is filterable by agent_id, action_type, and time range via API
- [ ] **OBSV-04**: All wallet private keys, LN macaroons, and Cashu mint credentials are stored only in the Treasury Service
- [ ] **OBSV-05**: Agent bearer tokens and secrets are masked in all log output
- [ ] **OBSV-06**: Per-agent configurable balance alert threshold that notifies operator when balance drops below floor
- [ ] **OBSV-07**: Operator can view all agents, their balances, recent spend, policy state, and daily utilization via API

### Security

- [ ] **SEC-01**: Agents authenticate via static bearer tokens — no direct access to wallet keys
- [ ] **SEC-02**: Policy enforcement and ledger debit happen inside a single atomic database transaction (prevents TOCTOU race conditions)
- [ ] **SEC-03**: All agent-supplied strings are validated via strict Zod schemas — no free-text fields affect policy routing
- [ ] **SEC-04**: Lightning payment state machine tracks payment_hash before send and resolves via TrackPaymentV2 (prevents false refunds)
- [ ] **SEC-05**: LND macaroon is scoped to invoice+offchain operations only (never admin.macaroon)
- [ ] **SEC-06**: If Treasury Service is down, agents cannot move money (fail-closed architecture)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Policy

- **PLCY-10**: Per-agent max balance limit
- **PLCY-11**: Per-agent daily loss limit (net position tracking across both rails)
- **PLCY-12**: Per-agent whitelisted destinations (hostnames, node pubkeys, exchange IDs)
- **PLCY-13**: Per-agent active time windows (e.g., only trade 09:00-17:00 UTC)

### Advanced Payments

- **PAY-08**: L402 payment proxying — treasury pays L402-gated APIs on agent's behalf
- **PAY-09**: Automated top-up and rebalancing between Lightning and Cashu rails

### Advanced Observability

- **OBSV-08**: Cashu NUT-07 state verification for proof validity
- **OBSV-09**: Reconciliation job comparing treasury ledger against external node/mint state

## Out of Scope

| Feature | Reason |
|---------|--------|
| External human customers | Personal use only — own agents and test harnesses |
| KYC/AML compliance | Not needed for personal-use, single-operator scenario |
| Multi-jurisdiction regulatory support | Not applicable |
| Agent-to-agent internal transfers | Defeats per-agent loss limits; route through external rails instead |
| Automated policy relaxation | Reward-based limit increases are a gradual compromise vector |
| Real-time WebSocket streaming | Agents poll or receive webhooks; keep server stateless |
| Multi-operator access | Out of scope for personal use; adds RBAC complexity |
| On-chain Bitcoin custody | Lightning + Cashu sufficient; on-chain via LND channel management |
| CEX connectors | Belongs in dedicated service, not treasury |
| Sophisticated risk models | Basic rules/limits sufficient for v1 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| AGNT-01 | Phase 1 | Pending |
| AGNT-02 | Phase 1 | Pending |
| AGNT-03 | Phase 1 | Pending |
| AGNT-04 | Phase 1 | Pending |
| AGNT-05 | Phase 1 | Pending |
| PAY-01 | Phase 1 | Pending |
| PAY-02 | Phase 1 | Pending |
| PAY-03 | Phase 2 | Pending |
| PAY-04 | Phase 3 | Pending |
| PAY-05 | Phase 3 | Pending |
| PAY-06 | Phase 2 | Pending |
| PAY-07 | Phase 4 | Pending |
| PLCY-01 | Phase 1 | Pending |
| PLCY-02 | Phase 1 | Pending |
| PLCY-03 | Phase 1 | Pending |
| PLCY-04 | Phase 1 | Pending |
| PLCY-05 | Phase 1 | Pending |
| PLCY-06 | Phase 4 | Pending |
| PLCY-07 | Phase 4 | Pending |
| PLCY-08 | Phase 4 | Pending |
| PLCY-09 | Phase 4 | Pending |
| OBSV-01 | Phase 1 | Pending |
| OBSV-02 | Phase 1 | Pending |
| OBSV-03 | Phase 1 | Pending |
| OBSV-04 | Phase 1 | Pending |
| OBSV-05 | Phase 1 | Pending |
| OBSV-06 | Phase 4 | Pending |
| OBSV-07 | Phase 4 | Pending |
| SEC-01 | Phase 1 | Pending |
| SEC-02 | Phase 1 | Pending |
| SEC-03 | Phase 1 | Pending |
| SEC-04 | Phase 2 | Pending |
| SEC-05 | Phase 2 | Pending |
| SEC-06 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 34 total
- Mapped to phases: 34
- Unmapped: 0

---
*Requirements defined: 2026-02-26*
*Last updated: 2026-02-26 after roadmap creation*
