# Agent Treasury Service (Vaultwarden)

## What This Is

A centralized treasury service that acts as a "bank" for AI agents. It holds keys, connects to payment rails (Lightning/L402, Cashu, exchanges), manages per-agent sub-accounts, enforces spend policies, and provides an auditable record of all economic actions. Built for personal use — the sole customer is the operator plus their own agents.

## Core Value

Agents can request and execute payments within explicit policy limits, with all keys and connections centralized in the Treasury Service — never in the agents themselves.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

<!-- Current scope. Building toward these. -->

- [ ] Multiple AI agents can hold balances in sub-accounts
- [ ] Agents can request payments/spends within policy limits
- [ ] Agents can query balances, history, and policy state
- [ ] All keys and connections (LN, Cashu, exchange APIs) live in the Treasury Service, not in agents
- [ ] All payments go through a policy engine (allow/deny/require human approval)
- [ ] Append-only audit log for every financial action and policy decision
- [ ] Agent registration and sub-account setup via API
- [ ] Lightning / L402 backend for paying invoices
- [ ] Cashu backend (self-hosted mint) as hot wallet
- [ ] Per-agent policy primitives: max balance, daily spend limit, daily loss limit, whitelisted destinations, time-based limits
- [ ] Static token authentication per agent (v1)
- [ ] Simulated spends for initial development (Milestone 1)

### Out of Scope

- External human customers — only own agents and test harnesses (v1)
- Compliance/KYC features — not needed for personal use
- Multi-jurisdiction regulatory support — not applicable
- Sophisticated risk models — basic rules/limits sufficient for v1
- CEX connectors — optional for later

## Context

- Three target agent types: Trading Agent (exchange orders, market data), E-Commerce Operations Agent (SaaS payments, ad spend, refunds), PRD/MVP Builder Agent (small API/infra payments)
- Treasury Service exposes internal HTTP/JSON API
- Lightning node and Cashu mint run on separate hosts/containers
- Cashu mint treated as hot wallet with limited balance
- Fail-closed design: if Treasury is down, agents cannot move money; if policy engine fails, default to DENY
- Secrets stored securely with strict permissions

## Constraints

- **Security**: All wallet keys and API credentials must be centralized in the Treasury Service, never exposed to agents
- **Architecture**: Lightning node and Cashu mint on separate containers; Treasury communicates over secure channels
- **Auth**: Static tokens per agent in v1 (simple but sufficient)
- **Failure mode**: Fail closed — deny by default on any error

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Start with simulated spends (Milestone 1) | De-risk by building skeleton first, real payments later | — Pending |
| Self-hosted Cashu mint as hot wallet | Control over minting/redeeming, limited balance for security | — Pending |
| Static token auth for v1 | Simplicity — only personal agents, no external users | — Pending |
| HTTP/JSON API (not gRPC) | Simpler for agent integration, sufficient for internal use | — Pending |

---
*Last updated: 2026-02-26 after initialization*
