# arbstr-vault — Agent Treasury Service

A centralized treasury service that acts as a "bank" for AI agents. Holds all wallet keys, connects to Lightning (LND) and Cashu (self-hosted Nutshell mint) payment rails, manages per-agent sub-accounts with policy enforcement, and provides an auditable record of all economic actions.

Built for personal use — the sole customer is the operator plus their own agents.

> [!CAUTION]
> **DANGER**
>
> This project is experimental and under active development. It is **not hardened, audited, or production-ready**.
>
> Storing credentials, tokens and keys to financial resources involves **real financial risk**. Misconfiguration, bugs, or incomplete understanding can result in **permanent loss of funds**.
>
> Do **not** use this software with real money unless you fully understand the transaction end-to-end, have reviewed the code, and are prepared to lose all funds involved.
>
> **You are solely responsible for any loss of funds.**

## How this fits in

arbstr-vault is the treasury half of [arbstr](https://github.com/johnzilla/arbstr), a router that sends AI inference to the cheapest provider and meters it in sats. arbstr core routes LLM requests to the cheapest qualified provider and calls vault's `/internal/reserve → settle|release` endpoints per request to meter spend against agent sub-accounts. Vault is also usable standalone as a personal agent bank — nothing in this repo depends on arbstr code.

To run the full stack (core + vault + LND + Cashu mint) with a single `docker compose up`, see [arbstr-node](https://github.com/johnzilla/arbstr-node), which runs the published `ghcr.io/johnzilla/arbstr-vault` image pinned to a [release](https://github.com/johnzilla/arbstr-vault/releases).

## Features

- **Agent sub-accounts** — Register agents with isolated balances and bearer token auth
- **Policy engine** — Per-agent max transaction, daily spend limits, fail-closed DENY on error
- **Lightning payments** — Pay BOLT11 invoices via LND with correct state machine and crash recovery
- **Cashu hot wallet** — Self-hosted Nutshell mint with automatic Lightning/Cashu rail routing
- **Human approval** — Over-limit `/pay` requests enter a pending queue with a configurable timeout
- **Versioned policies** — Append-only policy history with point-in-time evaluation
- **Balance alerts** — Per-agent floor threshold with webhook notification and cooldown
- **Operator dashboard** — All agents, balances, spend, utilization, policy state in one call
- **Audit log** — Append-only and written atomically with every ledger update. Operators query it via `/operator/audit`; agents read their own history via `/agents/:id/history`
- **Withdrawals** — Agent-initiated with mandatory operator approval
- **Internal billing API** — Reserve/settle/release flow for service-to-service billing (e.g., per-request LLM costs), with policy enforcement and automatic release of stale reservations
- **Internal auth** — Shared secret token via `X-Internal-Token` header with constant-time comparison

## Quick Start

Requires **Node.js 22** (see `.nvmrc`). `better-sqlite3` does not build on newer majors.

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env — set VAULT_ADMIN_TOKEN (min 32 chars; e.g. openssl rand -hex 32)

# Start in simulated mode (no real funds). Migrations run automatically on start.
npm run dev
```

The service starts on `http://localhost:3000` with `WALLET_BACKEND=simulated` by default.

Or run the published image (multi-arch; `:latest` tracks main, releases publish `:X.Y.Z`):

```bash
docker run -p 3000:3000 -v vault-data:/data -e DATABASE_PATH=/data/vault.db \
  -e VAULT_ADMIN_TOKEN="$(openssl rand -hex 32)" ghcr.io/johnzilla/arbstr-vault:latest
```

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
| `OPERATOR_WEBHOOK_SECRET` | No | — | HMAC-SHA256 secret (min 16 chars) for webhook signing; without it webhooks are unsigned and vault logs a warning at startup |
| `VAULT_INTERNAL_TOKEN` | No | — | Shared secret (min 32 chars) for internal billing API |
| `BILLING_RESERVATION_TTL_MS` | No | `900000` | Age at which an unsettled billing reservation is released (min 60000) |

## Wallet Backends

- **`simulated`** — No real funds. Identical API surface. Use for development and testing.
- **`lightning`** — Pay BOLT11 invoices via LND. Requires LND connection vars.
- **`cashu`** — Mint/melt Cashu tokens via self-hosted Nutshell. Requires `CASHU_MINT_URL`.
- **`auto`** — Dual-rail. Payments below `CASHU_THRESHOLD_MSAT` go over Cashu, the rest over Lightning; a request's `preferred_rail` overrides this, and a failed rail falls back to the other. Requires both Lightning and Cashu vars.

## API

All routes use JSON. Agent routes require a bearer token from registration. Operator routes require the admin token.

### Operator Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents` | Register a new agent |
| `GET` | `/agents` | List all agents |
| `GET` | `/agents/:id` | Get agent details and policy |
| `PATCH` | `/operator/agents/:id/policy` | Update agent policy (creates new version) |
| `PUT` | `/agents/:id/policy` | Replace agent policy (legacy; resets optional fields) |
| `POST` | `/agents/:id/deposit` | Deposit funds to agent |
| `POST` | `/operator/approvals/:id/approve` | Approve a pending payment or withdrawal |
| `POST` | `/operator/approvals/:id/deny` | Deny a pending payment or withdrawal |
| `GET` | `/operator/approvals` | List approvals (`?status=pending` or `all`) |
| `GET` | `/operator/dashboard` | Full agent dashboard |
| `GET` | `/operator/audit` | Query the audit log across all agents |

`GET /operator/audit` returns entries newest first, 50 per page (`limit` up to 200), with `next_cursor` for the next page. Filters, all optional and combinable: `agent_id` (use `system` for entries not tied to an agent), `action` (one action or a comma-separated list, e.g. `WEBHOOK_DELIVERY_FAILED,APPROVAL_TIMEOUT`), `ref_id` (a transaction or reservation id), and `start_date` / `end_date` (ms since epoch, inclusive). An unknown action or a reversed range returns 400.

Approving a payment or withdrawal executes it through the configured wallet, with the rail chosen as for `/pay` (`CASHU_THRESHOLD_MSAT` when both rails exist; no fallback to the other rail). Real rails pay the stored destination as a BOLT11 invoice. The approve response's `payment_status` is `SETTLED`, `FAILED` (hold released), or `PENDING` (a Lightning payment that may still be in flight; startup recovery resolves it).

New agents start with a deny-all policy. The policy body takes `max_transaction_msat` and `daily_limit_msat`, plus optional `max_fee_msat`, `approval_timeout_ms` (30s–1h, default 5 min), `alert_floor_msat` and `alert_cooldown_ms` (min 60s) for balance alerts.

### Agent Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents/:id/pay` | Submit a payment request |
| `GET` | `/agents/:id/balance` | Get agent balance |
| `GET` | `/agents/:id/history` | Get payment history |
| `GET` | `/agents/:id/payments/:tx_id` | Get payment status |
| `POST` | `/agents/:id/withdrawals` | Propose a withdrawal |

Agent tokens start with `vtk_` and only work for their own `:id` (another agent's id returns 403).

Lightning destinations — `/pay` with `destination_type: "lightning_invoice"`, and every withdrawal — must be a BOLT11 invoice for exactly `amount_msat`. The ledger debits `amount_msat` while Lightning pays the invoice's own amount, so anything else is refused with `400` before policy is checked (nothing is reserved, audited or queued):

| `error.code` | Cause |
|--------------|-------|
| `invalid_invoice` | Not a parseable BOLT11 invoice |
| `invoice_amount_required` | Invoice has no amount |
| `invoice_expired` | Invoice has expired |
| `invoice_amount_mismatch` | Invoice amount differs from `amount_msat` (the response includes `invoice_amount_msat`) |

Both real rails pay BOLT11 invoices (Cashu by melting to one), so with `WALLET_BACKEND` set to `lightning`, `cashu` or `auto`, `/pay` accepts only `destination_type: "lightning_invoice"`. `cashu_token` and `internal` are refused the same way with `400 unsupported_destination_type`; they remain usable in simulated mode.

### Internal Billing Endpoints

Requires `VAULT_INTERNAL_TOKEN` to be configured. Authenticated via `X-Internal-Token` header.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/internal/reserve` | Reserve funds against an agent balance |
| `POST` | `/internal/settle` | Settle a reservation (deduct actual cost) |
| `POST` | `/internal/release` | Release an unused reservation |
| `POST` | `/internal/agents/verify` | Check an agent token without reserving (`{ agent_token }` → `{ agent_id }`, or 401 `invalid_agent_token`) |

Request bodies match arbstr core's `VaultClient` (contract tests in `tests/contract/core-billing.test.ts`):

- **reserve** — `{ agent_token, amount_msats, correlation_id, model }`. `amount_msats` may be `0` (free local-tier providers).
- **settle** — `{ reservation_id, actual_msats, metadata: { tokens_in, tokens_out, provider, latency_ms } }`. Token counts may be `null`. The legacy flat shape (fields at top level) is still accepted.
- **release** — `{ reservation_id, reason? }`.

Reserve applies the agent's policy, using the same engine as `/agents/:id/pay`:

- A missing or deny-all policy (the default for new agents) is denied, even at zero cost. Set limits with `PATCH /operator/agents/:id/policy` before billing through core.
- An amount above `max_transaction_msat` is denied. An over-limit amount that `/pay` would send for human approval is also denied here, because billing can't wait for an operator.
- Settled payments in the last 24h, plus open reservations, plus the new amount must stay within `daily_limit_msat`.
- Denials return `403 { error: { code: "policy_denied" }, reason }`. Every decision is audited as `PAYMENT_REQUEST`.

Settlement rules:

- A charge never exceeds the reservation — `actual_msats` above the reserved amount is capped and the overage recorded in the audit log.
- Repeating a settle is idempotent and returns the original outcome.
- Settle after release → `409 already_released`; release after settle → `409 already_settled`. Neither moves funds.
- Reservations core never settles or releases (for example, core crashed mid-request) are released once they're older than `BILLING_RESERVATION_TTL_MS` (default 15 minutes). The sweep runs every minute, and its first run is one minute after startup, which gives core time to replay settles it queued while vault was down. Each release is audited as `RESERVATION_EXPIRED`. A settle that arrives later gets `409 already_released`, and the agent isn't charged. Only billing reservations are swept; holds from `/pay` approvals, withdrawals and Lightning payments are left alone.

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health check |

### Webhooks

When `OPERATOR_WEBHOOK_URL` is set, arbstr-vault POSTs JSON events to that URL.

- **Events:** `approval_required`, `approval_granted`, `approval_denied`, `approval_timeout`, `withdrawal_requested`, `balance_alert`.
- **Header:** `X-ArbstrVault-Signature` — hex HMAC-SHA256 of the raw request body using `OPERATOR_WEBHOOK_SECRET`. If no secret is configured, the value is the literal string `unsigned`.
- **Payload:** JSON with `event`, optional `agent_id`/`transaction_id`/`amount_msat`, plus a `timestamp` (ms since epoch). `approval_granted` adds `payment_status`; `balance_alert` adds `balance_msat` and `alert_floor_msat`.
- **Delivery:** fire-and-forget with 3 retries (1s, 5s, 15s backoff) and a 10s per-attempt timeout. A delivery that fails every attempt is written to the audit log as `WEBHOOK_DELIVERY_FAILED`, with the event type, attempt count and last error (`HTTP 500`, `timeout`, ...); `ref_id` is the event's transaction id, and events without an agent are logged under `system`.

> **Breaking change (2026-04-18):** the signature header was renamed from `X-Vaultwarden-Signature` to `X-ArbstrVault-Signature`. Update any consumer that asserts on the header name.

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

### Releases

Versions are semver; `package.json`'s `version` is the source of truth. CI publishes `ghcr.io/johnzilla/arbstr-vault:latest` and `:<short-sha>` (amd64 + arm64) on every merge to main. To release:

1. In a PR, bump `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version` updates the lockfile too).
2. After it merges, push a signed tag from main (`git config --global tag.gpgSign true`):
   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "arbstr-vault vX.Y.Z"
   git push origin vX.Y.Z
   ```
3. CI checks the tag against `package.json`, publishes `:X.Y.Z` and `:X.Y`, attaches signed build provenance, and creates the GitHub Release. Verify an image with `gh attestation verify oci://ghcr.io/johnzilla/arbstr-vault:X.Y.Z --owner johnzilla`.

[arbstr-node](https://github.com/johnzilla/arbstr-node) runs a released image. The `v1.0` and `v1.1` tags predate this and have no images or releases.

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
| Runtime | Node.js 22 (ESM) |
| Framework | Fastify 5 |
| Language | TypeScript 5.9 |
| Database | SQLite via better-sqlite3 |
| ORM | Drizzle ORM |
| Validation | Zod v4 |
| Logging | Pino |
| Lightning | lightning (npm) → LND gRPC |
| Cashu | cashu-ts v3.5 → Nutshell mint |
| Testing | Vitest |

## Related Projects

- [arbstr](https://github.com/johnzilla/arbstr) -- Routing engine: OpenAI-compatible proxy that picks the cheapest qualified provider
- [arbstr-vault](https://github.com/johnzilla/arbstr-vault) -- Treasury: agent accounts, spending policy, per-request billing, Lightning and Cashu rails
- [arbstr-node](https://github.com/johnzilla/arbstr-node) -- The full stack (core + vault + LND + Cashu mint) as one `docker compose up`, pinned to released versions
- [mesh-llm](https://docs.anarchai.org) -- Distributed P2P inference network (local provider)
- [Routstr](https://routstr.com) -- Decentralized LLM marketplace

## License

MIT
