Below is a concise draft PRD you can hand to Claude and iterate on.

***

# PRD: Agent Treasury Service with Per‑Agent Accounts

## 1. Overview

Build an **Agent Treasury Service** that acts as a centralized “bank” for AI agents.  
It holds keys, connects to payment rails (Lightning/L402, Cashu, exchanges), manages **per‑agent sub‑accounts**, enforces spend policies, and provides an auditable record of all economic actions.

Audience: me (as sole customer) plus my own agents. Future‑ready for external users but not required in v1.

## 2. Goals and Non‑Goals

### Goals

- Allow multiple AI agents to:
  - Hold balances in sub‑accounts.
  - Request payments/spends within explicit policy limits.
  - Query balances, history, and policy state.

- Centralize custody and policy:
  - All keys and connections (LN, Cashu, exchange APIs) live in the Treasury Service, not in agents.
  - All payments go through a **policy engine** that can allow/deny/require human approval.

- Provide strong observability:
  - Append‑only audit log for every financial action and policy decision.
  - Easy to inspect in code, logs, or a simple dashboard.

### Non‑Goals (for v1)

- No external human customers; only my own agents and test harnesses.
- No compliance/KYC features.
- No multi‑jurisdiction regulatory support.
- No sophisticated risk models (basic rules/limits are enough at first).

## 3. Primary Use Cases

### 3.1 Trading Agent

- Maintains a sub‑account with:
  - Base currency (BTC; optionally USD-equivalent).
- Needs to:
  - Pay for market data/API calls (via L402 or direct API billing).
  - Place and cancel orders on specific exchanges.
  - Withdraw profits back to a “master” wallet occasionally.
- Policy examples:
  - Max position size per market.
  - Max daily realized loss.
  - Max spend per day on data/API.

### 3.2 E‑Commerce Operations Agent

- Manages a small e‑commerce storefront (e.g., print‑on‑demand or digital products).
- Needs to:
  - Pay for SaaS tools (email, hosting, analytics).
  - Pay for small ad campaigns.
  - Issue refunds within limits.
- Policy examples:
  - Spend caps per day per SaaS vendor/ad channel.
  - Price/margin guardrails for SKUs.
  - Max refund per order and per day.

### 3.3 PRD/MVP Builder Agent

- Mostly uses compute and APIs; minimal financial activity.
- Needs to:
  - Pay for small design assets, temporary infra, or API trials.
- Policy examples:
  - Very small per‑idea “exploration budget”.
  - No recurring subscriptions without human approval.

## 4. System Architecture (High‑Level)

### 4.1 Core Components

1. **Treasury Service API**
   - Internal HTTP/JSON (or gRPC) service.
   - Authentication via static tokens per agent in v1.
   - Exposes endpoints for:
     - Agent registration and sub‑account setup.
     - Balance queries.
     - Spend/payment requests.
     - Withdrawal proposals.
     - Policy queries.
     - Access to audit logs (for me).

2. **Wallet Backends**
   - **Lightning / L402 backend**:
     - Single LN wallet/node controlled by the service.
     - Ability to:
       - Pay Lightning invoices (for L402 and other LN uses).
       - Optionally generate invoices (for inbound funding).
   - **Cashu backend**:
     - One self‑hosted mint (v1) used as hot wallet.
     - Ability to:
       - Issue tokens against BTC backing.
       - Redeem tokens for BTC (to LN wallet or on‑chain).
   - Optional later: CEX connectors (e.g., Kraken, Coinbase) via API keys.

3. **Policy Engine**
   - Evaluates each requested action:
     - Inputs: agent ID, requested action (amount, asset, destination, context), current balances, historical actions.
     - Output: ALLOW, DENY, or REQUIRE_HUMAN_APPROVAL.
   - Policy primitives (v1):
     - Per‑agent max balance.
     - Per‑agent daily spend limit.
     - Per‑agent daily loss limit (for trading).
     - Whitelisted destinations (endpoints, vendors, exchanges).
     - Time‑based limits (e.g., per day / per hour caps).

4. **Audit Log**
   - Append‑only log (e.g., write‑only DB table or log file) with:
     - Timestamp.
     - Agent ID.
     - Action type and parameters.
     - Policy decision (ALLOW/DENY/REQUIRE_APPROVAL).
     - Result (success/failure, tx IDs).
     - Optional free‑form “reason” from the agent.
   - Ideally signed or at least tamper‑evident (v2).

## 5. API Design (Draft)

These are *internal* APIs between agents and the Treasury Service.

### 5.1 Agent Management

- `POST /agents`
  - Create/register a new agent with:
    - `name`
    - `initial_policies` (optional)
  - Returns:
    - `agent_id`
    - `api_key` (for auth)

- `GET /agents/{agent_id}`
  - Retrieve agent metadata and current policy snapshot.

### 5.2 Balances and Accounts

- `GET /agents/{agent_id}/balances`
  - Returns:
    - Per‑asset balances (e.g., `BTC_on_LN`, `BTC_cashu`, `USD_CEX_simulated`).

- `GET /agents/{agent_id}/limits`
  - Returns effective policy limits:
    - Max daily spend, loss limits, whitelists.

### 5.3 Spend / Payment Requests

- `POST /agents/{agent_id}/payments/request`
  - Request to spend from agent’s account.
  - Body:
    - `amount` (numeric)
    - `asset` (e.g., `BTC`, `SAT`)
    - `purpose` (enum or string: `TRADING_ORDER`, `DATA_API`, `REFUND`, etc.)
    - `destination_type` (e.g., `LIGHTNING_INVOICE`, `HTTP_L402`, `CASHU_TOKEN`, `EXCHANGE_ORDER`)
    - `destination_details` (invoice string, URL, exchange order spec, etc.)
    - `context` (optional free‑form metadata or reasoning)
  - Treasury behavior:
    - Evaluate policies, log decision.
    - If ALLOW:
      - Perform payment via appropriate backend.
      - Return success + transaction reference (invoice paid, order ID, etc.).
    - If DENY:
      - Return error with reason.
    - If REQUIRE_HUMAN_APPROVAL:
      - Mark as pending; expose in an admin view or CLI for my manual decision.

### 5.4 Withdrawals

- `POST /agents/{agent_id}/withdrawals/propose`
  - Agent proposes to withdraw funds to a master wallet or external address.
  - Usually restricted; may always require human approval.

### 5.5 Audit and Logs

- `GET /audit/events`
  - Filter by:
    - `agent_id`
    - `action_type`
    - `from_timestamp` / `to_timestamp`
  - Returns structured events for review.

## 6. Policy Model (v1)

We want a simple but expressive policy model; can be JSON‑backed.

Per‑agent configurable fields:

- `max_daily_spend` (per asset).
- `max_single_tx_amount`.
- `max_daily_loss` (for trading agents).
- `allowed_destination_types` (e.g., only `LIGHTNING_INVOICE` and `L402`).
- `allowed_counterparties` (list of whitelisted:
  - L402 endpoints (hostnames).
  - Lightning node pubkeys or invoice metadata.
  - Exchange IDs / markets.
- `requires_approval_over` (amount threshold).
- Optional: `active_time_windows` (e.g., only trade 09:00–17:00 UTC).

Implementation detail: policies live in a simple DB table keyed by `agent_id` and are cached in memory.

## 7. Security and Reliability Requirements

- Treasury Service:
  - Runs on hardened host or container.
  - Access locked down to known networks/agents.
  - Secrets stored securely (vault/FS with strict permissions).

- Wallet backends:
  - Lightning node and Cashu mint run on separate hosts or containers; Treasury talks to them over secure channels.
  - On‑chain/LN keys backed up.
  - Cashu mint treated as hot wallet with limited balance; periodic reconciliation from a separate cold/warmer wallet.

- Failure modes:
  - If Treasury is down, agents cannot move money (fail closed).
  - If policy engine fails, default to DENY.

## 8. Milestones

### Milestone 1: Skeleton Treasury + One Agent

- Minimal Treasury Service with:
  - Static config for one agent.
  - In‑memory balances (no real LN/Cashu).
  - Payment requests that simply “simulate” spends and log events.

### Milestone 2: Real Lightning + Cashu Integration

- Hook up to:
  - One LN wallet/node with ability to pay invoices.
  - One self‑hosted Cashu mint.
- Replace simulated spends with real payments.

### Milestone 3: Real Trading Bot Integration

- Build or integrate a simple trading bot that:
  - Gets its account from Treasury.
  - Requests all spends via Treasury.
- Enforce policies:
  - Daily maximum loss and spend.
  - Whitelisted markets/exchanges.

### Milestone 4: E‑Commerce Agent Pilot

- Integrate a small storefront.
- Use Treasury for:
  - Paying a SaaS or API.
  - Issuing small refunds.
- Add basic reporting of revenue vs agent spends.

***


- Design the data models and API schemas.  
- Propose a concrete implementation (language, frameworks, infra).  
- Stub out code for the Treasury Service and a simple test agent.
