# arbstr-vault — Agent Treasury Service

A centralized treasury service that acts as a "bank" for AI agents. Holds all wallet keys, connects to Lightning (LND) and Cashu (self-hosted Nutshell mint) payment rails, manages per-agent sub-accounts with policy enforcement, and provides an auditable record of all economic actions.

Built for personal use — the sole customer is the operator plus their own agents.

## Features

- **Agent sub-accounts** — Register agents with isolated balances and bearer token auth
- **Policy engine** — Per-agent max transaction, daily spend limits, fail-closed DENY on error
- **Lightning payments** — Pay BOLT11 invoices via LND with correct state machine and crash recovery
- **Cashu hot wallet** — Self-hosted Nutshell mint with automatic Lightning/Cashu rail routing
- **Human approval** — Over-limit transactions enter a pending queue with configurable timeout
- **Versioned policies** — Append-only policy history with point-in-time evaluation
- **Balance alerts** — Per-agent floor threshold with webhook notification and cooldown
- **Operator dashboard** — All agents, balances, spend, utilization, policy state in one call
- **Audit log** — Append-only, atomic with every ledger update, filterable by agent/action/time
- **Withdrawals** — Agent-initiated with mandatory operator approval
- **Internal billing API** — Reserve/settle/release flow for service-to-service billing (e.g., per-request LLM costs)
- **Internal auth** — Shared secret token via `X-Internal-Token` header with constant-time comparison

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env — set VAULT_ADMIN_TOKEN (min 32 chars)

# Run database migrations
npm run db:migrate

# Start in simulated mode (no real funds)
npm run dev
```

The service starts on `http://localhost:3000` with `WALLET_BACKEND=simulated` by default.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAULT_ADMIN_TOKEN` | Yes | — | Admin bearer token (min 32 chars) |
| `DATABASE_PATH` | No | `./arbstr-vault.db` | SQLite database path |
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `NODE_ENV` | No | `development` | Environment |
| `WALLET_BACKEND` | No | `simulated` | `simulated`, `lightning`, `cashu`, or `auto` |
| `LND_HOST` | If Lightning | — | LND gRPC host |
| `LND_PORT` | No | `10009` | LND gRPC port |
| `LND_CERT_BASE64` | If Lightning | — | Base64-encoded LND TLS cert |
| `LND_MACAROON_BASE64` | If Lightning | — | Base64-encoded scoped macaroon |
| `CASHU_MINT_URL` | If Cashu | — | Nutshell mint URL |
| `CASHU_THRESHOLD_MSAT` | No | `1000000` | Auto-routing: below threshold uses Cashu |
| `OPERATOR_WEBHOOK_URL` | No | — | Webhook URL for operator notifications |
| `OPERATOR_WEBHOOK_SECRET` | No | — | HMAC-SHA256 secret for webhook signing |
| `VAULT_INTERNAL_TOKEN` | No | — | Shared secret (min 32 chars) for internal billing API |

## Wallet Backends

- **`simulated`** — No real funds. Identical API surface. Use for development and testing.
- **`lightning`** — Pay BOLT11 invoices via LND. Requires LND connection vars.
- **`cashu`** — Mint/melt Cashu tokens via self-hosted Nutshell. Requires `CASHU_MINT_URL`.
- **`auto`** — Dual-rail. Routes automatically based on amount and destination. Requires both Lightning and Cashu vars.

## API

All routes use JSON. Agent routes require a bearer token from registration. Operator routes require the admin token.

### Operator Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents` | Register a new agent |
| `GET` | `/agents` | List all agents |
| `GET` | `/agents/:id` | Get agent details and policy |
| `PATCH` | `/operator/agents/:id/policy` | Update agent policy (creates new version) |
| `PUT` | `/agents/:id/policy` | Replace agent policy (legacy) |
| `POST` | `/agents/:id/deposit` | Deposit funds to agent |
| `POST` | `/operator/approvals/:id/approve` | Approve a pending payment |
| `POST` | `/operator/approvals/:id/deny` | Deny a pending payment |
| `GET` | `/operator/approvals` | List pending approvals |
| `GET` | `/operator/dashboard` | Full agent dashboard |

### Agent Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents/:id/pay` | Submit a payment request |
| `GET` | `/agents/:id/balance` | Get agent balance |
| `GET` | `/agents/:id/history` | Get payment history |
| `GET` | `/agents/:id/payments/:txId` | Get payment status |
| `POST` | `/agents/:id/withdrawals` | Propose a withdrawal |

### Internal Billing Endpoints

Requires `VAULT_INTERNAL_TOKEN` to be configured. Authenticated via `X-Internal-Token` header.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/internal/reserve` | Reserve funds against an agent balance |
| `POST` | `/internal/settle` | Settle a reservation (deduct actual cost) |
| `POST` | `/internal/release` | Release an unused reservation |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health check |

## Development

```bash
# Run tests (simulated wallet, no external deps)
npm test

# Run tests in watch mode
npm run test:watch

# Generate DB migrations after schema changes
npm run db:generate

# Start regtest Lightning + Cashu environment
docker compose -f docker-compose.dev.yml up -d
```

### Regtest Environment

The `docker-compose.dev.yml` provides:
- **bitcoind** — Bitcoin Core in regtest mode
- **lnd-alice** — Treasury's LND node with scoped macaroon
- **lnd-bob** — Test payee node
- **nutshell** — Cashu mint backed by lnd-alice

See comments in `docker-compose.dev.yml` for manual channel setup steps.

## Architecture

- **Fastify** with Zod v4 validation and type-safe route schemas
- **Drizzle ORM** on **SQLite** (WAL mode) for the ledger, audit log, and policy store
- **buildApp()** factory with injected DB for test isolation
- **createPaymentsService(wallet)** factory for wallet backend injection
- **RESERVE/RELEASE/PAYMENT** ledger pattern for crash-safe async wallet calls
- **Append-only policy versions** with point-in-time evaluation
- **Fire-and-forget webhooks** with HMAC-SHA256 signing and exponential backoff

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js (ESM) |
| Framework | Fastify 5 |
| Language | TypeScript 5.9 |
| Database | SQLite via better-sqlite3 |
| ORM | Drizzle ORM |
| Validation | Zod v4 |
| Logging | Pino |
| Lightning | lightning (npm) → LND gRPC |
| Cashu | cashu-ts v3.5 → Nutshell mint |
| Testing | Vitest |

## License

ISC
