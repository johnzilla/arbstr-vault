# Phase 3: Cashu Backend - Research

**Researched:** 2026-02-27
**Domain:** Cashu ecash protocol, Nutshell mint REST API, payment routing, double-spend prevention
**Confidence:** HIGH (core APIs verified via official sources)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Payment Routing Logic
- Amount-threshold routing: payments under 1,000 sats (1,000,000 msat) route to Cashu, at or above route to Lightning
- Default threshold is 1,000 sats — configurable in global config
- Agent can pass an optional `preferred_rail` hint (`'lightning'` | `'cashu'`) to override automatic routing; Treasury respects the hint if the rail supports the destination
- If the chosen/routed rail fails, Treasury automatically falls back to the other rail; fallback is logged in audit with `initial_rail`, `final_rail`, `fallback_occurred` fields
- Routing decision is recorded in the audit log entry for every payment

#### Cashu Token Lifecycle
- Treasury connects to an external Nutshell mint via its REST API (not embedded) — operator deploys Nutshell alongside Treasury (e.g., Docker Compose)
- Mint liquidity comes from Lightning: Treasury mints Cashu tokens by paying Lightning invoices to the Nutshell mint
- Treasury is the custodian — it holds ecash proofs in its DB and tracks balances per agent in the ledger; agents never touch raw tokens
- Melt flow: Treasury melts tokens directly to pay the target amount; Nutshell handles change via its split/swap mechanics internally
- Keyset rotation: when the mint signals a keyset change, Treasury automatically swaps old proofs for new ones; swap logged in audit

#### Agent API Surface
- New asset type `BTC_cashu` alongside `BTC_simulated` and `BTC_lightning`
- Payment response includes: `rail_used` (`'cashu'` | `'lightning'`), `cashu_token_id` (proof reference, present for Cashu payments), `fee_msat`
- Deposits work the same as today — operator deposits to agent's ledger balance; Treasury internally mints Cashu tokens from the pool when Cashu payments are needed
- Payment status endpoint shows routing trace: `initial_rail`, `final_rail`, `fallback_occurred`

#### Concurrency & Double-Spend Prevention
- PENDING lock in DB keyed by proof secret before submitting proofs to mint; second concurrent request sees the lock and is rejected immediately; lock released on settle or fail
- Mirrors the Lightning RESERVE pattern from Phase 2
- Global lock scope (not per-agent) — proof secrets are unique regardless of agent
- Crash recovery: on startup, find all PENDING Cashu operations and query the Nutshell mint for their actual status; settle or release accordingly (mirrors Lightning crash recovery)

### Claude's Discretion
- Nutshell REST API client implementation details
- Proof storage schema design
- Exact fallback retry logic and timeouts
- Config schema for routing threshold

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PAY-04 | Treasury can mint, melt, and swap Cashu tokens via self-hosted Nutshell mint on behalf of an agent | Nutshell REST API documented; cashu-ts v3.5.0 Wallet class provides `createMintQuoteBolt11`, `mintProofsBolt11`, `createMeltQuoteBolt11`, `meltProofsBolt11`, `swap` — verified from official source |
| PAY-05 | Treasury auto-routes payments to Lightning or Cashu based on amount, fee, and destination type | Routing pattern uses threshold (1,000 sat) + `preferred_rail` hint; implemented in payments.service.ts as pre-wallet-call routing decision; routing fields `initial_rail`/`final_rail`/`fallback_occurred` must be added to audit log metadata |
</phase_requirements>

## Summary

Phase 3 adds Cashu ecash as a second payment rail via an external Nutshell mint. The primary library is `@cashu/cashu-ts` v3.5.0, which provides a stateless `Wallet` class with typed async methods for all Cashu NUT operations. The Nutshell mint (v0.19.2) exposes a clean REST API at standard `/v1/*` endpoints and runs easily in Docker alongside the existing LND stack.

The implementation has three main concerns: (1) a `CashuWallet` backend module analogous to `lightning.wallet.ts`, (2) a routing layer inside `payments.service.ts` that decides which rail to use and handles fallback, and (3) a PENDING proof lock table in the DB to prevent double-spend across concurrent requests, mirroring the Lightning RESERVE/RELEASE pattern from Phase 2.

The cashu-ts library is "mostly stateless" — it does not persist proofs internally. The Treasury must store all `Proof` objects (`{ id, amount, secret, C }`) in its SQLite database and pass them to the library on each operation. This is architecturally consistent with how Treasury already owns all Lightning state.

**Primary recommendation:** Install `@cashu/cashu-ts@^3.5.0`, implement a `CashuWalletBackend` class that wraps the library's `Wallet`, store raw proofs in a new `cashu_proofs` table, and add a `cashu_pending` table for the PENDING lock. Extend `payments.service.ts` with a routing layer that picks the rail before calling the wallet.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@cashu/cashu-ts` | ^3.5.0 | Cashu protocol client (mint/melt/swap/check) | Official TypeScript library from cashubtc org; latest stable as of Feb 2026 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (no new deps needed) | — | All other dependencies already in project | cashu-ts is the only new dependency required |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@cashu/cashu-ts` | Raw HTTP fetch to Nutshell REST | cashu-ts handles blind signature math, proof construction, blinding/unblinding — never hand-roll this |
| External Nutshell | Embedded Python mint | Operator deploys separately (Docker); Treasury is a pure client — cleaner separation |

**Installation:**
```bash
npm install @cashu/cashu-ts
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── modules/payments/wallet/
│   ├── wallet.interface.ts        # WalletBackend interface (existing — extend PaymentResult)
│   ├── simulated.wallet.ts        # (existing)
│   ├── lightning.wallet.ts        # (existing)
│   └── cashu.wallet.ts            # NEW: CashuWalletBackend
├── lib/
│   ├── lnd/                       # (existing)
│   └── cashu/
│       ├── cashu.client.ts        # Wallet instance factory + keyset rotation watcher
│       └── cashu.startup.ts       # initializeCashuBackend (crash recovery)
├── modules/cashu/
│   └── cashu.repo.ts              # Proof storage + PENDING lock CRUD
└── db/schema.ts                   # NEW: cashu_proofs, cashu_pending tables
```

### Pattern 1: CashuWallet as WalletBackend
**What:** `cashu.wallet.ts` implements `WalletBackend` (the same interface as `LightningWallet`), but since Cashu is not selected by routing logic directly from `payments.service.ts` in all cases — routing happens first — the wallet is invoked after rail selection.

**When to use:** Rail selection has already chosen Cashu. The backend wraps cashu-ts `Wallet` operations.

**Example:**
```typescript
// Source: cashu-ts github.com/cashubtc/cashu-ts — verified Feb 2026
import { Wallet } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';

export class CashuWalletBackend {
  private readonly wallet: Wallet;

  constructor(mintUrl: string) {
    this.wallet = new Wallet(mintUrl);
  }

  async initialize(): Promise<void> {
    await this.wallet.loadMint(); // Required before any operation
  }

  // Mint: pay Lightning invoice to get Cashu proofs (fund the pool)
  async mintProofs(amountSat: number): Promise<Proof[]> {
    const quote = await this.wallet.createMintQuoteBolt11(amountSat);
    // quote.request is the BOLT11 invoice to pay via LND
    // After payment confirmed:
    return this.wallet.mintProofsBolt11(amountSat, quote);
  }

  // Melt: spend Cashu proofs to pay a Lightning invoice
  async meltProofs(invoice: string, proofs: Proof[]): Promise<MeltProofsResponse> {
    const meltQuote = await this.wallet.createMeltQuoteBolt11(invoice);
    // meltQuote.amount = sat needed, meltQuote.fee_reserve = max fee
    return this.wallet.meltProofsBolt11(meltQuote, proofs);
  }

  // Swap: exchange proofs from an old keyset for new ones
  async swapProofs(proofs: Proof[]): Promise<Proof[]> {
    const { keep } = await this.wallet.send(
      proofs.reduce((sum, p) => sum + p.amount, 0),
      proofs,
    );
    return keep;
  }

  // Check proof states for crash recovery (NUT-07)
  async checkProofStates(proofs: Proof[]) {
    return this.wallet.checkProofsStates(proofs);
  }
}
```

### Pattern 2: Routing Layer in payments.service.ts
**What:** Before calling any wallet, `processPayment` decides which rail to use based on amount threshold and `preferred_rail` hint. It routes to `cashuWallet` or `lightningWallet`.

**When to use:** Every payment request. The routing decision is logged in audit metadata.

**Example:**
```typescript
// Routing logic inserted before wallet call in processPayment
function selectRail(
  amountMsat: number,
  preferredRail: 'lightning' | 'cashu' | undefined,
  threshold: number, // config.CASHU_THRESHOLD_MSAT
): 'lightning' | 'cashu' {
  if (preferredRail) return preferredRail;
  return amountMsat < threshold ? 'cashu' : 'lightning';
}
```

### Pattern 3: PENDING Proof Lock (double-spend prevention)
**What:** Before submitting proofs to the Nutshell mint, Treasury inserts a row keyed by proof secret into `cashu_pending`. A concurrent request trying to use the same proof will hit a UNIQUE constraint and be rejected. Lock is released on settle or fail.

**When to use:** Wraps every melt/swap operation.

**Example:**
```typescript
// cashu.repo.ts
export const cashuRepo = {
  // Returns false if any proof secret is already PENDING (double-spend blocked)
  lockProofs(db: Db, proofSecrets: string[], txId: string): boolean {
    try {
      for (const secret of proofSecrets) {
        db.insert(cashuPending).values({ secret, tx_id: txId }).run();
      }
      return true;
    } catch {
      return false; // UNIQUE constraint = already locked
    }
  },

  releaseProofs(db: Db, proofSecrets: string[]): void {
    db.delete(cashuPending).where(
      inArray(cashuPending.secret, proofSecrets)
    ).run();
  },

  // Store proofs in pool (treasury-owned ecash)
  insertProofs(db: Db, proofs: Proof[], source: string): void { ... },

  // Get proofs summing to >= amount (coin selection)
  selectProofs(db: Db, amountSat: number): Proof[] { ... },

  // Delete spent proofs after melt settles
  deleteProofs(db: Db, secrets: string[]): void { ... },
};
```

### Pattern 4: Crash Recovery for Cashu (analogous to initializeLightningBackend)
**What:** On startup, find all `cashu_pending` rows (in-flight melt/swap). For each, call `wallet.checkMeltQuoteBolt11(quoteId)` or `wallet.checkProofsStates(proofs)` to determine actual state. Settle or release accordingly.

**When to use:** Called in `initializeCashuBackend` before the server accepts requests.

**Example:**
```typescript
// cashu.startup.ts — mirrors lnd.startup.ts pattern
export async function initializeCashuBackend(db: Db): Promise<CashuWalletBackend> {
  const backend = new CashuWalletBackend(config.CASHU_MINT_URL!);
  await backend.initialize();

  // Crash recovery: find all PENDING cashu operations
  const pending = cashuRepo.getPendingOperations(db);
  for (const op of pending) {
    const states = await backend.checkProofStates(op.proofs);
    // SPENT = melt succeeded, write audit + delete proofs
    // UNSPENT = melt failed or crashed before, release PENDING lock, restore proofs
    // PENDING = mint still processing, leave PENDING
  }

  // Keyset rotation: swap any proofs from inactive keysets
  await backend.swapInactiveKeysetProofs(db);

  return backend;
}
```

### Anti-Patterns to Avoid
- **Hand-rolling blind signature math:** Never implement Chaumian blind signatures manually. cashu-ts handles all cryptography.
- **Storing token strings instead of Proof objects:** Store the raw `{ id, amount, secret, C }` fields — token strings are for external transfer, not internal storage.
- **Synchronous blocking on melt:** `meltProofsBolt11` is async and can take time on Lightning. Use async properly; do NOT call synchronously inside a better-sqlite3 transaction callback.
- **Skipping loadMint():** The `Wallet` constructor does not make network calls; `loadMint()` MUST be called before any operation or the wallet has no keyset data.
- **Using same proofs concurrently:** Without the PENDING lock, two concurrent requests could submit the same proof to the mint. The mint will accept the first and reject the second with an error — by then the balance has already been debited. Lock BEFORE submit.
- **Treating melt quote fee_reserve as exact fee:** `fee_reserve` is a maximum; actual fee may be less. Always check the melt response for actual amount paid and write the correct ledger debit.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Blind signature crypto | Custom ECDH/hash_to_curve | `@cashu/cashu-ts` Wallet | Cashu uses secp256k1 DLEQ proofs — cryptographic errors cause silent token theft |
| Coin selection | Custom denomination picker | `wallet.selectProofsToSend()` or cashu-ts internals | Off-by-one in denomination math leads to over/under payment |
| Proof serialization | Custom JSON format | cashu-ts Proof type directly | Token format has versioned spec; library handles encoding |
| Keyset key derivation | Custom derivation | cashu-ts Keyset + `verifyKeysetId()` | Must match mint's derivation exactly or proofs are invalid |
| DLEQ verification | Skip or manual check | cashu-ts handles internally | DLEQ proofs prevent mint equivocation — skipping allows mint to defraud wallet |

**Key insight:** Cashu cryptography is subtle. The library exists precisely because hand-rolling it is error-prone and has security implications for real Bitcoin.

## Common Pitfalls

### Pitfall 1: Proof Pool Depletion on Melt
**What goes wrong:** Treasury tries to melt proofs for a payment but the pool doesn't have enough denominations. Melt fails with insufficient proofs.
**Why it happens:** Cashu uses fixed denominations (1, 2, 4, 8, 16... sats). The pool may have the right total but wrong denominations (e.g., need 3 sats but only have two 2-sat proofs).
**How to avoid:** Before melt, always call `wallet.selectProofsToSend(amount, allPoolProofs, true)` which handles denomination selection. If it throws, trigger a pool-swap to re-denominate. Include `fee_reserve` in amount when selecting.
**Warning signs:** `Error: not enough proofs` from cashu-ts coin selection.

### Pitfall 2: Forgetting fee_reserve in proof selection for melt
**What goes wrong:** Treasury selects proofs covering exactly the payment amount but the melt fails because fees (fee_reserve) weren't included.
**Why it happens:** `meltQuote.fee_reserve` is an additional sat amount the mint requires for Lightning routing fees.
**How to avoid:** Select proofs for `meltQuote.amount + meltQuote.fee_reserve` (both in sat). Any change returned by the mint as new proofs must be added back to the pool.
**Warning signs:** Melt returns error about insufficient inputs.

### Pitfall 3: Concurrent Double-Spend Without PENDING Lock
**What goes wrong:** Two payment requests arrive simultaneously for amounts that would both be satisfied by the same pool proofs. Both proceed to the mint; the first one spends the proofs; the second one gets a "token already spent" error from the mint AFTER the balance was already debited.
**Why it happens:** No locking around proof selection and submission.
**How to avoid:** The PENDING lock (insert proof secrets into `cashu_pending` before melt) must be inside the SAME synchronous better-sqlite3 transaction that selects and removes proofs from the pool. This is the Cashu equivalent of the Lightning RESERVE pattern.
**Warning signs:** Duplicate `secret` values appearing in melt calls.

### Pitfall 4: Inactive Keyset Proofs Become Invalid
**What goes wrong:** Nutshell operator rotates to a new keyset. Old proofs still work as INPUTS (swap/melt) but new OUTPUTS must use the active keyset. If Treasury has stored proofs from an old keyset and tries to use them long after rotation, the mint may eventually reject them.
**Why it happens:** Keyset rotation is a mint-side event; wallet must detect it.
**How to avoid:** On startup and periodically, call `wallet.getKeySets()` and compare against stored proof keyset IDs. Proofs from inactive keysets should be swapped for active-keyset proofs immediately. Log the swap in audit with `KEYSET_ROTATION` action.
**Warning signs:** `Error: keyset not found` or proofs suddenly rejected.

### Pitfall 5: loadMint() Not Called After Constructor
**What goes wrong:** `new Wallet(mintUrl)` succeeds but subsequent calls to `createMintQuoteBolt11()` throw because no keyset data is loaded.
**Why it happens:** `Wallet` constructor is synchronous and makes no network calls. `loadMint()` is the async initializer.
**How to avoid:** Always `await wallet.loadMint()` before the server starts accepting requests. Cache the result with `loadMintFromCache()` for restarts.
**Warning signs:** `Error: no active keyset` on first operation.

### Pitfall 6: Melt Blocks Indefinitely (Synchronous melt call)
**What goes wrong:** `meltProofsBolt11` blocks waiting for Lightning to settle. Under default mode (synchronous), this can take many seconds. If called inside a timer-bounded operation, it times out.
**Why it happens:** NUT-05 default behavior is synchronous — the mint holds the HTTP connection until the Lightning payment resolves.
**How to avoid:** Use `prefer_async: true` (via `MeltProofsConfig`) for melts, then poll `checkMeltQuoteBolt11` for state. OR accept the blocking behavior and ensure no request timeout is set below 30s for melt operations.
**Warning signs:** HTTP 504/timeout errors on pay endpoint when using Cashu rail.

## Code Examples

Verified patterns from cashu-ts v3.5.0 (official source: github.com/cashubtc/cashu-ts, Feb 2026):

### Wallet Initialization
```typescript
// Source: github.com/cashubtc/cashu-ts README + Wallet.ts
import { Wallet } from '@cashu/cashu-ts';

const wallet = new Wallet('http://localhost:3338', { unit: 'sat' });
await wallet.loadMint(); // REQUIRED before any operation
```

### Mint Flow (fund the proof pool by paying a Lightning invoice)
```typescript
// Source: cashu-ts Wallet class methods (verified Feb 2026)
// Step 1: Get a Lightning invoice to pay
const mintQuote = await wallet.createMintQuoteBolt11(amountSat);
// mintQuote.quote    — quote ID (persist this)
// mintQuote.request  — BOLT11 invoice to pay via LND
// mintQuote.state    — 'UNPAID' initially

// Step 2: Pay the invoice via LND (via existing LightningWallet)

// Step 3: After payment confirmed, mint the proofs
const proofs = await wallet.mintProofsBolt11(amountSat, mintQuote);
// proofs: Proof[] = [{ id, amount, secret, C }, ...]
// Store these in cashu_proofs table
```

### Melt Flow (pay a Lightning invoice using Cashu proofs)
```typescript
// Source: cashu-ts Wallet class methods (verified Feb 2026)
// Step 1: Get a melt quote for the target invoice
const meltQuote = await wallet.createMeltQuoteBolt11(bolt11Invoice);
// meltQuote.quote        — quote ID (persist for crash recovery)
// meltQuote.amount       — sat needed (may differ from invoice amount)
// meltQuote.fee_reserve  — max fee sat the mint will use

// Step 2: Select proofs from pool (must cover amount + fee_reserve)
const totalNeeded = meltQuote.amount + meltQuote.fee_reserve;
const { send: proofsToSend } = wallet.selectProofsToSend(
  totalNeeded, poolProofs, true
);

// Step 3: Lock proofs (PENDING in DB) — prevents double-spend

// Step 4: Execute melt
const result = await wallet.meltProofsBolt11(meltQuote, proofsToSend);
// result.quote.state == 'PAID'   → payment settled
// result.quote.preimage          → Lightning preimage (like payment_hash)
// result.change                  → new proofs returned as change (add to pool)
```

### Check Proof States (NUT-07 — used for crash recovery)
```typescript
// Source: cashu-ts Wallet + NUT-07 spec (verified Feb 2026)
import { CheckStateEnum } from '@cashu/cashu-ts';

const states = await wallet.checkProofsStates(proofs);
// states: ProofState[] = [{ Y: string, state: CheckStateEnum, witness?: string }]
// CheckStateEnum.UNSPENT  — proof is valid and spendable
// CheckStateEnum.PENDING  — proof is in a pending melt (mint-side lock)
// CheckStateEnum.SPENT    — proof has been redeemed
```

### Keyset Check (for rotation detection)
```typescript
// Source: cashu-ts Wallet class (verified Feb 2026)
const keysets = await wallet.keyChain.cache; // or wallet.getKeyset()
const mintInfo = wallet.getMintInfo();
// Compare proof.id (keyset ID) against active keysets
// If proof.id not in active keysets, swap immediately
```

### Nutshell Docker (for docker-compose.dev.yml extension)
```yaml
# Source: github.com/cashubtc/nutshell README (verified Feb 2026)
nutshell:
  image: cashubtc/nutshell:0.19.2
  container_name: nutshell
  command: poetry run mint
  ports:
    - "3338:3338"
  environment:
    MINT_BACKEND_BOLT11_SAT: LndRestWallet         # LND REST backend
    MINT_LND_REST_ENDPOINT: https://lnd-alice:8080  # lnd-alice REST port
    MINT_LND_REST_MACAROON: ${LND_MACAROON_HEX}    # admin or invoice macaroon
    MINT_LND_REST_CERT: ${LND_CERT_BASE64}
    MINT_PRIVATE_KEY: ${NUTSHELL_PRIVATE_KEY}       # mint's signing key
    MINT_LISTEN_HOST: 0.0.0.0
    MINT_LISTEN_PORT: 3338
```

### Database Schema Extensions
```typescript
// New tables needed in src/db/schema.ts

// Proof pool: treasury-owned ecash tokens
export const cashuProofs = sqliteTable('cashu_proofs', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  keyset_id: text('keyset_id').notNull(),       // proof.id (keyset identifier)
  amount: integer('amount').notNull(),            // sat (NOT msat)
  secret: text('secret').notNull().unique(),      // proof.secret — globally unique
  C: text('C').notNull(),                         // proof.C (commitment)
  source_tx_id: text('source_tx_id'),             // which mint tx created this proof
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date()).notNull(),
});

// Pending lock: prevents concurrent double-spend of same proofs
export const cashuPending = sqliteTable('cashu_pending', {
  secret: text('secret').primaryKey(),            // proof.secret — unique key IS the lock
  tx_id: text('tx_id').notNull(),                 // which payment owns this lock
  melt_quote_id: text('melt_quote_id'),           // Nutshell quote ID for crash recovery
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date()).notNull(),
});
```

### Schema and Enum Extensions (existing tables)
```typescript
// ledgerEntries.mode needs 'cashu' added:
mode: text('mode', { enum: ['simulated', 'lightning', 'cashu'] }).default('simulated')

// payments.routes.ts asset enum needs 'BTC_cashu':
asset: z.enum(['BTC_simulated', 'BTC_lightning', 'BTC_cashu'])

// PaymentResponse needs new routing fields:
interface PaymentResponse {
  // ...existing fields...
  rail_used?: 'lightning' | 'cashu';
  cashu_token_id?: string;             // proof secret reference
  initial_rail?: 'lightning' | 'cashu';
  final_rail?: 'lightning' | 'cashu';
  fallback_occurred?: boolean;
}

// auditLog.action needs new values:
action: text('action', { enum: [
  // ...existing...
  'PAYMENT_SETTLED',
  'PAYMENT_FAILED',
  'CASHU_MINT',         // Treasury minted new proofs (funded pool)
  'CASHU_MELT',         // Treasury melted proofs to pay invoice
  'CASHU_KEYSET_SWAP',  // Treasury swapped proofs due to keyset rotation
]})
```

### Config Extensions
```typescript
// config.ts additions
WALLET_BACKEND: z.enum(['simulated', 'lightning', 'cashu', 'auto']).default('simulated'),
CASHU_MINT_URL: z.string().url().optional(),
CASHU_THRESHOLD_MSAT: z.coerce.number().default(1_000_000), // 1,000 sat
// Refine: CASHU_MINT_URL required when WALLET_BACKEND includes cashu
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `mintTokens()` / `meltTokens()` | `mintProofsBolt11()` / `meltProofsBolt11()` | cashu-ts v2.0 | Method names differ from old tutorials; must use new names |
| `checkProofsSpent()` | `checkProofsStates()` returning `ProofState[]` | cashu-ts v2.0 | Returns richer state including PENDING, not just boolean spent |
| `CashuMint.split()` | `CashuMint.swap()` / `Wallet.send()` | cashu-ts v2.0 | split() is gone; use send() for splitting/swapping |
| Nutshell wallet REST API | Removed in v0.17.0 | 2024 | Nutshell no longer has a built-in wallet REST API — only mint REST API remains |
| `payLnInvoice` helper | Manual quote flow | cashu-ts v2.0 | Must explicitly create quote, wait for payment, then mint proofs |

**Deprecated/outdated:**
- `CashuWallet` (old class name): current class is `Wallet` from `@cashu/cashu-ts`
- `mintTokens`/`meltTokens`: renamed to `mintProofsBolt11`/`meltProofsBolt11` in v2+
- Nutshell wallet API: removed in v0.17.0 — Treasury must operate as a pure mint CLIENT

## Open Questions

1. **Melt change proof handling**
   - What we know: `meltProofsBolt11` returns `result.change` as new proofs (change from overpayment for fee_reserve)
   - What's unclear: Whether change proofs are always present, and whether the Nutshell v0.19.x implementation reliably returns them
   - Recommendation: Always handle `result.change` defensively — if present, store in proof pool; if absent, log warning

2. **cashu-ts Wallet thread-safety / concurrent usage**
   - What we know: The library is "mostly stateless" — Wallet instance can be shared
   - What's unclear: Whether a single Wallet instance shared across concurrent requests is safe, or if a new instance per request is needed
   - Recommendation: Create one shared Wallet instance (like LightningWallet); the PENDING lock in DB prevents concurrent proof submission regardless

3. **Nutshell LND backend REST vs gRPC**
   - What we know: Nutshell supports `LndRestWallet` (REST) and has a GitHub issue requesting gRPC support (#519)
   - What's unclear: Whether the existing LND Alice node's REST port (8080) can be used by Nutshell in the dev environment
   - Recommendation: Use `LndRestWallet` with lnd-alice's REST endpoint; this shares the same LND node for both Lightning payments and Cashu pool funding. This is acceptable for dev; prod may need a separate LND for the mint.

4. **Proof pool initial funding**
   - What we know: Treasury needs Cashu proofs in its pool to execute Cashu payments; proofs come from minting (paying Lightning invoices to the Nutshell mint)
   - What's unclear: Who initiates the initial pool funding and when
   - Recommendation: Phase 3 scope is agent-initiated payments only. Pool is funded lazily: when a Cashu payment is requested and the pool is empty/insufficient, auto-mint the needed amount via LND. Mint cost comes from the agent's balance (already reserved). Document this as the implementation strategy.

5. **WALLET_BACKEND config for dual-rail**
   - What we know: Current config has `WALLET_BACKEND: 'simulated' | 'lightning'`; Phase 3 adds Cashu as a second rail that runs alongside Lightning (not instead of)
   - What's unclear: Whether to add `'cashu'` as a separate mode or `'auto'` for the dual-rail routing mode
   - Recommendation: Add `WALLET_BACKEND=auto` for dual-rail (Lightning + Cashu routing). `WALLET_BACKEND=lightning` remains Lightning-only for operators without a mint. `WALLET_BACKEND=cashu` could be Cashu-only if Lightning is unavailable.

## Sources

### Primary (HIGH confidence)
- `github.com/cashubtc/cashu-ts` (Feb 2026) — Wallet.ts, Mint.ts, WalletOps.ts source files read directly. Version v3.5.0 confirmed.
- `cashubtc.github.io/nuts/03/` — NUT-03 swap API spec (endpoint, request/response format)
- `cashubtc.github.io/nuts/04/` — NUT-04 mint token API spec (endpoint, request/response format)
- `cashubtc.github.io/nuts/05/` — NUT-05 melt token API spec (endpoint, request/response format, async mode)
- `cashubtc.github.io/nuts/07/` — NUT-07 token state check API spec (ProofState values: UNSPENT/PENDING/SPENT)
- `github.com/cashubtc/nutshell` — Nutshell v0.19.2 README: Docker command, env vars confirmed

### Secondary (MEDIUM confidence)
- WebSearch + cashu-ts migration guide — Method rename history (v1→v2→v3): `mintTokens→mintProofsBolt11`, `meltTokens→meltProofsBolt11`, etc.
- WebSearch + NUT-07 spec — Nutshell tracks PENDING proofs with mutex lock; wallet should use DB PENDING lock
- Nutshell LND REST backend env vars (`MINT_BACKEND_BOLT11_SAT=LndRestWallet`, `MINT_LND_REST_ENDPOINT`, etc.) — from WebSearch cross-referenced with nutshell README

### Tertiary (LOW confidence)
- cashu-ts Wallet constructor `unit: 'sat'` option — inferred from source directory structure; confirm in practice
- Nutshell `fee_reserve` change proof behavior in v0.19.x — inferred from NUT-05 spec; should be validated with integration test

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — cashu-ts v3.5.0 verified from official GitHub, npm. Single obvious choice.
- Architecture: HIGH — Wallet class API verified from source. Patterns mirror proven Lightning patterns from Phase 2.
- Pitfalls: MEDIUM/HIGH — coin selection, PENDING lock, keyset rotation verified from NUT specs and migration guides. Fee reserve behavior LOW for exact edge cases.
- Nutshell Docker config: MEDIUM — env vars from README confirmed; exact networking with lnd-alice needs integration test.

**Research date:** 2026-02-27
**Valid until:** 2026-08-27 (cashu-ts is moving fast; re-verify if > 3 months old)
