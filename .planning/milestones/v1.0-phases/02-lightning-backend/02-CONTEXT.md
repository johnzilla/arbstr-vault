# Phase 2: Lightning Backend - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the simulated wallet with a real Lightning backend that pays BOLT11 invoices via LND. Correct payment state machine that tracks payment_hash before send and resolves via TrackPaymentV2 — no false refunds, no double-debits. Scoped macaroon enforcement (never admin.macaroon). Outbound payments only — inbound Lightning (creating invoices, receiving payments) and channel management are out of scope.

</domain>

<decisions>
## Implementation Decisions

### LND connection & credentials
- LND runs in a separate Docker container; Treasury connects over gRPC on the internal network
- Scoped macaroon baked at LND startup via entrypoint script: `invoices:read invoices:write offchain:read offchain:write` — written to a shared volume
- Treasury verifies macaroon scope at startup — rejects and refuses to start if overprivileged (admin.macaroon detected)
- LND unavailability at startup: retry 5 times with exponential backoff, then exit with error. Fail-closed — no payment endpoints if LND is unreachable
- Startup sequence: connect LND -> verify macaroon scope -> getInfo() health check -> register Lightning WalletBackend

### Payment failure handling
- PENDING payments tracked indefinitely via TrackPaymentV2 subscription — never auto-fail. LND's own HTLC timeout (~1 hour) is the real deadline
- Balance reserved (debited) immediately when payment enters PENDING. If payment fails, credit released back to agent
- Ledger entries: RESERVE (-amount) at PENDING, then either SETTLED (audit only, already debited) or RELEASE (+amount) on failure
- Agent can poll payment status via `GET /agents/:id/payments/:tx_id` — returns status (PENDING/SETTLED/FAILED), timestamps, payment_hash, fee_msat
- Agent pays routing fees — fee is an additional debit on top of payment amount, visible in response and audit log
- Per-agent `max_fee_msat` in policy — passed as `fee_limit_msat` to SendPaymentV2. LND rejects payment if routing exceeds it

### Dev/test environment
- Regtest with Polar for local development: bitcoind (regtest) + lnd-alice (treasury) + lnd-bob (test payee) in docker-compose.dev.yml
- Lightning integration tests skippable if no LND available (`describe.skip` when `LND_HOST` not set). Phase 1 test suite always runs
- Outbound payments only in Phase 2 — no invoice creation, no inbound payment handling

### Transition from simulated
- Config-driven backend selection: `WALLET_BACKEND=simulated|lightning` env var. Treasury registers the appropriate WalletBackend at startup
- All simulated transaction history preserved when switching to Lightning — mode field distinguishes them. Balances carry over
- Crash recovery: on startup, query ledger for PENDING payments and re-subscribe to TrackPaymentV2 for each stored payment_hash. Handles Treasury crash, restart during in-flight HTLCs, and network partition recovery

### Claude's Discretion
- Exact `lightning` npm package API usage and connection setup
- Docker Compose service configuration details
- TrackPaymentV2 subscription management (goroutine/stream handling)
- Regtest channel funding and test setup scripts
- Error code mapping from LND gRPC errors to Treasury API errors
- Fee ledger entry strategy (separate FEE entry vs adjusted SETTLED amount)

</decisions>

<specifics>
## Specific Ideas

- STACK.md specifies the `lightning` npm package (TypeScript-first LND gRPC client) — use that, not ln-service
- The WalletBackend interface from Phase 1 (`wallet.interface.ts`) already defines `pay_bolt11`, `get_balance`, `create_invoice` — Lightning backend implements this trait
- Payment responses already include `mode` field from Phase 1 — Lightning payments return `mode: "lightning"` instead of `mode: "simulated"`
- The two-phase IMMEDIATE transaction pattern from Phase 1 (01-04) adapts well: Phase 1 reserves balance, wallet call happens between transactions, Phase 2 finalizes

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-lightning-backend*
*Context gathered: 2026-02-26*
