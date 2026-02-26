# Architecture Research

**Domain:** Agent Treasury / Payment Custody Service
**Researched:** 2026-02-26
**Confidence:** MEDIUM-HIGH (core patterns well-established; agent-specific treasury is an emerging pattern, verified against LNbits, Cashu CDK, and fintech ledger literature)

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          AGENT CONSUMERS                              │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│   │ Trading Agent│  │ E-Commerce   │  │ PRD/MVP Agent│              │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
└──────────┼─────────────────┼─────────────────┼──────────────────────┘
           │  HTTP/JSON + Static Token Auth     │
           ▼                 ▼                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          API LAYER                                    │
│   POST /agents/{id}/pay   GET /agents/{id}/balance                   │
│   POST /agents/{id}/quote GET /agents/{id}/history                   │
│   POST /agents            GET /policy/{id}                           │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                  ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  POLICY ENGINE   │ │   SUB-ACCOUNT    │ │   AUDIT LOG      │
│                  │ │   LEDGER         │ │                  │
│ - Per-agent rules│ │ - Double-entry   │ │ - Append-only    │
│ - Spend limits   │ │ - Agent balances │ │ - Every decision │
│ - Allow/Deny/Hold│ │ - Txn history    │ │ - Policy results │
│ - Approval queue │ │ - Idempotency    │ │ - Wallet events  │
└────────┬─────────┘ └──────┬───────────┘ └──────────────────┘
         │                  │
         ▼                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       WALLET BACKEND LAYER                            │
│                                                                       │
│   ┌─────────────────────────┐  ┌─────────────────────────┐          │
│   │   LIGHTNING BACKEND     │  │    CASHU BACKEND         │          │
│   │                         │  │                           │          │
│   │  LND/CLN node           │  │  Self-hosted mint         │          │
│   │  Pay BOLT11 invoices    │  │  Ecash proofs             │          │
│   │  L402 payments          │  │  Hot wallet (cap'd)       │          │
│   │  Separate container     │  │  Separate container       │          │
│   └─────────────────────────┘  └─────────────────────────┘          │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Communicates With |
|-----------|----------------|-------------------|
| API Layer | Authenticate agents, route requests, validate input | Policy Engine, Sub-account Ledger, Audit Log |
| Policy Engine | Evaluate spend rules, enforce limits, route to approval queue | Sub-account Ledger (read balance), Audit Log (write decisions), Approval Queue |
| Approval Queue | Hold pending transactions for human review | API Layer (polling/webhook), Policy Engine |
| Sub-account Ledger | Track per-agent balances using double-entry bookkeeping, enforce idempotency | Wallet Backend Layer (on confirmed payment), Audit Log |
| Audit Log | Append-only record of every financial action and policy decision | Written by all other components; never mutated |
| Lightning Backend | Execute outbound LN payments, receive inbound LN payments, support L402 | Sub-account Ledger (on settlement), Audit Log |
| Cashu Backend | Issue/redeem ecash proofs, serve as hot wallet | Sub-account Ledger (on mint/melt), Audit Log |

## Recommended Project Structure

```
src/
├── api/                   # HTTP handlers, routing, auth middleware
│   ├── agents.rs          # Agent registration endpoints
│   ├── payments.rs        # Pay / quote endpoints
│   ├── balances.rs        # Balance / history query endpoints
│   └── middleware.rs      # Static token auth, rate limiting
├── policy/                # Policy engine — core business logic
│   ├── engine.rs          # evaluate(agent_id, request) -> Decision
│   ├── rules.rs           # Rule types: daily limit, max balance, whitelist
│   └── queue.rs           # Approval queue: pending, approve, deny
├── ledger/                # Double-entry sub-account ledger
│   ├── accounts.rs        # Account registry (per-agent + system accounts)
│   ├── entries.rs         # Append-only journal entries
│   ├── balances.rs        # Balance computation from entries
│   └── idempotency.rs     # Duplicate payment prevention
├── audit/                 # Immutable audit log
│   └── log.rs             # Structured append-only event writer
├── wallets/               # Wallet backend abstraction
│   ├── mod.rs             # WalletBackend trait
│   ├── lightning.rs       # LND/CLN gRPC/REST client
│   ├── cashu.rs           # Cashu CDK mint client
│   └── simulated.rs       # Fake wallet for dev/test (Milestone 1)
├── agents/                # Agent registry and sub-account setup
│   └── registry.rs        # Register agent, assign sub-account
└── config.rs              # Secrets, backend URLs, policy defaults
```

### Structure Rationale

- **policy/:** Separated from api/ because policy logic must be testable in isolation without HTTP concerns. Policy changes are the highest-risk surface area.
- **ledger/:** Separate from wallets/ because ledger entries are the source of truth — wallet settlements post to the ledger, not vice versa.
- **audit/:** Separate module with no inbound dependencies — everything writes to it, nothing reads from it in the request path.
- **wallets/simulated.rs:** Milestone 1 requires a fake backend that records intended payments without touching real funds. This lives alongside real backends behind the same trait.

## Architectural Patterns

### Pattern 1: Policy-Before-Execute (Fail-Closed)

**What:** Every payment request passes through the policy engine before any wallet operation is attempted. If policy evaluation fails for any reason (error, timeout, missing config), the default result is DENY.

**When to use:** Always. This is the core safety invariant of the system.

**Trade-offs:** Adds latency to every payment. Justified because the alternative (optimistic execution + rollback) is extremely difficult with external payment rails that may partially settle.

**Example:**
```rust
async fn handle_pay_request(agent_id: AgentId, req: PayRequest) -> Result<PayResponse> {
    let decision = policy_engine.evaluate(&agent_id, &req).await?;
    match decision {
        Decision::Allow => {
            audit_log.write(Event::PolicyAllow { agent_id, req }).await?;
            let result = wallet_backend.pay(&req).await?;
            ledger.record_debit(&agent_id, &result).await?;
            audit_log.write(Event::PaymentExecuted { agent_id, result }).await?;
            Ok(result.into())
        }
        Decision::Deny(reason) => {
            audit_log.write(Event::PolicyDeny { agent_id, req, reason }).await?;
            Err(Error::PolicyDenied(reason))
        }
        Decision::HoldForApproval => {
            let pending = approval_queue.enqueue(&agent_id, &req).await?;
            audit_log.write(Event::QueuedForApproval { agent_id, req, pending_id: pending.id }).await?;
            Ok(PayResponse::Pending(pending.id))
        }
    }
}
```

### Pattern 2: Double-Entry Sub-Account Ledger

**What:** Each agent has a sub-account. Every balance movement requires two entries: a debit from one account and a credit to another. The system account "@external" absorbs the other side of real-world payments.

**When to use:** Whenever tracking balances for multiple agents. Double-entry prevents phantom balance creation and makes reconciliation straightforward.

**Trade-offs:** More complex than a simple balance counter. Worth it because it makes auditing, reconciliation, and bug-hunting dramatically easier. Balance drift becomes detectable.

**Example:**
```rust
// Agent spends 1000 sats
ledger.post_transaction(vec![
    Entry { account: agent_account, amount: -1000, currency: Sat },
    Entry { account: system_external, amount: +1000, currency: Sat },
]).await?;

// External payment received (inbound)
ledger.post_transaction(vec![
    Entry { account: agent_account, amount: +5000, currency: Sat },
    Entry { account: system_external, amount: -5000, currency: Sat },
]).await?;
```

### Pattern 3: Wallet Backend Trait Abstraction

**What:** All wallet backends (Lightning, Cashu, Simulated) implement a common `WalletBackend` trait. The policy engine and ledger do not import any wallet-specific code.

**When to use:** From day one. Allows Milestone 1 to ship with a simulated backend, then swap in real backends without touching policy or ledger code.

**Trade-offs:** Requires discipline to keep the trait surface minimal. Don't expose Lightning-specific concepts (channels, HTLCs) through the trait; abstract to pay/receive/status.

```rust
#[async_trait]
pub trait WalletBackend: Send + Sync {
    async fn pay_bolt11(&self, invoice: &str, max_fee_sats: u64) -> Result<PaymentResult>;
    async fn get_balance(&self) -> Result<u64>;
    async fn create_invoice(&self, amount_sats: u64, memo: &str) -> Result<Invoice>;
}
```

### Pattern 4: Append-Only Audit Log with Structured Events

**What:** Every policy decision, payment attempt, error, and configuration change writes a structured event to an append-only log. Events are never updated, only appended.

**When to use:** For all financial and security-relevant actions. This is the non-negotiable compliance record.

**Trade-offs:** Storage grows indefinitely. Use a database table with no DELETE permission granted to the application user, or write to an insert-only log file.

**Example event types:**
```rust
enum AuditEvent {
    AgentRegistered { agent_id, policy_config, timestamp },
    PolicyEvaluated { agent_id, request, decision, rule_matched, timestamp },
    PaymentAttempted { agent_id, backend, invoice, timestamp },
    PaymentSettled { agent_id, backend, payment_hash, fee_sats, timestamp },
    PaymentFailed { agent_id, backend, invoice, error, timestamp },
    ApprovalQueued { pending_id, agent_id, request, timestamp },
    ApprovalGranted { pending_id, approver, timestamp },
    ApprovalDenied { pending_id, approver, reason, timestamp },
    LimitExceeded { agent_id, limit_type, current_value, limit_value, timestamp },
}
```

## Data Flow

### Payment Request Flow

```
Agent HTTP Request (POST /agents/{id}/pay, Authorization: Bearer <token>)
    ↓
API Layer
    ├── Authenticate static token → identify agent_id
    ├── Parse and validate PayRequest
    └── Call policy_engine.evaluate(agent_id, request)
         ↓
Policy Engine
    ├── Load agent policy (max balance, daily limit, whitelist)
    ├── Read current balance from Ledger
    ├── Read today's spend total from Ledger
    ├── Evaluate rules → Decision (Allow / Deny / HoldForApproval)
    └── Write PolicyEvaluated event to Audit Log
         ↓ (if Allow)
Wallet Backend
    ├── Execute payment (Lightning: pay_bolt11 / Cashu: melt)
    ├── Receive PaymentResult (success, fee, payment_hash)
    └── Write PaymentSettled or PaymentFailed to Audit Log
         ↓ (if PaymentSettled)
Sub-account Ledger
    ├── Post double-entry transaction (debit agent, credit @external)
    ├── Enforce idempotency on payment_hash
    └── Update balance (derived from entries, not a mutable counter)
         ↓
API Layer returns PayResponse to Agent
```

### Balance Query Flow

```
Agent HTTP Request (GET /agents/{id}/balance)
    ↓
API Layer → authenticate → ledger.get_balance(agent_id)
    ↓
Ledger: SUM(debits) - SUM(credits) from journal entries
    ↓
Return balance response (no wallet backend involved)
```

### Approval Queue Flow

```
Policy Engine → HoldForApproval
    ↓
Approval Queue: persist pending_tx, notify operator (webhook / log)
    ↓
Operator reviews → POST /approvals/{id}/approve or /deny
    ↓
If approve: re-enter payment flow at Wallet Backend step
If deny: write ApprovalDenied to Audit Log, return error to polling agent
```

### Key Data Flows

1. **Outbound payment (Lightning):** Agent request → Policy check → LND/CLN pay_bolt11 → Ledger debit → Audit event
2. **Cashu hot wallet top-up:** Lightning invoice received at Cashu mint → Ecash minted → Ledger credit to system float account
3. **Agent sub-account funding:** Operator posts internal transfer → Ledger: debit system float, credit agent account → no wallet backend call
4. **Daily limit reset:** Background job at midnight → Audit event recording reset; limit is computed from ledger entries within rolling window, not a mutable counter

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1-5 agents (personal use, v1) | Single process monolith; SQLite for ledger and audit log; simulated wallet backend in Milestone 1 |
| 5-50 agents | Postgres for ledger; add connection pooling; Lightning and Cashu backends on separate containers as already planned |
| 50-500 agents | Consider read replicas for balance queries; policy evaluation can stay synchronous at this scale |
| 500+ agents | Unlikely for personal use case; would require async policy evaluation, queue-based wallet calls, and horizontal API scaling |

### Scaling Priorities

1. **First bottleneck:** Policy engine and ledger read contention (many agents querying balance simultaneously). Fix: read-optimized balance view materialized from journal entries on each write.
2. **Second bottleneck:** Lightning node becoming the gating resource (HTLC slots, channel capacity). Fix: Cashu hot wallet absorbs small frequent payments; Lightning reserved for larger settlements.

## Anti-Patterns

### Anti-Pattern 1: Mutable Balance Counters

**What people do:** Store `balance = balance - amount` as an UPDATE on a balance row.
**Why it's wrong:** A bug, crash between operations, or double-spend causes permanent balance corruption. No way to audit what happened.
**Do this instead:** Never store balances as mutable state. Derive balance by summing journal entries. The ledger is append-only.

### Anti-Pattern 2: Wallet Keys in the Agent Process

**What people do:** Pass LND macaroon or Cashu wallet keypair directly to agent environment variables so agents can pay without calling back to the treasury.
**Why it's wrong:** One compromised agent exposes all funds. Defeats the entire purpose of the treasury service.
**Do this instead:** All keys live exclusively in the Treasury Service. Agents hold only their own static API token, which grants access only to their own sub-account and within their own policy limits.

### Anti-Pattern 3: Optimistic Execution Without Policy Check

**What people do:** Execute the payment first, then check if the agent was allowed to make it, and roll back if not.
**Why it's wrong:** External payments (Lightning, Cashu) cannot be reliably rolled back. A denied-but-executed payment creates a real fund loss with no recourse.
**Do this instead:** Policy check is always first, always synchronous, always fail-closed.

### Anti-Pattern 4: Audit Log as a Side Effect

**What people do:** Fire-and-forget audit log writes ("we'll log it eventually").
**Why it's wrong:** If the audit write fails and the payment succeeds, the event is permanently lost. You cannot reconstruct what happened.
**Do this instead:** Treat audit writes as part of the same transaction unit as the business operation. If audit write fails, treat the entire operation as failed. Accept the latency cost.

### Anti-Pattern 5: Single Hot Wallet for All Agents

**What people do:** Fund one shared Lightning wallet for all agents; track balances only in software.
**Why it's wrong:** If the software ledger drifts from the actual wallet balance (bug, crash, missed event), you cannot tell which agent's "balance" is wrong. Reconciliation becomes impossible.
**Do this instead:** The double-entry ledger makes all money movements traceable. A `@system_float` account bridges real wallet balances to agent virtual balances. Run periodic reconciliation: `@system_float` balance must match actual wallet balance.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| LND/CLN Lightning node | gRPC (LND) or REST/socket (CLN); separate container | Treasury holds macaroon; poll for settled invoices via subscription |
| Cashu CDK mint | REST HTTP; separate container | Treasury holds mint admin credentials; use NUT-04/05 for mint/melt |
| L402-gated APIs | Agent calls treasury to get payment preimage; treasury pays the 402 | Treasury proxies the payment, agent never touches LN directly |
| Operator approval channel | Webhook push or polling endpoint | Human must be able to approve/deny without complex tooling |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| API Layer ↔ Policy Engine | Direct function call (same process) | No network hop; policy must be synchronous and fast |
| Policy Engine ↔ Ledger | Direct function call (same process) | Policy reads balance; must be consistent read |
| Policy Engine ↔ Approval Queue | Direct call; queue persisted in DB | Queue survives process restart |
| API/Policy ↔ Audit Log | Direct async write (same process) | Treat failures as fatal to the operation |
| Treasury ↔ Lightning Backend | HTTP/gRPC over loopback or private network | Never exposed to internet; TLS optional on localhost |
| Treasury ↔ Cashu Backend | HTTP REST over loopback or private network | Same isolation as Lightning |

### Build Order (Phase Dependencies)

The component dependency graph dictates build order:

```
1. Audit Log          → (no dependencies; all others depend on it)
2. Sub-account Ledger → depends on: Audit Log
3. Agent Registry     → depends on: Ledger (creates accounts)
4. Simulated Wallet   → depends on: nothing (implements WalletBackend trait)
5. Policy Engine      → depends on: Ledger (balance reads), Audit Log
6. Approval Queue     → depends on: Policy Engine, Audit Log, Ledger
7. API Layer          → depends on: all above
8. Lightning Backend  → replaces Simulated Wallet; depends on: Ledger, Audit Log
9. Cashu Backend      → adds second real wallet; depends on: Ledger, Audit Log
```

**Implication for milestones:**
- Milestone 1 can complete items 1-7 with simulated wallet. Full payment API is exercisable without touching real money.
- Milestone 2 adds Lightning Backend (item 8), replacing simulated wallet in the same slot.
- Milestone 3 adds Cashu Backend (item 9) as a parallel backend option.

## Sources

- Cashu CDK mint architecture (MEDIUM confidence — verified via DeepWiki/official CDK docs): https://deepwiki.com/cashubtc/cdk/4.1-mint-architecture
- LNbits sub-account architecture (MEDIUM confidence — verified via DeepWiki and official docs): https://deepwiki.com/lnbits/lnbits, https://docs.lnbits.org/
- VLS Lightning custody model spectrum (MEDIUM confidence — official VLS documentation): https://vls.tech/posts/lightning-custody-models/
- Modern Treasury ledger database design principles (MEDIUM confidence — official docs): https://www.moderntreasury.com/learn/ledger-database
- AI agent payment system architecture — Proxy blog (LOW confidence — single commercial source): https://www.useproxy.ai/blog/ai-agent-payments-landscape-2026
- Lightning Labs agent tools and L402 (MEDIUM confidence — official Lightning Labs blog): https://lightning.engineering/posts/2026-02-11-ln-agent-tools/
- Fintech ledger double-entry design (HIGH confidence — multiple verified sources agree): https://finlego.com/tpost/c2pjjza3k1-designing-a-real-time-ledger-system-with, https://www.architecture-weekly.com/p/building-your-own-ledger-database
- Cashu CDK GitHub (HIGH confidence — official source): https://github.com/cashubtc/nutshell

---
*Architecture research for: Agent Treasury Service (Vaultwarden)*
*Researched: 2026-02-26*
