# Feature Research

**Domain:** Agent Treasury / Payment Custody Service (self-hosted, personal use)
**Researched:** 2026-02-26
**Confidence:** MEDIUM — core payment custody patterns are HIGH confidence from LND/Cashu official docs; agentic payment protocol comparisons are MEDIUM confidence from multiple converging sources; some "best practices" are LOW confidence from single-source WebSearch findings flagged below.

## Feature Landscape

### Table Stakes (Users Expect These)

These are the minimum features for the system to be functional. If any of these are missing, the treasury service cannot fulfill its core promise of being a "bank" for agents.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Agent registration and identity | Agents must be addressable — without identity, you can't track who owns what or enforce per-agent rules | LOW | Static bearer token per agent is sufficient for v1; no OAuth needed for personal-use single-operator scenario |
| Per-agent sub-account with balance tracking | Agents need isolated balances; without this it's a single shared wallet with no accountability | MEDIUM | LND Accounts (via litd) provides this natively with virtual balance isolation; LndHub is an alternative but mixes node operator funds with user funds (known limitation) |
| Balance query API | Agents must be able to ask "how much do I have?" before attempting a spend | LOW | Simple read endpoint; must return sub-account balance, not node total balance |
| Payment request (spend) API | Core action: agent submits a payment request, treasury executes or denies it | MEDIUM | Must be synchronous for small spends, async for large; response must include success/failure/pending state |
| Policy engine — per-agent spend limits | Without limits, a compromised agent drains the treasury; this is the core security guarantee | HIGH | Policy must be evaluated before any payment is dispatched to Lightning or Cashu backends; fail-closed on engine error |
| Append-only audit log | Every financial action and policy decision must be recorded with timestamp, agent identity, amount, destination, and outcome | MEDIUM | Immutable by design — no UPDATE/DELETE on log rows; critical for debugging and post-incident review |
| Lightning Network payment backend | Required to pay BOLT11 invoices — the primary payment rail for agent use cases (L402 APIs, node services) | HIGH | LND integration via gRPC; must handle invoice expiry, routing failures, and fee estimation |
| Cashu hot wallet backend | Required for low-latency, fee-free internal transfers and micropayments; Cashu mint acts as a second payment rail | HIGH | Self-hosted nutshell or cdk-mintd; requires understanding of NUT-04 (mint), NUT-05 (melt), NUT-07 (state check) |
| Payment history per agent | Agents and operator need to see past transactions — debugging, accounting, policy tuning | LOW | Filtered view of audit log; must not expose other agents' history |
| Fail-closed default | On any error (policy engine crash, backend timeout, parse error), the answer is DENY — never accidentally allow | LOW | This is an architectural constraint, not a feature, but must be explicit in every code path |
| Secret/key centralization | All wallet private keys, LN macaroons, Cashu mint credentials live in treasury only — agents receive only bearer tokens | MEDIUM | Agents authenticate to treasury with static tokens; treasury holds all secrets; agents never touch keys |

### Differentiators (Competitive Advantage)

These features are not assumed to exist but provide meaningful value beyond the table stakes. For a personal-use treasury, differentiators are about operator trust, auditability, and supporting diverse agent workloads.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Human approval workflow for over-limit transactions | Instead of hard-deny on limit breach, route to operator for approval; enables agents to handle exceptional but legitimate spends | MEDIUM | Requires a notification channel (webhook, signal, email) and a pending-payment state in audit log; approval must time out (default: DENY after N minutes) |
| Per-agent policy primitives: max balance, daily spend, daily loss, time windows, whitelisted destinations | Granular control lets operator tune risk per agent type — a trading agent needs different rules than a SaaS payment agent | MEDIUM | These are the "five dials" from PROJECT.md; each is independently configurable per agent; daily loss limit is hardest to implement correctly (requires tracking net position) |
| Simulated spend mode per agent | Lets operator validate agent behavior without real money movement; identical API surface to real mode | LOW | Agent cannot distinguish sim mode from real; treasury logs "SIMULATED" in audit log; useful for testing new agents |
| Payment rail routing strategy | Treasury chooses whether to use Lightning or Cashu for a given payment based on amount, fee, and destination type | MEDIUM | Routing logic: Cashu for small in-network transfers (zero fee), Lightning for external BOLT11 invoices; agents don't choose rails |
| Top-up and rebalancing between rails | Operator can move funds from Lightning to Cashu mint (and back) to maintain hot wallet liquidity | MEDIUM | Cashu mint holds capped balance; when mint balance drops below threshold, treasury can top up via Lightning melt/mint cycle |
| L402 payment support for API access | Agents can pay for L402-gated APIs (pay-per-use data, compute, tools) without managing their own Lightning wallets | HIGH | Lightning Labs released lightning-agent-tools (Feb 2026) with lnget and L402 middleware; treasury can proxy L402 flows on agent behalf |
| Policy versioning and history | Track policy changes over time — what limits applied when a disputed transaction occurred | MEDIUM | Append-only policy change log; each policy record has effective-from timestamp; policy evaluation uses the version active at payment time |
| Balance alert thresholds | Notify operator when any sub-account balance drops below a configured floor | LOW | Simple event emitted to operator notification channel; useful for proactive top-ups before agents hit zero |
| Agent activity dashboard (read-only) | Operator view: all agents, their balances, recent spend, policy state, daily utilization | MEDIUM | Not critical for agents to function but critical for operator trust; can be a simple CLI/JSON endpoint initially |
| Cashu token state verification (NUT-07) | Verify whether specific Cashu proofs are unspent before accepting them as payment | LOW | Prevents double-spend in edge cases; NUT-07 is well-specified in the Cashu protocol |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Agent-to-agent internal transfers | Seems useful for agent collaboration — one agent pays another for a service | Creates circular spend accounting that defeats per-agent loss limits; two agents can launder funds around the policy engine by passing tokens back and forth | Model agent-to-agent value exchange as external payments through Lightning/Cashu; each agent holds its own balance and pays invoices the other creates |
| Automated policy relaxation based on agent track record | "If an agent has been good for 30 days, increase its limits automatically" | Reward-based limit relaxation is a vector for gradual compromise; a slow-moving attack can stay under radar while building up to a large limit | Let operator manually review and increase limits; make limit increases a deliberate operator action, not an automated one |
| Real-time streaming payment events via WebSocket | Agents subscribing to live payment event streams | Adds server complexity; agents don't need real-time push — they can poll or receive webhook callbacks after a payment settles | Webhook POST on payment completion; agent polls balance endpoint; keep server stateless |
| Multi-operator / multi-user access to treasury | Supporting multiple human operators with different permission levels | Adds RBAC, session management, user accounts — substantial complexity that doesn't serve the personal-use case | Single operator with full access; all agents are "users" of the treasury, not operators; revisit if scope expands |
| On-chain Bitcoin custodian | Holding on-chain BTC in treasury for agents | On-chain transactions are slow and expensive for the micropayment use case agents need; managing UTXOs is complex | Use Lightning for external payments, Cashu for internal; on-chain only via Lightning channel management (handled by LND node, not treasury) |
| KYC / AML compliance hooks | Someone might want to add identity verification for agents | Personal-use treasury with own agents doesn't need regulatory compliance; KYC adds complexity and data-retention risk for no benefit | Explicitly out of scope; document the boundary in the API |
| CEX (exchange) connector in v1 | Trading agent needs market data and order placement | CEX API integration is a separate, complex domain (rate limits, authentication, order book management); mixing it into the treasury service violates single-responsibility | Trading agent holds its own CEX credentials; treasury only handles fund custody and payment rails; CEX connector is a separate service if needed |

## Feature Dependencies

```
[Agent Registration]
    └──requires──> [Static Token Auth]
                       └──enables──> [Balance Query API]
                       └──enables──> [Payment Request API]
                                         └──requires──> [Policy Engine]
                                                            └──requires──> [Audit Log]
                                                            └──requires──> [Agent Sub-Account]
                                         └──requires──> [Lightning Backend] OR [Cashu Backend]

[Payment Request API]
    └──enhances──> [Human Approval Workflow] (for over-limit requests)
    └──enhances──> [Simulated Spend Mode] (same API, sim flag per agent)

[Policy Engine]
    └──requires──> [Per-Agent Policy Primitives]
    └──enhances──> [Policy Versioning] (track what rules applied when)

[Cashu Backend]
    └──requires──> [Self-hosted Cashu Mint]
    └──enhances──> [Top-up and Rebalancing] (mint/melt cycle via Lightning)

[L402 Payment Support]
    └──requires──> [Lightning Backend]
    └──requires──> [Agent holds no Lightning credentials] (treasury proxies)

[Balance Alert Thresholds]
    └──requires──> [Per-Agent Sub-Account]
    └──enhances──> [Top-up and Rebalancing]
```

### Dependency Notes

- **Payment Request API requires Policy Engine:** The policy engine must evaluate every payment before dispatch. There is no "bypass" path. If the policy engine is not ready, payment dispatch is not ready.
- **Policy Engine requires Audit Log:** Policy decisions (allow/deny) must be recorded before the payment is attempted. The audit entry is written at decision time, not at settlement time.
- **Cashu Backend requires Self-hosted Cashu Mint:** The treasury service does not use a third-party mint — it operates its own. This is a deployment dependency, not a code dependency, but it must be resolved before Cashu payments are functional.
- **Human Approval Workflow enhances Payment Request API:** This is an optional extension to the payment request flow. Implement the hard-deny policy first, then add approval routing as a separate feature.
- **L402 Payment Support requires Lightning Backend:** L402 is Lightning-native. L402 flows cannot work until the LND integration is functional and tested.

## MVP Definition

### Launch With (v1)

Minimum viable product — enough to run real agent workloads safely.

- [ ] Agent registration + static token auth — without identity there are no agents
- [ ] Per-agent sub-account with balance tracking — core isolation guarantee
- [ ] Balance query API — agents must know their state before acting
- [ ] Payment request API (simulated mode only, for Milestone 1) — identical surface to real mode, safe to test
- [ ] Policy engine with: per-transaction limit, daily spend limit — minimum viable risk control; the two dials with the most immediate safety value
- [ ] Append-only audit log — every action recorded; non-negotiable even in sim mode
- [ ] Lightning BOLT11 payment backend — primary external payment rail
- [ ] Cashu hot wallet backend — secondary internal/micropayment rail

### Add After Validation (v1.x)

Features to add once the core skeleton is proven with real money movement.

- [ ] Human approval workflow for over-limit transactions — after validating that hard-deny works correctly, add the soft-deny-with-approval path
- [ ] Remaining policy primitives: max balance, daily loss limit, whitelisted destinations, time-based limits — add the full set of "five dials" from PROJECT.md once basic limits are proven
- [ ] Payment rail routing strategy (Lightning vs Cashu) — initially can default to Lightning; add intelligent routing once both rails are stable
- [ ] Balance alert thresholds — operator quality-of-life; add when running real workloads
- [ ] L402 payment proxying — add when an agent type actually needs to pay for L402-gated APIs
- [ ] Policy versioning — add when policy tuning becomes frequent enough that history matters

### Future Consideration (v2+)

Features to defer until the core is battle-tested and use cases are clear.

- [ ] Agent activity dashboard — useful but not required for a CLI/API-first system; defer until UI investment makes sense
- [ ] Top-up and rebalancing automation — manual top-up is sufficient initially; automate when operator friction becomes visible
- [ ] Cashu token state verification (NUT-07) — edge case protection; add if double-spend issues observed
- [ ] CEX connector — belongs in a dedicated service, not the treasury

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Agent registration + static token auth | HIGH | LOW | P1 |
| Per-agent sub-account with balance | HIGH | MEDIUM | P1 |
| Balance query API | HIGH | LOW | P1 |
| Payment request API (sim mode) | HIGH | MEDIUM | P1 |
| Policy engine (transaction + daily limit) | HIGH | HIGH | P1 |
| Append-only audit log | HIGH | MEDIUM | P1 |
| Lightning BOLT11 backend | HIGH | HIGH | P1 |
| Cashu hot wallet backend | HIGH | HIGH | P1 |
| Full policy primitive set | HIGH | MEDIUM | P2 |
| Human approval workflow | MEDIUM | MEDIUM | P2 |
| Payment rail routing strategy | MEDIUM | MEDIUM | P2 |
| Balance alert thresholds | MEDIUM | LOW | P2 |
| L402 payment proxying | MEDIUM | HIGH | P2 |
| Policy versioning | LOW | MEDIUM | P3 |
| Agent activity dashboard | MEDIUM | HIGH | P3 |
| Cashu NUT-07 state verification | LOW | LOW | P3 |
| Top-up/rebalancing automation | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor / Reference Feature Analysis

There are no direct competitors for a self-hosted personal-use agent treasury. The closest reference points are:

| Feature | LND Accounts (litd) | LndHub (BlueWallet) | Fireblocks / BitGo (enterprise) | Our Approach |
|---------|---------------------|---------------------|----------------------------------|--------------|
| Sub-account isolation | Virtual balance per macaroon; enforced by LND RPC middleware | Per-user balance in DB; node funds not truly isolated | Fully isolated wallets per account | Virtual sub-accounts tracked in treasury DB; Lightning node is a shared backend |
| Spend policy enforcement | Balance cap only; no daily limits or destination whitelists | None built-in | Configurable approval workflows, role-based limits | Custom policy engine: per-transaction, daily spend, daily loss, destination whitelist, time windows |
| Multiple payment rails | Lightning only | Lightning only | Multi-chain (ETH, BTC, etc.) | Lightning + Cashu; routing strategy chooses per payment |
| Audit log | Payment history filtered per account | Payment history per user | Full enterprise audit trail with compliance export | Append-only structured log; all events including policy decisions, not just settled payments |
| Human approval workflow | None | None | Multi-party approval (quorum signing) | Single-operator webhook/notification; pending state with timeout |
| Agent-native API | No — designed for human wallet users | No — designed for mobile wallet users | Partial — REST API but not agent-centric | First-class agent API: designed for programmatic access, not human wallets |
| Key custody | Keys on LND node | Keys on LND node | HSM / MPC key management | All keys in treasury service; agents never see keys |
| Simulated spend mode | No | No | Sandbox environment (separate) | Per-agent sim flag; same API, no real money movement |

**Key design principle from this analysis:** Existing tools (LND Accounts, LndHub) solve balance isolation at the Lightning node level but don't provide the policy engine, multi-rail routing, or audit depth needed. Fireblocks/BitGo provide those features but are enterprise-only and don't support Lightning/Cashu. Vaultwarden fills the gap: Lightning-native, self-hosted, policy-rich, agent-centric.

## Sources

- Lightning Labs LND Accounts documentation — https://docs.lightning.engineering/lightning-network-tools/lightning-terminal/accounts (HIGH confidence — official docs)
- LndHub GitHub repository — https://github.com/BlueWallet/LndHub (HIGH confidence — official source)
- Lightning Labs lightning-agent-tools GitHub — https://github.com/lightninglabs/lightning-agent-tools (HIGH confidence — official source, released Feb 12, 2026)
- Lightning Labs AI agent blog post, Feb 2026 — https://lightning.engineering/posts/2026-02-11-ln-agent-tools/ (HIGH confidence — official)
- Cashu NUT specifications — https://cashubtc.github.io/nuts/ (HIGH confidence — official protocol specs)
- Cashu nutshell GitHub — https://github.com/cashubtc/nutshell (HIGH confidence — official source)
- Cashu Highlights Q1/Q2 2025 — https://blog.cashu.space/cashu-highlights-q1/ (MEDIUM confidence — official blog)
- Chimoney AI wallet spending limits docs — https://chimoney.io/intro-learning-and-tips/spending-limits-for-ai-wallets/ (MEDIUM confidence — implementation reference, not authoritative for all designs)
- Galileo agentic payments strategic guide — https://www.galileo-ft.com/blog/agentic-payments-secure-ai-banks-fintechs/ (MEDIUM confidence — industry analysis, multiple claims verified against other sources)
- Orium agentic payments ACP/AP2/x402 explainer — https://orium.com/blog/agentic-payments-acp-ap2-x402 (MEDIUM confidence — multi-source synthesis)
- Agentic payments overview, Visa UK — https://www.visa.co.uk/content/dam/VCOM/regional/ve/unitedkingdom/PDF/agentic-payments.pdf (MEDIUM confidence — industry whitepaper)
- Proxy AI agent payments landscape 2026 — https://www.useproxy.ai/blog/ai-agent-payments-landscape-2026 (LOW confidence — could not fetch; claims from search snippet only)

---
*Feature research for: Agent Treasury / Payment Custody Service (Vaultwarden)*
*Researched: 2026-02-26*
