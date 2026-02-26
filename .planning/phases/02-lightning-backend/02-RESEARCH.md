# Phase 2: Lightning Backend - Research

**Researched:** 2026-02-26
**Domain:** LND gRPC integration, Lightning payment state machine, macaroon scope enforcement
**Confidence:** MEDIUM-HIGH (lightning npm API HIGH via official docs; payment state machine MEDIUM via LND docs + community; Docker/Polar dev setup MEDIUM)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**LND connection & credentials**
- LND runs in a separate Docker container; Treasury connects over gRPC on the internal network
- Scoped macaroon baked at LND startup via entrypoint script: `invoices:read invoices:write offchain:read offchain:write` — written to a shared volume
- Treasury verifies macaroon scope at startup — rejects and refuses to start if overprivileged (admin.macaroon detected)
- LND unavailability at startup: retry 5 times with exponential backoff, then exit with error. Fail-closed — no payment endpoints if LND is unreachable
- Startup sequence: connect LND -> verify macaroon scope -> getInfo() health check -> register Lightning WalletBackend

**Payment failure handling**
- PENDING payments tracked indefinitely via TrackPaymentV2 subscription — never auto-fail. LND's own HTLC timeout (~1 hour) is the real deadline
- Balance reserved (debited) immediately when payment enters PENDING. If payment fails, credit released back to agent
- Ledger entries: RESERVE (-amount) at PENDING, then either SETTLED (audit only, already debited) or RELEASE (+amount) on failure
- Agent can poll payment status via `GET /agents/:id/payments/:tx_id` — returns status (PENDING/SETTLED/FAILED), timestamps, payment_hash, fee_msat
- Agent pays routing fees — fee is an additional debit on top of payment amount, visible in response and audit log
- Per-agent `max_fee_msat` in policy — passed as `fee_limit_msat` to SendPaymentV2. LND rejects payment if routing exceeds it

**Dev/test environment**
- Regtest with Polar for local development: bitcoind (regtest) + lnd-alice (treasury) + lnd-bob (test payee) in docker-compose.dev.yml
- Lightning integration tests skippable if no LND available (`describe.skip` when `LND_HOST` not set). Phase 1 test suite always runs
- Outbound payments only in Phase 2 — no invoice creation, no inbound payment handling

**Transition from simulated**
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

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PAY-03 | Treasury can pay BOLT11 Lightning invoices via LND on behalf of an agent | `lightning` npm `payViaPaymentRequest` + `subscribeToPayViaRequest` APIs; LND gRPC connection setup with `authenticatedLndGrpc` |
| PAY-06 | Payment responses include transaction reference (invoice paid, payment_hash, token ID) | `payViaPaymentRequest` returns `id` (payment hash hex) + `fee_mtokens`; confirmed event from `subscribeToPayViaRequest` includes `id` field |
| SEC-04 | Lightning payment state machine tracks payment_hash before send and resolves via TrackPaymentV2 (prevents false refunds) | `subscribeToPastPayment` is the correct method for crash recovery tracking; three-phase state machine: RESERVE → LND send → PENDING/SETTLED/FAILED |
| SEC-05 | LND macaroon is scoped to invoice+offchain operations only (never admin.macaroon) | `lncli bakemacaroon info:read invoices:read invoices:write offchain:read offchain:write`; startup verification via attempting forbidden operation or checking permission claims |
</phase_requirements>

---

## Summary

Phase 2 replaces the `SimulatedWallet` with a real `LightningWallet` that implements the existing `WalletBackend` interface. The critical complexity is the payment state machine: unlike simulated payments that settle instantly, Lightning payments have three terminal states (SETTLED, FAILED, PENDING/stuck) and the Treasury must never produce a false refund when LND returns an ambiguous status.

The `lightning` npm package (v11.0.2, by Alex Bosworth) is the TypeScript-native LND gRPC client. It provides `payViaPaymentRequest` for fire-and-forget payments and `subscribeToPayViaRequest` for payment-initiation with real-time status streaming. For crash recovery — re-attaching to in-flight payments after a Treasury restart — the library exposes `subscribeToPastPayment`, which tracks a payment already sent by payment hash. These three functions cover the entire outbound payment lifecycle.

The payment state machine must write the payment_hash to the ledger BEFORE calling LND, so a crash between send and the first status update does not lose the reference. On startup, the Treasury queries for all PENDING ledger entries and re-subscribes to each via `subscribeToPastPayment`. The `RESERVE` ledger entry debits the agent balance immediately at PENDING; a `RELEASE` entry (positive, type REFUND) credits it back only on confirmed LND failure. The schema requires two new additions: `payment_hash` column on `ledger_entries` (for crash recovery lookups), and `max_fee_msat` on `policies` (for per-agent fee limits).

**Primary recommendation:** Implement `LightningWallet` as a class (not a plain object like `SimulatedWallet`) so it can hold the `lnd` connection object and the in-memory subscription map (`Map<payment_hash, Set<resolve/reject>>`). The `WalletBackend.pay()` contract returns a Promise that resolves when the payment reaches a terminal state — the class manages the async subscription bridge internally.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `lightning` (npm) | 11.0.2 | LND gRPC client — TypeScript-first | Explicit recommendation from ln-service README for TypeScript projects. 200+ typed LND methods. Handles cert/macaroon TLS auth. Supports Node.js 20+ (v11.0.0 dropped Node 18). |
| LND | 0.20.x | Lightning node daemon | Already chosen. `lightning` 11.0.2 explicitly adds support for LND 0.20.1. |
| `lightninglabs/lnd` Docker | latest-0.20.x tag | LND container for dev/prod | Official Docker image at hub.docker.com/r/lightninglabs/lnd. Polar uses the same images for regtest. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Polar | latest | Regtest Lightning test environment | Local dev — spin up bitcoind + lnd-alice + lnd-bob with one click. GUI channel funding. |
| `docker.io/polarlightning/bitcoind` | latest | Bitcoin regtest node | Used by Polar's docker-compose for the regtest bitcoin backend |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `lightning` npm | `@radar/lnrpc` | @radar/lnrpc has TypeScript types but is a raw gRPC wrapper without the helper abstractions. `lightning` npm is higher-level and used by Alex Bosworth's own tools. |
| `payViaPaymentRequest` + `subscribeToPastPayment` | LND REST API via `node-fetch` | REST works but requires polling instead of streaming. gRPC streaming is the correct pattern for payment state tracking. |

**Installation:**
```bash
npm install lightning
```

No additional packages needed — `lightning` is self-contained with gRPC and TLS support built in.

---

## Architecture Patterns

### Recommended Project Structure

The Phase 1 structure is preserved. Phase 2 adds:

```
src/
├── modules/
│   └── payments/
│       └── wallet/
│           ├── wallet.interface.ts       # Existing — unchanged
│           ├── simulated.wallet.ts       # Existing — unchanged
│           └── lightning.wallet.ts       # NEW — LightningWallet class
├── lib/
│   └── lnd/
│       ├── lnd.client.ts                 # NEW — LND connection setup + macaroon verification
│       └── lnd.startup.ts                # NEW — startup health check + crash recovery
├── db/
│   └── schema.ts                         # MODIFIED — add payment_hash column, max_fee_msat column
└── config.ts                             # MODIFIED — add LND_HOST, LND_PORT, LND_CERT, LND_MACAROON, WALLET_BACKEND env vars
```

### Pattern 1: LND Connection Setup with `authenticatedLndGrpc`

**What:** Create the `lnd` connection object once at startup, store it on a module-level or class-level variable, and pass it to all `lightning` method calls.

**When to use:** Once during Treasury startup, before route registration.

**Example:**
```typescript
// Source: https://github.com/alexbosworth/lightning README
import { authenticatedLndGrpc, getWalletInfo } from 'lightning';

export function createLndConnection(opts: {
  cert: string;   // base64-encoded tls.cert
  macaroon: string; // base64-encoded scoped macaroon
  socket: string;   // e.g. "lnd-alice:10009"
}) {
  const { lnd } = authenticatedLndGrpc(opts);
  return lnd;
}

// Health check
export async function checkLndHealth(lnd: AuthenticatedLnd): Promise<void> {
  const info = await getWalletInfo({ lnd });
  // info.is_synced_to_chain, info.active_channels_count, info.public_key
}
```

### Pattern 2: Three-Phase Payment State Machine

**What:** The payment lifecycle has three phases that map to distinct database operations.

**When to use:** Every outbound Lightning payment — no exceptions.

**State transitions:**

```
[POLICY CHECK passes]
        ↓
Phase A: Write RESERVE ledger entry (-amount_msat) + PAYMENT_REQUEST audit
         Store payment_hash in ledger entry BEFORE calling LND
        ↓
Phase B: Call subscribeToPayViaRequest (or payViaPaymentRequest)
         Transition ledger status to PENDING
        ↓
        ├─ LND 'confirmed' event
        │     Phase C-success: Write PAYMENT_SETTLED audit
        │     (balance already debited in Phase A — no additional ledger entry needed)
        │
        └─ LND 'failed' event
              Phase C-failure: Write RELEASE ledger entry (+amount_msat, type REFUND)
                               Write PAYMENT_FAILED audit with failure reason
```

**Key invariant:** The RESERVE entry (debit) is written BEFORE the LND call. If Treasury crashes between Phase A and Phase B, the balance is debited but no payment_hash is stored yet → on restart, the PENDING entry has no payment_hash → treat as FAILED, write RELEASE. If the crash is between Phase B and the first 'confirmed' event → payment_hash is stored → re-subscribe via `subscribeToPastPayment` on restart.

**Implementation:**
```typescript
// Source: lightning npm README + LND docs
import { subscribeToPayViaRequest, subscribeToPastPayment } from 'lightning';

// Initiate payment and get back payment hash
export async function sendLightningPayment(
  lnd: AuthenticatedLnd,
  bolt11: string,
  feeLimitMsat: number,
): Promise<{ payment_hash: string; fee_msat: number }> {
  return new Promise((resolve, reject) => {
    const sub = subscribeToPayViaRequest({
      lnd,
      request: bolt11,
      max_fee_mtokens: String(feeLimitMsat),
    });

    sub.on('paying', (payment) => {
      // Payment in flight — payment_hash available here for crash recovery
      // Save payment_hash to ledger immediately via a side-effect call
    });

    sub.on('confirmed', (payment) => {
      resolve({
        payment_hash: payment.id,
        fee_msat: Number(payment.fee_mtokens),
      });
    });

    sub.on('failed', (failure) => {
      reject(new LightningPaymentError(failure));
    });

    sub.on('error', (err) => {
      // gRPC stream error — treat as PENDING/unknown, NOT as FAILED
      reject(new LightningNetworkError(err));
    });
  });
}

// Crash recovery — re-attach to existing in-flight payment
export async function trackExistingPayment(
  lnd: AuthenticatedLnd,
  paymentHash: string,
): Promise<{ status: 'SETTLED' | 'FAILED'; fee_msat?: number }> {
  return new Promise((resolve, reject) => {
    const sub = subscribeToPastPayment({ lnd, id: paymentHash });

    sub.on('confirmed', (payment) => {
      resolve({ status: 'SETTLED', fee_msat: Number(payment.fee_mtokens) });
    });

    sub.on('failed', () => {
      resolve({ status: 'FAILED' });
    });

    sub.on('error', (err) => {
      reject(err); // Will retry on next startup
    });
  });
}
```

### Pattern 3: Macaroon Scope Verification at Startup

**What:** Verify the loaded macaroon is NOT admin.macaroon and has only payment-scoped permissions. Two approaches available.

**Approach A (preferred): Attempt a forbidden operation.**
The scoped macaroon (`invoices:read invoices:write offchain:read offchain:write`) does NOT have `onchain:read`. Call `getChainBalance({ lnd })` at startup — it requires `onchain:read`. If the call succeeds, the macaroon is overprivileged → refuse to start.

```typescript
import { getChainBalance } from 'lightning';

async function verifyMacaroonIsNotAdmin(lnd: AuthenticatedLnd): Promise<void> {
  try {
    await getChainBalance({ lnd });
    // If this succeeds, the macaroon has onchain:read → too broad → abort
    throw new Error('FATAL: Macaroon has onchain:read permission — admin.macaroon detected. Refusing to start.');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('FATAL:')) {
      throw err; // Re-throw our own error
    }
    // Expected: permission denied → macaroon is correctly scoped
    // Proceed with startup
  }
}
```

**Approach B (fallback): Use `verifyAccess` from the lightning package.**
`verifyAccess` requires `macaroon:read` permission, which the scoped macaroon does NOT have. So Approach A is better.

**When to use:** During startup, before registering payment routes. Process exits non-zero if overprivileged.

### Pattern 4: Startup Crash Recovery

**What:** On Treasury startup with `WALLET_BACKEND=lightning`, query all PENDING payments from the ledger and re-subscribe to each via `subscribeToPastPayment`.

**When to use:** At server startup, after LND health check passes.

```typescript
async function recoverPendingPayments(
  db: DB,
  lnd: AuthenticatedLnd,
): Promise<void> {
  const pendingPayments = await ledgerRepo.getPendingLightningPayments(db);

  for (const payment of pendingPayments) {
    if (!payment.payment_hash) {
      // Crashed before LND call — write RELEASE (the RESERVE was already debited)
      await writeLedgerRelease(db, payment);
      continue;
    }
    // Re-attach subscription — will resolve SETTLED or FAILED
    trackExistingPayment(lnd, payment.payment_hash)
      .then(result => finalizeLedger(db, payment, result))
      .catch(err => logger.error({ err, payment_hash: payment.payment_hash }, 'crash recovery resubscribe failed'));
  }
}
```

### Pattern 5: Policy Schema Extension (max_fee_msat)

**What:** Add `max_fee_msat` to the `policies` table. Pass this as `fee_limit_msat` to `subscribeToPayViaRequest`/`payViaPaymentRequest`.

**When to use:** All Lightning payments. Default: 1000 msat (1 sat) if not configured.

### Anti-Patterns to Avoid

- **Treating LND stream errors as payment failures:** A `sub.on('error')` event from a gRPC stream means network/connection issue, NOT that the payment failed. Never write a RELEASE ledger entry on stream error — keep PENDING and re-subscribe.
- **Storing payment_hash only after successful send:** If Treasury crashes between the LND call and storing the hash, the payment is in-flight with no reference. Always store payment_hash in the 'paying' event handler (or before the LND call if using payViaPaymentRequest's return value).
- **Calling `payViaPaymentRequest` instead of `subscribeToPayViaRequest` for the primary path:** `payViaPaymentRequest` is a one-shot async call that blocks until terminal state. It gives no 'paying' event, so you cannot capture the payment_hash mid-flight. Use `subscribeToPayViaRequest` for the primary payment path so the 'paying' event gives you the payment_hash before the network resolves.
- **Registering payment routes before LND health check completes:** If LND is unavailable and startup doesn't fail-close, agents can submit payments that silently queue with no executor. Fail-close: no payment routes until LND health check passes.
- **Auto-refunding on timeout:** A payment that times out from the gRPC perspective may still be in-flight on the Lightning network. HTLC timeouts (~1 hour) are LND's real deadline, not the gRPC stream timeout.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LND gRPC connection + TLS + macaroon auth | Custom gRPC protobuf wrapper | `authenticatedLndGrpc` from `lightning` npm | Handles cert loading, macaroon encoding, TLS handshake, and reconnection correctly. |
| Payment streaming + event lifecycle | Custom EventEmitter + gRPC stream | `subscribeToPayViaRequest` | Handles stream lifecycle, event mapping from LND protobuf to JS events, and error wrapping. |
| Crash recovery payment tracking | Custom polling loop with `getPayments` | `subscribeToPastPayment` | Streams real-time status updates for a specific payment hash; handles already-terminal payments correctly. |
| BOLT11 invoice parsing (fee check, expiry check) | Custom base58/bech32 decoder | Let LND reject via `fee_limit_msat` | LND validates the invoice before sending; add Zod validation only for format (must be string, non-empty). |
| Regtest test environment | Custom Bitcoin/LND docker orchestration | Polar (lightningpolar.com) | Polar wraps bitcoind + LND + channel funding into a one-click GUI and matching docker-compose. |

**Key insight:** The `lightning` npm package's higher-level event model is significantly safer than raw gRPC stream management. Raw streams require manual proto loading, backpressure handling, and reconnect logic. The `lightning` package absorbs all of that complexity.

---

## Common Pitfalls

### Pitfall 1: gRPC Stream Error ≠ Payment Failure

**What goes wrong:** When the gRPC stream emits an `error` event (LND restart, network blip, Docker container restart), code treats it as a payment failure and writes a RELEASE entry. The payment may actually still be in-flight.

**Why it happens:** Stream errors look like payment errors. The `'error'` event is not in `{ is_canceled, is_route_not_found, ... }` — it's a raw connection error.

**How to avoid:** Only write RELEASE on `'failed'` events (which have `is_*` boolean flags). On `'error'`, log and keep the ledger in PENDING state. Re-subscribe on next startup via `subscribeToPastPayment`.

**Warning signs:** Tests show negative balance without a corresponding PAYMENT_FAILED audit entry.

### Pitfall 2: Payment Hash Not Stored Before Terminal Status

**What goes wrong:** `subscribeToPayViaRequest` emits `'confirmed'` synchronously after `'paying'` in fast regtest conditions. If the 'paying' handler does an async DB write, the 'confirmed' handler may run before the payment_hash is persisted.

**Why it happens:** EventEmitter callbacks are synchronous but DB writes may yield. In regtest the payment resolves in milliseconds.

**How to avoid:** Store payment_hash synchronously in-memory first (before any async operation). The async DB write can happen after. The payment_hash in memory is sufficient to write the RELEASE if the process crashes after the 'paying' event.

**Warning signs:** Ledger PENDING entries with null payment_hash in fast integration tests.

### Pitfall 3: Missing `info:read` in Macaroon Scope

**What goes wrong:** `getWalletInfo` requires `info:read`. The spec says `invoices:read invoices:write offchain:read offchain:write`. Without `info:read`, the health check call fails.

**Why it happens:** `getWalletInfo` is used for the startup health check but `info:read` is not in the payment-only scope.

**How to avoid:** Bake the macaroon with: `lncli bakemacaroon info:read invoices:read invoices:write offchain:read offchain:write`. The CONTEXT.md decision already includes `info:read` implicitly as part of the health check sequence. Make this explicit in the macaroon bake command.

**Warning signs:** Treasury startup fails with "permission denied" on `getWalletInfo` health check.

### Pitfall 4: ESM Import Compatibility with `lightning` npm

**What goes wrong:** The `lightning` package uses CommonJS exports. The vaultwarden project uses `"type": "module"` (ESM). Importing `lightning` with named imports may fail.

**Why it happens:** The `lightning` package is CJS. Node.js ESM can import CJS default exports but named CJS exports require `createRequire` or the module must use named exports explicitly.

**How to avoid:** Use `createRequire` for the import, OR check if `lightning` 11.x supports `exports` map with ESM entry points. Test with `import { authenticatedLndGrpc } from 'lightning'` first — if it fails, use: `import { createRequire } from 'module'; const require = createRequire(import.meta.url); const { authenticatedLndGrpc } = require('lightning');`

**Warning signs:** `SyntaxError: The requested module 'lightning' does not provide an export named 'authenticatedLndGrpc'` at startup.

### Pitfall 5: Polar vs Pure Docker-Compose for CI

**What goes wrong:** Polar is a desktop GUI app — it cannot be used in CI (GitHub Actions). Tests that require a live LND node will always fail in CI unless a separate docker-compose without Polar is available.

**Why it happens:** Polar manages docker-compose internally; the compose files are in `~/.polar/networks/`.

**How to avoid:** For developer local testing, use Polar. For CI (if ever needed), write a `docker-compose.test.yml` that directly uses `lightninglabs/lnd` + `polarlightning/bitcoind`. The locked decision says `describe.skip` when `LND_HOST` not set — this is the correct CI escape hatch.

**Warning signs:** CI jobs hanging waiting for LND, or `LND_HOST` env var not set and tests running anyway.

### Pitfall 6: Schema Migration Required — SQLite Drizzle Migration

**What goes wrong:** The existing `ledger_entries` table has no `payment_hash` column and `policies` has no `max_fee_msat` column. Phase 2 needs both. Without a migration, the code will crash at runtime.

**Why it happens:** Drizzle SQLite uses file-based migrations generated by `drizzle-kit generate`. The schema change must produce a new migration file AND be run before any Lightning payment is attempted.

**How to avoid:** Add `payment_hash text` to `ledger_entries` schema (nullable — simulated payments have no hash), and `max_fee_msat integer` to `policies` (nullable — use a default of 1000 msat when null). Run `npm run db:generate` to produce the migration file.

**Warning signs:** `no such column: payment_hash` errors at runtime.

---

## Code Examples

Verified patterns from official sources:

### Connection Setup

```typescript
// Source: https://github.com/alexbosworth/lightning README
import { authenticatedLndGrpc } from 'lightning';

const { lnd } = authenticatedLndGrpc({
  cert: process.env.LND_CERT_BASE64,   // base64 of tls.cert
  macaroon: process.env.LND_MACAROON_BASE64, // base64 of scoped macaroon
  socket: `${process.env.LND_HOST}:${process.env.LND_PORT ?? '10009'}`,
});
```

### Payment with Status Streaming

```typescript
// Source: https://github.com/alexbosworth/lightning/blob/master/lnd_methods/offchain/subscribe_to_pay_via_request.js
import { subscribeToPayViaRequest } from 'lightning';

const sub = subscribeToPayViaRequest({
  lnd,
  request: bolt11Invoice,          // BOLT11 string
  max_fee_mtokens: String(maxFeeMsat), // fee limit as string
});

// 'paying' fires once when HTLC is locked in (payment_hash available)
sub.on('paying', ({ id: paymentHash }) => {
  // id is payment hash hex string — store this to ledger NOW
});

// 'confirmed' fires on success
sub.on('confirmed', ({ id: paymentHash, fee_mtokens }) => {
  // fee_mtokens: total fee millitokens paid (string)
});

// 'failed' fires on definitive failure
sub.on('failed', ({ is_route_not_found, is_pathfinding_timeout, is_insufficient_balance }) => {
  // Write RELEASE ledger entry here
});

// 'error' fires on stream/connection error — NOT payment failure
sub.on('error', (err) => {
  // Keep PENDING, re-subscribe on restart
});
```

### Crash Recovery — Track Existing Payment

```typescript
// Source: https://github.com/alexbosworth/lightning/blob/master/lnd_methods/offchain/subscribe_to_past_payment.js
import { subscribeToPastPayment } from 'lightning';

const sub = subscribeToPastPayment({
  lnd,
  id: paymentHash, // hex string from ledger
});

sub.on('confirmed', ({ fee_mtokens }) => {
  // Payment settled while Treasury was down — write PAYMENT_SETTLED audit
});

sub.on('failed', () => {
  // Payment failed while Treasury was down — write RELEASE + PAYMENT_FAILED audit
});

sub.on('paying', () => {
  // Still in-flight — stay PENDING
});
```

### Health Check + Macaroon Scope Verification

```typescript
// Source: https://github.com/alexbosworth/lightning README (getWalletInfo)
import { getWalletInfo, getChainBalance } from 'lightning';

async function startupChecks(lnd: AuthenticatedLnd): Promise<void> {
  // 1. Verify macaroon is NOT admin (admin has onchain:read, scoped macaroon does not)
  try {
    await getChainBalance({ lnd });
    // If this succeeds → macaroon has onchain:read → admin or overprivileged
    throw new Error('FATAL: Macaroon has onchain:read (overprivileged). Refusing to start. Use payment-scoped macaroon.');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('FATAL:')) throw err;
    // Expected: permission denied on scoped macaroon — good
  }

  // 2. Health check — requires info:read
  const info = await getWalletInfo({ lnd });
  if (!info.is_synced_to_chain) {
    throw new Error('LND node is not synced to chain — refusing to start');
  }
}
```

### LND Macaroon Bake Command (Docker Entrypoint)

```bash
# Source: LND macaroons README (https://github.com/lightningnetwork/lnd/blob/master/macaroons/README.md)
# Bake payment-only macaroon (excludes onchain:read/write — cannot drain channel funds)
lncli --network=regtest bakemacaroon \
  info:read \
  invoices:read \
  invoices:write \
  offchain:read \
  offchain:write \
  --save_to=/shared/treasury.macaroon
```

### Schema Changes Required

```typescript
// src/db/schema.ts additions

// On ledger_entries: add payment_hash (nullable — simulated payments have no hash)
export const ledgerEntries = sqliteTable('ledger_entries', {
  // ... existing columns ...
  entry_type: text('entry_type', {
    enum: ['DEPOSIT', 'PAYMENT', 'REFUND', 'RESERVE', 'RELEASE']  // ADD RESERVE, RELEASE
  }).notNull(),
  payment_hash: text('payment_hash'),  // ADD: hex string, null for simulated
  mode: text('mode', { enum: ['simulated', 'lightning'] }).default('simulated'), // ADD
});

// On policies: add max_fee_msat (per-agent Lightning fee cap)
export const policies = sqliteTable('policies', {
  // ... existing columns ...
  max_fee_msat: integer('max_fee_msat').default(1000), // ADD: default 1 sat
});
```

### New Payment Status Endpoint

```typescript
// GET /agents/:id/payments/:tx_id
// Returns current status of a payment (PENDING, SETTLED, FAILED)
// Source: locked decision in CONTEXT.md
{
  transaction_id: "tx_01...",
  payment_hash: "abc123...",  // hex, present for Lightning payments
  status: "PENDING" | "SETTLED" | "FAILED",
  mode: "lightning",
  amount_msat: 10000,
  fee_msat: 100,  // null until SETTLED
  created_at: "2026-02-26T...",
  settled_at: "2026-02-26T...",  // null until SETTLED
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `ln-service` npm (ln-service package) | `lightning` npm (TypeScript-native) | ~2021 | `ln-service` README explicitly redirects TypeScript users to `lightning`. Same author (Alex Bosworth). |
| `TrackPayment` (v1 gRPC) | `TrackPaymentV2` (router subservice) | LND 0.11+ | V2 exposes payment hash-level tracking and multi-path payment details. The `lightning` npm wraps v2. |
| Manual gRPC proto-loader | `authenticatedLndGrpc` | `lightning` npm creation | Removes need for manual proto compilation, TLS cert loading, and macaroon hex encoding. |
| `payViaPaymentRequest` (blocking) | `subscribeToPayViaRequest` (streaming) | `lightning` npm v8+ | Streaming version emits 'paying' event with payment_hash mid-flight — critical for crash recovery. |

**Deprecated/outdated:**
- `ln-service` npm: Same author but JavaScript-only predecessor. Do not use in this TypeScript project.
- Raw LND REST API: Works but requires polling instead of streaming. Polling creates false-refund risk during network partitions.

---

## Open Questions

1. **ESM/CJS compatibility of `lightning` 11.0.2 with `"type": "module"` project**
   - What we know: The `lightning` package is CJS. Vaultwarden uses `"type": "module"`. The project uses `tsx` for dev and native Node.js ESM for prod.
   - What's unclear: Whether named imports (`import { authenticatedLndGrpc } from 'lightning'`) work directly or require `createRequire`. This must be tested in Wave 0.
   - Recommendation: Add a minimal test import in a scratch script before writing the full wallet implementation. If named imports fail, use `createRequire` wrapper.

2. **`subscribeToPastPayment` behavior when payment is already terminal**
   - What we know: The method returns an EventEmitter. LND TrackPaymentV2 terminates the stream when payment is in a final state.
   - What's unclear: If the payment already SUCCEEDED before `subscribeToPastPayment` is called, does it immediately emit 'confirmed', or does it stay silent?
   - Recommendation: The official LND docs say "the stream will terminate if the payment state is final" — assume 'confirmed' or 'failed' will fire even for already-resolved payments. Verify in regtest during integration testing.

3. **SQLite integer precision for `fee_msat` values**
   - What we know: JavaScript's `Number` is a 64-bit float, safe to 2^53 integers. SQLite integers are 64-bit signed. LND fees in msat will be small.
   - What's unclear: Whether `fee_mtokens` (string) from the `lightning` package needs BigInt treatment.
   - Recommendation: Convert `fee_mtokens` string to `Number` via `Number(fee_mtokens)`. Values will be well under 2^53 for realistic fee amounts. Document this assumption.

4. **Polar docker-compose file location and reuse**
   - What we know: Polar generates docker-compose files in `~/.polar/networks/`. The locked decision says to create `docker-compose.dev.yml`.
   - What's unclear: Whether to run Polar as a GUI tool (developer workflow) and separately maintain a `docker-compose.dev.yml` for scripted setup.
   - Recommendation: Write a standalone `docker-compose.dev.yml` that can be run without the Polar GUI. Document that Polar is an optional convenience layer for channel management. The compose file should be in the repo root.

---

## Sources

### Primary (HIGH confidence)
- `lightning` npm package README — https://github.com/alexbosworth/lightning/blob/master/README.md — connection setup, method list, subscribeToPayViaRequest events
- `subscribe_to_pay_via_request.js` — https://github.com/alexbosworth/lightning/blob/master/lnd_methods/offchain/subscribe_to_pay_via_request.js — confirmed event schema (id, fee_mtokens, secret), failed event schema (is_* booleans)
- `pay_via_payment_request.js` — https://github.com/alexbosworth/lightning/blob/master/lnd_methods/offchain/pay_via_payment_request.js — return value (id, fee_mtokens)
- `subscribe_to_past_payment.js` — https://github.com/alexbosworth/lightning/blob/master/lnd_methods/offchain/subscribe_to_past_payment.js — parameters (id: payment hash hex), events (confirmed, failed, paying), requires offchain:read
- LND macaroons README — https://github.com/lightningnetwork/lnd/blob/master/macaroons/README.md — entity:action permission strings, bakemacaroon syntax
- LND TrackPaymentV2 API — https://api.lightning.community/api/lnd/router/track-payment-v2/index.html — payment states (IN_FLIGHT, SUCCEEDED, FAILED), stream termination on final state
- Lightning npm CHANGELOG — https://github.com/alexbosworth/lightning/blob/master/CHANGELOG.md — v11.0.0 requires Node 20+, v11.0.2 supports LND 0.20.1

### Secondary (MEDIUM confidence)
- LND Payments Guide — https://docs.lightning.engineering/lightning-network-tools/lnd/payments — TrackPaymentV2 reconnect semantics, stuck payment behavior, HTLC lifecycle
- LND Macaroons Guide — https://docs.lightning.engineering/lightning-network-tools/lnd/macaroons — permission format, printmacaroon verification, bakemacaroon
- LND gRPC API Reference — https://lightning.engineering/api-docs/api/lnd/lightning/bake-macaroon/ — MacaroonPermission entity/action structure
- Polar documentation — https://docs.lightning.engineering/lapps/guides/polar-lapps/local-cluster-setup-with-polar — LND versions supported (0.16.4–0.20.0), regtest setup
- lndhub.go example — WebSearch result showing `lncli bakemacaroon --save_to=lndhub.macaroon info:read invoices:read invoices:write offchain:read offchain:write` usage pattern

### Tertiary (LOW confidence — verify in implementation)
- ESM/CJS import compatibility: untested — verify `import { authenticatedLndGrpc } from 'lightning'` works with `"type": "module"` in package.json
- `subscribeToPastPayment` behavior for already-resolved payments: implied by LND docs ("stream terminates on final state") but not directly verified

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `lightning` 11.0.2 is the current version (verified via `npm info`); method APIs verified against source files
- Architecture: HIGH — Three-phase state machine pattern is directly derived from LND documentation requirements and the CONTEXT.md locked decisions
- Pitfalls: MEDIUM — ESM/CJS pitfall is architecture-based reasoning; `subscribeToPastPayment` behavior for resolved payments is inferred, not directly tested
- Macaroon verification: MEDIUM — `getChainBalance` approach is reasoning-based (verified that `onchain:read` is not in the scoped permission set); direct testing needed

**Research date:** 2026-02-26
**Valid until:** 2026-03-26 (30 days — `lightning` npm and LND are moderately stable; API unlikely to change)
