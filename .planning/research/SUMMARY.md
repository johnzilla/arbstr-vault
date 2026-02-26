# Project Research Summary

**Project:** Vaultwarden — Agent Treasury Service
**Domain:** Payment custody service for AI agents (Lightning Network + Cashu ecash)
**Researched:** 2026-02-26
**Confidence:** MEDIUM-HIGH

## Executive Summary

Vaultwarden is a self-hosted payment custody and policy-enforcement service for AI agents, combining two payment rails — Lightning Network (BOLT11) and Cashu ecash — behind a single HTTP API that agents consume. Research confirms this is an emerging but well-scoped problem: no existing tool (LND Accounts, LndHub, Fireblocks) provides the combination of policy enforcement, multi-rail routing, and agent-centric API that this project requires. The recommended approach is a TypeScript/Node.js monolith using Fastify, Drizzle ORM, and PostgreSQL, with LND for Lightning and a self-hosted Nutshell mint for Cashu — all wired together with a custom pure-TypeScript policy engine. The architecture is internally a layered monolith: API layer calls Policy Engine calls Ledger; wallet backends (Lightning, Cashu, Simulated) sit behind a common trait/interface and are swappable without touching the policy or ledger layers.

The build order is dictated by safety: the audit log and double-entry sub-account ledger must exist before any payment logic is written on top of them. Milestone 1 should deliver a fully functional API and policy engine backed by a simulated wallet — all money-movement contracts exercised with zero real funds. This is not a compromise; it is the architecturally correct order because the policy engine, ledger, and audit log are the value of the system, not the Lightning wire protocol. Real Lightning and Cashu backends are drop-in replacements at Milestone 2 and 3 respectively.

The dominant risk category is financial correctness under concurrency and partial failure: race conditions on spend limits, Lightning payment status ambiguity, and Cashu proof double-spend are all critical-severity issues that must be designed out in Phase 1, not retrofitted later. A secondary risk is secret exposure — LND macaroons and Cashu signing keys must never be accessible to agent processes. The mitigation pattern is consistent across all risks: fail-closed defaults, database-level atomic locking, and mandatory reconciliation of treasury ledger state against external node state.

---

## Key Findings

### Recommended Stack

The stack is TypeScript-first throughout, with all major components offering first-class TypeScript generics. Fastify 5 + Zod v4 handles the HTTP API surface with schema validation as a first-class primitive, not an afterthought. Drizzle ORM is the correct choice over Prisma for a financial ledger because it exposes real SQL predicates, making transaction isolation levels explicit. The Lightning integration uses the `lightning` npm package (the official TypeScript-ready evolution of `ln-service`) against an LND 0.20.x node. The Cashu integration uses `@cashu/cashu-ts` 3.5.x (wallet client) against a self-hosted Nutshell 0.19.x mint container — the Rust CDK alternative is explicitly marked "early development, API will change" by its maintainers and is disqualified. The policy engine should be a hand-written pure TypeScript module, not an external rules engine; a custom evaluator is 50 lines of testable code versus 200+ lines of rules engine config with a deployment dependency.

**Core technologies:**
- **Node.js 24.x LTS:** Runtime — active LTS through Apr 2028; OpenSSL 3.5 with strict crypto defaults appropriate for payment services
- **TypeScript 5.7+ (strict):** Language — eliminates entire classes of money-handling bugs at compile time; first-class support in all chosen libraries
- **Fastify 5.7.x:** HTTP framework — built-in JSON schema validation, 3x faster than Express, requires Node.js 20+
- **Drizzle ORM 0.45.x:** Database access — explicit SQL-like API, no magic hiding isolation levels, correct for financial ledger work
- **PostgreSQL 16.x:** Primary datastore — ACID transactions, row-level locking, trigger-enforced append-only audit table; mandatory before real payments (SQLite acceptable for Milestone 1 only)
- **Zod 4.3.x:** Request/response validation — 14x faster than Zod 3, single source of truth for type + runtime validation
- **`lightning` npm (latest):** LND gRPC client — official TypeScript binding, 200+ LND methods as typed async functions
- **`@cashu/cashu-ts` 3.5.x:** Cashu wallet client — official library, 90% test coverage, stateless (treasury manages state in PostgreSQL)
- **Nutshell 0.19.x:** Self-hosted Cashu mint — reference implementation, stable, PostgreSQL backend, Docker images available
- **Pino 10.3.x:** Structured JSON logging — 10x faster than Winston; structured fields for audit trail (agent_id, amount_sat, policy_decision)
- **Vitest 4.0.x:** Testing — current TypeScript standard; Jest-compatible API; built-in coverage

### Expected Features

Research identifies a clear three-tier feature structure. The most important architectural constraint surfaced by feature research: the policy engine must evaluate every payment before dispatch with no bypass path — if the policy engine is not complete, payment dispatch is not complete. Feature dependencies flow strictly: Agent Registration → Token Auth → Balance Query → Payment Request → Policy Engine → Audit Log + Lightning/Cashu backends.

**Must have (table stakes):**
- Agent registration with static bearer token auth — without identity there are no agents
- Per-agent sub-account with balance tracking — core isolation guarantee; agents cannot share state
- Balance query API — agents must know their state before acting
- Payment request API (simulated mode for Milestone 1) — identical API surface to real mode, safe to test
- Policy engine with per-transaction limit and daily spend limit — minimum viable risk control, must be built before payments
- Append-only audit log — every action recorded including policy decisions, not just settled payments; non-negotiable in every milestone
- Lightning BOLT11 payment backend — primary external payment rail
- Cashu hot wallet backend — secondary internal/micropayment rail

**Should have (v1.x after validation):**
- Human approval workflow for over-limit transactions — pending state with operator webhook and timeout-to-deny
- Full policy primitive set: max balance, daily loss limit, whitelisted destinations, time-based limits
- Payment rail routing strategy (Lightning vs Cashu per payment based on amount and destination)
- Balance alert thresholds — operator quality-of-life for proactive top-ups
- L402 payment proxying — when agent types require pay-per-use API access
- Policy versioning — track what rules applied at the time of a disputed transaction

**Defer (v2+):**
- Agent activity dashboard — useful but CLI/JSON endpoint is sufficient initially
- Automated top-up and rebalancing between rails
- Cashu NUT-07 state verification — edge case protection, add if double-spend issues observed
- CEX connector — belongs in a dedicated service, not the treasury

**Anti-features (do not build):**
- Agent-to-agent internal transfers — defeats per-agent loss limits; route through external payments instead
- Automated policy relaxation based on agent track record — reward-based limit relaxation is a gradual compromise vector
- Real-time WebSocket streaming to agents — agents poll or receive webhooks; keep server stateless
- Multi-operator access — out of scope for personal-use; adds RBAC complexity with no benefit at this scale

### Architecture Approach

The recommended architecture is a layered monolith: all components run in a single process but are strictly separated by module boundaries. The API layer handles authentication and request routing. The Policy Engine reads agent balances from the Ledger and evaluates spend rules synchronously before any wallet operation — policy check is always first, always synchronous, always fail-closed. The Sub-account Ledger uses double-entry bookkeeping (never mutable balance counters); balances are derived by summing journal entries, making auditing and reconciliation straightforward. The Audit Log is append-only, written in the same database transaction as the ledger update it describes. Wallet backends (Lightning, Cashu, Simulated) implement a common interface and are swappable without touching policy or ledger code. External services (LND node, Nutshell mint) run as separate containers and communicate over loopback or private network.

**Major components:**
1. **API Layer** — authenticates agents via static token, validates input via Zod schemas, routes to policy engine; never calls wallet backends directly
2. **Policy Engine** — evaluates per-agent rules (limits, windows, whitelist) against current ledger state; returns Allow/Deny/HoldForApproval; fail-closed on any error
3. **Sub-account Ledger** — double-entry journal; derives balances from entries; enforces idempotency via payment_hash; the source of truth for all agent balances
4. **Audit Log** — append-only structured event store; written by all other components; never mutated; same-transaction writes required
5. **Wallet Backend (Lightning)** — LND gRPC client; manages payment state machine with PENDING state before send; always resolves via payment_hash tracking
6. **Wallet Backend (Cashu)** — cashu-ts client to Nutshell mint; handles mint/melt/swap; hot wallet with hard balance cap
7. **Simulated Wallet Backend** — records intended payments without real funds; identical interface; enables full Milestone 1 API testing

**Build order (from architecture research):**
1. Audit Log (no dependencies; all others depend on it)
2. Sub-account Ledger (depends on Audit Log)
3. Agent Registry (depends on Ledger)
4. Simulated Wallet (implements WalletBackend interface, no dependencies)
5. Policy Engine (depends on Ledger, Audit Log)
6. Approval Queue (depends on Policy Engine, Audit Log, Ledger)
7. API Layer (depends on all above)
8. Lightning Backend (replaces Simulated Wallet)
9. Cashu Backend (adds second real wallet option)

### Critical Pitfalls

Research identified 8 pitfalls; the following 5 are the highest severity and must be addressed before or during their respective phases.

1. **Policy race condition (TOCTOU on spend limits)** — Concurrent requests both read a limit, both pass, both execute, resulting in over-limit spend. Prevention: use `SELECT FOR UPDATE` (Postgres) or `BEGIN IMMEDIATE` (SQLite) so policy enforcement and ledger debit happen inside a single atomic transaction. Address in Phase 1.

2. **Lightning payment status ambiguity** — Network timeout or LND restart between send and status response causes a false "failed" classification, triggering a refund while the payment actually settled. Prevention: record `payment_hash` before send; maintain PENDING ledger state; always resolve via `TrackPaymentV2` query, never infer failed from a network exception. Address in Phase 2.

3. **Cashu proof double-spend via missing PENDING lock** — Concurrent redemption of identical proofs before either marks them SPENT. Prevention: verify Nutshell's NUT-07 PENDING lock implementation; proofs must transition UNSPENT → PENDING → SPENT atomically with DB row-level locks keyed on proof Y-coordinate. Address in Phase 2/3.

4. **Prompt injection via agent-controlled payment metadata** — Agent-supplied strings in memo or metadata fields manipulate policy decisions if any LLM interprets them. Prevention: the policy engine must be deterministic rule-based TypeScript only; strict Zod schema on all API inputs; no free-text fields that affect policy routing; all agent data treated as untrusted. Address in Phase 1.

5. **Private key / secret exposure** — LND macaroons and Cashu signing keys in environment variables are readable by any same-user process and can leak via log output. Prevention: secrets in files with chmod 600 owned by a dedicated service user; never in env vars visible to agent processes; mask `Authorization` headers in all log output. Address in Phase 1.

---

## Implications for Roadmap

Based on the component dependency graph and pitfall-to-phase mapping from research, four phases are recommended. The architecture file explicitly defines build order (items 1-9 above) — the phase structure maps directly to this dependency ordering.

### Phase 1: Foundation — Data Model, Auth, Policy Engine, Simulated Wallet

**Rationale:** The audit log and ledger are the bedrock — everything else writes to them, and they must be correct before payment logic is layered on top. Security-critical decisions (secret management, log masking, API schema strictness) cannot be retrofitted cheaply. The simulated wallet enables full API contract testing without real money, validating the entire request → policy → ledger flow before Phases 2-3 introduce real funds. Five of eight pitfalls must be addressed here.

**Delivers:** A fully functional HTTP API with agent registration, balance queries, payment requests (simulated), per-agent policy enforcement (per-transaction + daily spend limits), and an immutable audit log. An operator can register agents, assign balances, and simulate spend flows end-to-end.

**Features addressed:** Agent registration + static token auth, per-agent sub-account, balance query API, payment request API (sim mode), policy engine (core limits), append-only audit log

**Pitfalls to address:** Policy race condition (SELECT FOR UPDATE locking), prompt injection (strict Zod schema, no free-text policy fields), secret exposure (chmod 600, dedicated service user, log masking), audit log integrity (same-transaction writes, append-only table permissions)

**Research flag:** Standard patterns — double-entry ledger design, append-only log, and Fastify/Drizzle integration are well-documented. No additional phase research needed.

---

### Phase 2: Lightning Backend Integration

**Rationale:** Lightning is the primary external payment rail and the higher-complexity integration. Payment status ambiguity (Pitfall 2) and channel backup (Pitfall 6) are Lightning-specific and must be resolved before real funds flow. Lightning must be stable and load-tested before adding a second rail (Cashu) would complicate debugging.

**Delivers:** Real BOLT11 payment execution via LND; payment state machine with PENDING state; reconciliation against LND node state; least-privilege baked macaroon; automated Static Channel Backup. Agents can pay real Lightning invoices within their policy limits.

**Features addressed:** Lightning BOLT11 payment backend, invoice amount validation, destination whitelist enforcement, L402 payment foundation

**Pitfalls to address:** Lightning payment status ambiguity (payment_hash tracking, TrackPaymentV2 resolution), Lightning node data loss (automated SCB backup with SubscribeChannelEvents), least-privilege macaroon (invoice+offchain only, never admin.macaroon)

**Stack elements:** `lightning` npm package, LND 0.20.x in Docker, baked macaroon with `invoices:read invoices:write offchain:read offchain:write`

**Research flag:** May benefit from phase research on LND payment state machine edge cases (HTLC slot exhaustion, stuck payments, fee estimation). LND documentation is strong but concurrent payment handling is a known rough edge.

---

### Phase 3: Cashu Hot Wallet Integration

**Rationale:** Cashu is the secondary rail for low-latency, fee-free micropayments. It is architecturally isolated (Simulated Wallet interface makes it a drop-in replacement alongside Lightning) so it can be added without changing policy or ledger code. However, Cashu proof integrity (Pitfall 3) and keyset ID verification are security-critical and must be verified before any real tokens are issued.

**Delivers:** Self-hosted Nutshell mint as a sidecar container; ecash mint/melt/swap via cashu-ts; hot wallet with hard balance cap; top-up from Lightning (LN → ecash mint cycle); payment rail routing strategy (Lightning for external BOLT11, Cashu for small in-network transfers).

**Features addressed:** Cashu hot wallet backend, payment rail routing strategy, top-up and rebalancing foundation, Cashu NUT-07 state verification

**Pitfalls to address:** Cashu proof double-spend (verify Nutshell PENDING lock, concurrent redemption test with identical proofs), Cashu keyset ID verification (per July 2025 disclosure, verify keyset ID is correctly derived from public keys before accepting tokens)

**Stack elements:** `@cashu/cashu-ts` 3.5.x, Nutshell 0.19.x in Docker with PostgreSQL backend, Docker Compose sidecar configuration

**Research flag:** Nutshell PENDING lock implementation details should be verified via source inspection before Phase 3 begins. The July 2025 keyset ID vulnerability disclosure indicates active security research in this area.

---

### Phase 4: Operator Experience and Advanced Policy

**Rationale:** Once both payment rails are proven with real funds, operator-facing enhancements and the remaining policy primitives become the priority. The human approval workflow requires a tested payment flow to extend (soft-deny path branches off the already-working hard-deny path). Advanced policy primitives (daily loss tracking, time windows, whitelists) build on the same policy engine foundation without touching the ledger or wallet backends.

**Delivers:** Human approval workflow (pending state, operator webhook, timeout-to-deny); full policy primitive set (max balance, daily loss limit, whitelisted destinations, time-based windows); balance alert thresholds; policy versioning; operator activity endpoint.

**Features addressed:** Human approval workflow, remaining policy primitives (five dials from PROJECT.md), balance alert thresholds, policy versioning and history, simulated spend mode per agent

**Pitfalls to address:** Daily loss limit implementation (requires tracking net position, not just outbound spend — harder than transaction limits); approval timeout default must be DENY, not ALLOW

**Research flag:** Standard patterns for approval queues and policy versioning — no additional research needed. Daily loss limit computation (net position tracking across both payment rails) warrants a design spike before implementation.

---

### Phase Ordering Rationale

- **Foundation before backends:** The audit log and ledger are load-bearing — writing payment code before they exist creates unauditable state. Architecture research explicitly states: "Ledger is the source of truth — wallet settlements post to the ledger, not vice versa."
- **Simulated wallet enables early validation:** Milestone 1 can exercise 100% of the API contract without real funds. This is not a shortcut; it's the correct testing strategy for payment systems.
- **Lightning before Cashu:** Lightning is the primary rail and the more complex integration. Debugging payment state ambiguity with one backend is hard enough; adding a second before the first is stable increases blast radius.
- **Advanced policy last:** The policy engine foundation (Phase 1) is correct to build first because it enforces limits even when primitives are limited. The five-dial full primitive set enhances a working foundation rather than gating the initial deployment.
- **Security constraints are Phase 1, not Phase 4:** Secret management, log masking, fail-closed defaults, and strict schema validation are all Phase 1 requirements per pitfall-to-phase mapping. These cannot be retrofitted after real credentials are generated.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (Lightning):** LND payment state machine edge cases, HTLC slot exhaustion behavior, stuck payment recovery procedures. Lightning Labs documentation is official but some concurrent payment behavior is only documented in the issue tracker. Recommend `/gsd:research-phase` focused on LND `TrackPaymentV2`, `ListPayments`, and retry semantics.
- **Phase 3 (Cashu):** Nutshell PENDING lock source verification. Recommend reviewing Nutshell mint source for NUT-07 PENDING state implementation before writing Cashu integration code.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Double-entry ledger design, append-only audit tables, Fastify/Drizzle integration, and PostgreSQL row-level locking are all well-documented patterns with multiple high-confidence sources. Build directly.
- **Phase 4 (Operator/Advanced Policy):** Approval queue, webhook patterns, and policy versioning are standard CRUD patterns on top of the already-built foundation. No novel integration challenges.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All core library choices verified against official sources (npm registry, official GitHub repos, official docs). Version compatibility matrix confirmed. Lightning npm vs ln-service recommendation is explicit in official ln-service README. |
| Features | MEDIUM-HIGH | Core payment custody patterns HIGH confidence from official LND/Cashu docs. Agentic payment protocol comparisons MEDIUM confidence from multiple converging sources. Anti-features are well-reasoned from first principles. |
| Architecture | MEDIUM-HIGH | Double-entry ledger design and append-only audit patterns are HIGH confidence from fintech literature. Agent-specific treasury is an emerging pattern; verified against LNbits, Cashu CDK, and VLS custody model docs. Build order is derived from component dependency graph — logically correct. |
| Pitfalls | MEDIUM-HIGH | Core financial pitfalls (TOCTOU race, LN payment ambiguity, audit log integrity) are HIGH confidence from official issue trackers and formal literature. Cashu keyset vulnerability is MEDIUM confidence (security researcher disclosure, July 2025). Prompt injection risk is HIGH confidence (OWASP LLM Top 10 2025). |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **LND concurrent payment behavior under load:** The `lightning` npm package documentation covers individual payment operations thoroughly. Behavior when many HTLCs are in flight simultaneously (slot exhaustion, pathfinding failures, fee spike handling) is documented primarily in LND's GitHub issues rather than official guides. Address during Phase 2 planning via targeted research.
- **Nutshell PENDING lock correctness:** Research recommends Nutshell but flags that PENDING lock correctness must be verified via source inspection, not assumed. This is a go/no-go requirement before Phase 3 integration.
- **Daily loss limit computation:** Tracking net position (outbound minus inbound) across two payment rails with different settlement latencies is a genuinely novel design problem. No direct reference implementation was found. Address with a design spike at the start of Phase 4.
- **cashu-ts 3.5.x and Nutshell 0.19.x NUT compatibility:** Both libraries follow the Cashu NUT spec; cashu-ts 3.x is aligned with NUT-04/05/06. Compatibility should be verified with a minimal integration test before committing to full Cashu implementation in Phase 3.

---

## Sources

### Primary (HIGH confidence)
- [cashu-ts GitHub](https://github.com/cashubtc/cashu-ts) — v3.5.0, confirmed Feb 18 2026
- [Nutshell GitHub](https://github.com/cashubtc/nutshell) — v0.19.2, confirmed Feb 19 2026
- [Cashu NUT Specifications](https://cashubtc.github.io/nuts/) — NUT-03/04/05/06/07 mandatory specs
- [ln-service GitHub](https://github.com/alexbosworth/ln-service) — TypeScript redirect to `lightning` npm
- [Lightning Labs agent tools blog](https://lightning.engineering/posts/2026-02-11-ln-agent-tools/) — LND remote signer, macaroon scoping
- [lightning-agent-tools GitHub](https://github.com/lightninglabs/lightning-agent-tools) — Go+Docker architecture, L402/lnget patterns
- [LND disaster recovery docs](https://docs.lightning.engineering/lightning-network-tools/lnd/disaster-recovery) — SCB backup requirements
- [Cashu CDK GitHub](https://github.com/cashubtc/cdk) — "early development, API will change" warning
- [LND payment issues](https://github.com/lightningnetwork/lnd/issues/5357) — payment status ambiguity
- [OWASP LLM Top 10 2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — prompt injection #1 vulnerability
- [Fastify npm](https://www.npmjs.com/package/fastify) — v5.7.4, Node 20+ requirement
- [Pino npm](https://www.npmjs.com/package/pino) — v10.3.1 current
- [Vitest 4.0 release](https://vitest.dev/blog/vitest-4) — v4.0.18 stable
- [Node.js releases](https://nodejs.org/en/about/previous-releases) — Node 24 LTS ("Krypton")
- [Fintech double-entry ledger design](https://finlego.com/tpost/c2pjjza3k1-designing-a-real-time-ledger-system-with) — journal entry pattern
- [LND/LndHub sub-account documentation](https://docs.lightning.engineering/lightning-network-tools/lightning-terminal/accounts) — virtual balance isolation

### Secondary (MEDIUM confidence)
- [Bytebase Drizzle vs Prisma 2026](https://www.bytebase.com/blog/drizzle-vs-prisma/) — Drizzle fintech recommendation
- [Zod v4 InfoQ announcement](https://www.infoq.com/news/2025/08/zod-v4-available/) — v4 performance improvements
- [Modern Treasury ledger design](https://www.moderntreasury.com/learn/ledger-database) — double-entry principles
- [VLS Lightning custody models](https://vls.tech/posts/lightning-custody-models/) — custody spectrum
- [Cashu keyset ID vulnerability disclosure](https://conduition.io/code/cashu-disclosure/) — July 2025 security researcher disclosure
- [Cashu Highlights Q1/Q2 2025](https://blog.cashu.space/cashu-highlights-q1/) — ecosystem status
- [Galileo agentic payments guide](https://www.galileo-ft.com/blog/agentic-payments-secure-ai-banks-fintechs/) — industry analysis
- [LNbits architecture](https://docs.lnbits.org/) — sub-account reference comparison
- [Race condition in financial systems](https://www.sourcery.ai/vulnerabilities/race-condition-financial-transactions) — TOCTOU patterns

### Tertiary (LOW confidence, needs validation)
- [Proxy AI agent payments landscape 2026](https://www.useproxy.ai/blog/ai-agent-payments-landscape-2026) — could not fetch; claims from search snippet only
- [Crypto key management statistics 2024](https://coinlaw.io/self-custody-wallet-statistics/) — aggregated stats on key compromise rates

---
*Research completed: 2026-02-26*
*Ready for roadmap: yes*
