# Agent Treasury Service (Vaultwarden)

## What This Is

A centralized treasury service that acts as a "bank" for AI agents. Holds all wallet keys, connects to Lightning (LND) and Cashu (self-hosted Nutshell mint) payment rails, manages per-agent sub-accounts with policy enforcement, and provides an auditable record of all economic actions. Includes operator control plane with human approval workflow, versioned policies, balance alerts, and dashboard. Built for personal use — the sole customer is the operator plus their own agents.

## Core Value

Agents can request and execute payments within explicit policy limits, with all keys and connections centralized in the Treasury Service — never in the agents themselves.

## Requirements

### Validated

- ✓ Multiple AI agents can hold balances in sub-accounts — v1.0
- ✓ Agents can request payments/spends within policy limits — v1.0
- ✓ Agents can query balances, history, and policy state — v1.0
- ✓ All keys and connections (LN, Cashu) live in the Treasury Service, not in agents — v1.0
- ✓ All payments go through a policy engine (allow/deny/require human approval) — v1.0
- ✓ Append-only audit log for every financial action and policy decision — v1.0
- ✓ Agent registration and sub-account setup via API — v1.0
- ✓ Lightning backend for paying BOLT11 invoices via LND — v1.0
- ✓ Cashu backend (self-hosted Nutshell mint) as hot wallet — v1.0
- ✓ Automatic payment rail routing (Lightning/Cashu) — v1.0
- ✓ Per-agent policy: max transaction, daily spend limit — v1.0
- ✓ Static token authentication per agent — v1.0
- ✓ Simulated wallet mode for development — v1.0
- ✓ Human approval for over-limit transactions with timeout — v1.0
- ✓ Versioned policies with point-in-time evaluation — v1.0
- ✓ Per-agent balance alerts with webhook notification — v1.0
- ✓ Operator dashboard (all agents, balances, spend, policy state) — v1.0
- ✓ Agent withdrawal proposals with mandatory approval — v1.0

### Active

<!-- Next milestone scope -->

- [ ] Per-agent max balance limit (PLCY-10)
- [ ] Per-agent daily loss limit with net position tracking (PLCY-11)
- [ ] Per-agent whitelisted destinations (PLCY-12)
- [ ] Per-agent active time windows (PLCY-13)
- [ ] L402 payment proxying (PAY-08)
- [ ] Automated top-up and rebalancing between rails (PAY-09)
- [ ] Cashu NUT-07 state verification (OBSV-08)
- [ ] Reconciliation job: treasury ledger vs external node/mint state (OBSV-09)

### Out of Scope

- External human customers — only own agents and test harnesses
- Compliance/KYC features — not needed for personal use
- Multi-jurisdiction regulatory support — not applicable
- Agent-to-agent internal transfers — defeats per-agent loss limits; route through external rails
- Automated policy relaxation — reward-based limit increases are a gradual compromise vector
- Real-time WebSocket streaming — agents poll or receive webhooks; keep server stateless
- Multi-operator access — adds RBAC complexity beyond personal use
- On-chain Bitcoin custody — Lightning + Cashu sufficient
- CEX connectors — belongs in dedicated service, not treasury
- Sophisticated risk models — basic rules/limits sufficient for current scope

## Context

- **Shipped:** v1.0 MVP (2026-02-28) — 9,617 LOC TypeScript, 113 tests
- **Tech stack:** Fastify, Drizzle ORM, SQLite (WAL mode), Zod v4, Pino, lightning (npm), cashu-ts v3.5
- **Architecture:** buildApp() factory pattern, injected DB for test isolation, createPaymentsService(wallet) for wallet decoupling
- **Payment rails:** Simulated (dev), Lightning via LND, Cashu via self-hosted Nutshell mint
- **Three target agent types:** Trading Agent, E-Commerce Operations Agent, PRD/MVP Builder Agent
- Fail-closed design: if Treasury is down, agents cannot move money; if policy engine fails, default to DENY

## Constraints

- **Security**: All wallet keys and API credentials centralized in Treasury Service, never exposed to agents
- **Architecture**: Lightning node and Cashu mint on separate containers; Treasury communicates over secure channels
- **Auth**: Static tokens per agent (simple but sufficient for personal use)
- **Failure mode**: Fail closed — deny by default on any error
- **Ledger integrity**: Policy enforcement and ledger debit in single atomic transaction

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Start with simulated spends (Milestone 1) | De-risk by building skeleton first, real payments later | ✓ Good — full API contract validated before real funds |
| Self-hosted Cashu mint as hot wallet | Control over minting/redeeming, limited balance for security | ✓ Good — cashu-ts integrates cleanly |
| Static token auth for v1 | Simplicity — only personal agents, no external users | ✓ Good — sufficient for scope |
| HTTP/JSON API (not gRPC) | Simpler for agent integration, sufficient for internal use | ✓ Good — Fastify performs well |
| TypeScript MVP, Rust later | Ship fast with best library support (lightning npm, cashu-ts) | ✓ Good — shipped in 4 days |
| No Python in treasury service | Python only in containerized sidecars (Nutshell mint) | ✓ Good — clean boundary |
| buildApp() factory with injected DB | Test isolation without module mocking | ✓ Good — all 113 tests isolated |
| RESERVE/RELEASE/PAYMENT ledger pattern | Atomic holds during async wallet calls prevent TOCTOU races | ✓ Good — crash-safe |
| Append-only policy versions | Point-in-time evaluation prevents retroactive policy changes | ✓ Good — clean audit trail |
| Webhook for operator notifications | Fire-and-forget with HMAC-SHA256 + retry; never blocks payment | ✓ Good — decoupled |

---
*Last updated: 2026-02-28 after v1.0 milestone*
