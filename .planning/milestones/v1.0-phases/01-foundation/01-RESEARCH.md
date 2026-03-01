# Phase 1: Foundation - Research

**Researched:** 2026-02-26
**Domain:** TypeScript/Fastify API service with SQLite ledger, policy engine, and audit log
**Confidence:** HIGH (stack is locked, patterns are well-established and verified)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Technology stack:**
- TypeScript (Node.js 24.x LTS) + Fastify 5.7.x
- SQLite via Drizzle ORM for Phase 1 (PostgreSQL deferred to Phase 2+)
- Zod v4 for all request/response validation
- Pino for structured JSON logging
- Vitest for unit + integration testing
- Guiding principle: use best available SDKs and libraries from dependencies. No DIY rewrites or heavy customization — lean into ecosystem support.

**API shape and conventions:**
- Flat response format — success returns top-level fields, errors return `{"error": {"code": "...", "message": "...", "details": {...}}}`
- Cursor-based pagination on all list endpoints — `?cursor=xxx&limit=50`, response includes `next_cursor` and `has_more`
- Prefixed ULIDs for all identifiers — `ag_` for agents, `tx_` for transactions, `pl_` for policies, `vtk_` for tokens
- All monetary amounts in millisatoshis as integers — `amount_msat`, `balance_msat`, `daily_limit_msat`

**Authentication model:**
- Single static admin token for operator (set via env var `VAULTWARDEN_ADMIN_TOKEN`) — all management endpoints require it
- Per-agent static bearer tokens generated at registration — agents authenticate with `Authorization: Bearer vtk_...`
- Two auth scopes: operator (admin) and agent (own sub-account only)

**Policy configuration:**
- API-only policy management — `PUT /agents/{id}/policy` with JSON body
- Deny-all default policy on agent registration — new agents cannot spend until operator explicitly sets a policy
- Rolling 24h window for daily spend limits — no midnight reset edge, smooth and predictable
- Fail-closed: any policy engine error produces DENY, never ALLOW

**Simulated payment behavior:**
- Deterministic success — sim always succeeds if policy allows. No randomized failures in Phase 1.
- Transparent mode — responses include `"mode": "simulated"` field
- Operator-funded deposits — `POST /agents/{id}/deposit` with `amount_msat`. Real balance tracking, just no real money.
- Full payment state machine — PENDING -> SETTLED or FAILED. Sim transitions instantly but goes through the same FSM.

### Claude's Discretion
- URL path structure and resource naming conventions
- Exact Drizzle schema design and migration strategy
- Error code taxonomy (specific error codes within the error envelope)
- Testing strategy (unit vs integration test boundaries)
- Project directory structure (adapting ARCHITECTURE.md's `.rs` structure to TypeScript modules)
- Exact structured logging field names and formats

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AGNT-01 | Operator can register a new agent and receive a unique agent_id and static bearer token | Drizzle schema with ULID text PK + $defaultFn, `ulidx` for `ag_` and `vtk_` prefixed IDs, Fastify admin-scoped route |
| AGNT-02 | Each agent has an isolated sub-account with independent balance tracking | Double-entry ledger pattern: balance derived from SUM of journal entries, never a mutable counter |
| AGNT-03 | Agent can query its own balance per asset (e.g., BTC_on_LN) | Read-only balance query via Drizzle aggregate; agent-scoped auth prevents cross-agent reads |
| AGNT-04 | Agent can view its own payment history filtered by date range and action type | Cursor-based pagination on audit_log table; Drizzle `.where()` + integer timestamp range filter |
| AGNT-05 | Agent metadata and current policy snapshot are retrievable via API | JOIN query across agents + policies tables; Zod response schema shapes the output |
| PAY-01 | Agent can submit a payment request specifying amount, asset, purpose, destination type, and destination details | Zod schema validates all fields strictly; policy evaluation runs before any ledger write |
| PAY-02 | Payment requests work in simulated mode with identical API surface | SimulatedWallet implements WalletBackend interface; response includes `"mode": "simulated"` |
| PLCY-01 | Policy engine evaluates every payment request before dispatch — no bypass path | Policy evaluation is a synchronous function call in the payment handler; no execution path skips it |
| PLCY-02 | Per-agent configurable maximum single transaction amount | Policy config stored in agents/policies table; evaluated against `amount_msat` before ledger write |
| PLCY-03 | Per-agent configurable daily spend limit (rolling 24h window) | SQLite query: `SUM(amount_msat) WHERE created_at > (now - 86400000ms)` against ledger entries |
| PLCY-04 | Policy engine returns ALLOW, DENY, or REQUIRE_HUMAN_APPROVAL | TypeScript discriminated union `PolicyDecision` returned from `evaluatePolicy()` |
| PLCY-05 | Policy engine defaults to DENY on any internal error (fail-closed) | try/catch wraps entire `evaluatePolicy()` body; catch block returns DENY decision |
| OBSV-01 | Append-only audit log records every financial action with timestamp, agent_id, action type, parameters, policy decision, and result | Separate `audit_log` table; application never issues DELETE/UPDATE on it; write within same transaction as ledger entry |
| OBSV-02 | Audit log entries are written in the same database transaction as the ledger update they describe | Drizzle `db.transaction()` wraps both ledger insert and audit_log insert atomically |
| OBSV-03 | Audit log is filterable by agent_id, action_type, and time range via API | Drizzle `.where()` with `and(eq, gte, lte)` predicates; cursor pagination on `created_at` |
| OBSV-04 | All wallet private keys, LN macaroons, and Cashu mint credentials are stored only in the Treasury Service | Phase 1 has no real credentials; pattern established: secrets only in env vars, never in agent responses |
| OBSV-05 | Agent bearer tokens and secrets are masked in all log output | Pino `redact` config with paths for `req.headers.authorization` and any token fields |
| SEC-01 | Agents authenticate via static bearer tokens — no direct access to wallet keys | `@fastify/bearer-auth` or custom `onRequest` hook validates `vtk_` token against agents table |
| SEC-02 | Policy enforcement and ledger debit happen inside a single atomic database transaction | Drizzle `db.transaction({ behavior: 'immediate' })` wraps policy read + ledger write + audit write |
| SEC-03 | All agent-supplied strings are validated via strict Zod schemas — no free-text fields affect policy routing | Every route uses `ZodTypeProvider`; no `z.any()` or `z.unknown()` in payment paths |
| SEC-06 | If Treasury Service is down, agents cannot move money (fail-closed architecture) | Synchronous policy check before wallet call; no async bypass; service unavailability = no payment |
</phase_requirements>

---

## Summary

Phase 1 builds the complete API contract for the Agent Treasury Service using simulated payments — no real money moves, but every data model, auth boundary, policy rule, and audit event is production-ready. The technology stack is fully locked: Fastify 5 + Zod v4 + Drizzle ORM + SQLite + Pino + Vitest. Research confirms all these libraries work together cleanly with verified patterns.

The two most critical implementation concerns are: (1) the atomic transaction that must wrap policy evaluation, ledger write, and audit write in a single SQLite `IMMEDIATE` transaction to satisfy SEC-02 and OBSV-02; and (2) the fail-closed policy engine where the catch block in `evaluatePolicy()` must return `DENY` — never re-throw. Everything else is standard CRUD around those invariants.

The simulated wallet pattern — a class implementing the same `WalletBackend` interface that Lightning will use in Phase 2 — is the key architectural decision that lets this phase deliver a complete, exercisable API with zero real infrastructure.

**Primary recommendation:** Build in component dependency order: schema/migrations first, then audit log module, then ledger module, then agent registry, then policy engine, then simulated wallet, then API routes. Each component is testable in isolation before the next depends on it.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Fastify | 5.7.x | HTTP API framework | Native TypeScript generics, schema-first validation, 3x faster than Express. v5 targets Node 20+. |
| `fastify-type-provider-zod` | 6.1.x | Zod↔Fastify bridge | Allows Zod schemas to drive both TypeScript types AND runtime validation on routes. Single source of truth. |
| Zod | 4.x | Schema validation | 14x faster than Zod 3. Import from `zod/v4`. Zod schema → TS type → runtime validation with no duplication. |
| Drizzle ORM | 0.45.x | Database access | SQL-explicit TypeScript ORM. `$defaultFn()` for ULID PKs, `db.transaction()` with `immediate` behavior for atomic writes. |
| `better-sqlite3` | latest | SQLite driver | Synchronous SQLite for Node.js. Enable WAL mode on startup for concurrent reads during writes. |
| `drizzle-kit` | latest | Migration CLI | `drizzle-kit generate` + `drizzle-kit migrate`. Schema changes tracked as SQL files in git. |
| Pino | 10.3.x | Structured JSON logging | 10x faster than Winston. `redact` config masks bearer tokens in `req.headers.authorization`. |
| `ulidx` | latest | ULID generation | ULID generator in TypeScript. Use `ulid()` wrapped with prefix: `` `ag_${ulid()}` ``. Uses `crypto.randomBytes`. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino-http` | latest | HTTP request logging | Fastify plugin for automatic req/res structured logs with timing. Register at app startup. |
| `pino-pretty` | latest | Dev log formatting | Dev only — never in production (adds overhead). Run via `tsx src/index.ts | pino-pretty`. |
| `@fastify/bearer-auth` | latest | Bearer token auth hook | Handles `Authorization: Bearer <token>` extraction and constant-time comparison. Use for both scopes. |
| `dotenv` | latest | Env var loading | Load `VAULTWARDEN_ADMIN_TOKEN` and other secrets from `.env` at startup. Validate via Zod at boot. |
| `tsx` | latest | Dev TypeScript runner | `tsx src/index.ts` runs `.ts` directly without compile step. Use in `dev` npm script. |
| Vitest | 4.x | Testing | Jest-compatible API. `:memory:` SQLite for integration tests. `vi.fn()` for wallet mock. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `fastify-type-provider-zod` (community) | `@fastify/type-provider-zod` (official) | The community package (`turkerdev/fastify-type-provider-zod`) is the de facto standard — v6.1.0, active, imports from `zod/v4`. The official scoped package is a different package; verify peer deps before installing either. |
| `better-sqlite3` (sync) | `@libsql/client` (async) | libsql is async and supports Turso cloud — overkill for Phase 1. Use better-sqlite3 for simplicity; WAL mode gives sufficient concurrency. |
| `ulidx` | `ulid` (original npm) | Original `ulid` package is less maintained. `ulidx` is the TypeScript-first successor. Both use `crypto.randomBytes`. |

**Installation:**

```bash
# Core service
npm install fastify fastify-type-provider-zod zod pino pino-http @fastify/bearer-auth dotenv

# Database
npm install drizzle-orm better-sqlite3

# ID generation
npm install ulidx

# Dev dependencies
npm install -D typescript vitest tsx drizzle-kit @types/node @types/better-sqlite3 pino-pretty
```

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── db/
│   ├── schema.ts        # Drizzle table definitions (single source of truth)
│   ├── client.ts        # Database singleton, WAL mode, connection init
│   └── migrations/      # Generated SQL files from drizzle-kit
├── modules/
│   ├── agents/
│   │   ├── agents.repo.ts       # DB queries for agent CRUD
│   │   └── agents.service.ts    # Business logic (register, get, list)
│   ├── ledger/
│   │   ├── ledger.repo.ts       # Journal entry inserts, balance queries
│   │   └── ledger.service.ts    # deposit(), debit(), getBalance()
│   ├── audit/
│   │   └── audit.repo.ts        # Append-only audit_log inserts (no reads in hot path)
│   ├── policy/
│   │   └── policy.engine.ts     # evaluatePolicy() — pure function, fail-closed
│   ├── payments/
│   │   ├── payments.service.ts  # Orchestrates: policy → wallet → ledger → audit
│   │   └── wallet/
│   │       ├── wallet.interface.ts   # WalletBackend interface
│   │       └── simulated.wallet.ts  # Phase 1 implementation
│   └── tokens/
│       └── tokens.service.ts    # generateAgentToken(), hashToken(), verifyToken()
├── routes/
│   ├── admin/           # Operator-scoped routes (VAULTWARDEN_ADMIN_TOKEN)
│   │   ├── agents.routes.ts     # POST /agents, GET /agents
│   │   └── policy.routes.ts     # PUT /agents/:id/policy
│   └── agent/           # Agent-scoped routes (vtk_ bearer token)
│       ├── payments.routes.ts   # POST /agents/:id/pay
│       ├── balance.routes.ts    # GET /agents/:id/balance
│       └── history.routes.ts    # GET /agents/:id/history
├── middleware/
│   ├── adminAuth.ts     # onRequest hook for VAULTWARDEN_ADMIN_TOKEN
│   └── agentAuth.ts     # onRequest hook for vtk_ tokens + identity injection
├── plugins/
│   └── pino.plugin.ts   # Logger config with redact paths
├── config.ts            # Env var loading + Zod validation at startup
└── app.ts               # Fastify instance creation, plugin registration, route mounting
```

**Structure rationale:** Routes are thin — they parse input and call service functions. Services orchestrate business logic. Repos are pure DB access. Policy engine is a pure function with no HTTP dependencies. This separation enables unit testing of policy logic without Fastify overhead.

---

### Pattern 1: Atomic Policy + Ledger + Audit Transaction (SEC-02, OBSV-02)

**What:** Every payment goes through a single SQLite `IMMEDIATE` transaction that wraps: (a) balance/limit reads, (b) policy evaluation, (c) journal entry insert, (d) audit_log insert. If any step fails, the entire transaction rolls back.

**When to use:** Every payment request. This is the non-negotiable safety invariant.

**Why IMMEDIATE:** WAL mode allows concurrent readers, but a writer needs a reserved lock from the start of the transaction. `IMMEDIATE` acquires this lock at `BEGIN`, preventing TOCTOU races where another write sneaks in between the balance read and the debit write.

```typescript
// Source: Drizzle ORM docs + ARCHITECTURE.md pattern
async function processPayment(
  db: BetterSQLite3Database,
  agentId: string,
  req: PayRequest,
  logger: pino.Logger
): Promise<PayResult> {
  return db.transaction(
    async (tx) => {
      // 1. Read current state (inside transaction — consistent snapshot)
      const agent = await agentsRepo.findById(tx, agentId);
      const balance = await ledgerRepo.getBalance(tx, agentId);
      const dailySpend = await ledgerRepo.getDailySpend(tx, agentId);

      // 2. Policy evaluation — fail-closed
      const decision = evaluatePolicy(agent.policy, { balance, dailySpend, req });

      // 3. Write audit entry for policy decision (ALWAYS — even for DENY)
      await auditRepo.insert(tx, {
        agent_id: agentId,
        action: 'PAYMENT_REQUEST',
        policy_decision: decision.outcome,
        policy_reason: decision.reason,
        amount_msat: req.amount_msat,
      });

      if (decision.outcome !== 'ALLOW') {
        return { outcome: decision.outcome, reason: decision.reason };
      }

      // 4. Execute simulated payment (outside real DB concern — pure logic)
      const walletResult = simulatedWallet.pay(req);

      // 5. Write ledger entry
      await ledgerRepo.insert(tx, {
        agent_id: agentId,
        amount_msat: -req.amount_msat,
        entry_type: 'PAYMENT',
        ref_id: walletResult.transaction_id,
      });

      // 6. Update audit with settlement result
      await auditRepo.insert(tx, {
        agent_id: agentId,
        action: 'PAYMENT_SETTLED',
        ref_id: walletResult.transaction_id,
        amount_msat: req.amount_msat,
      });

      return { outcome: 'ALLOW', transaction_id: walletResult.transaction_id, mode: 'simulated' };
    },
    { behavior: 'immediate' }
  );
}
```

---

### Pattern 2: Fail-Closed Policy Engine (PLCY-05)

**What:** `evaluatePolicy()` is a pure synchronous function wrapped in try/catch. Any thrown error produces DENY, never re-throws.

**When to use:** Every payment request, called from within the atomic transaction.

```typescript
// Source: STACK.md policy engine pattern + ARCHITECTURE.md
type PolicyOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL';

interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  rule_matched?: string;
}

interface PolicyConfig {
  max_transaction_msat: number;
  daily_limit_msat: number;
}

interface PolicyContext {
  balance_msat: number;
  daily_spent_msat: number;
  req: { amount_msat: number };
}

function evaluatePolicy(
  policy: PolicyConfig | null,
  ctx: PolicyContext
): PolicyDecision {
  try {
    // Default deny — no policy configured
    if (!policy) {
      return { outcome: 'DENY', reason: 'no_policy_configured' };
    }

    // Per-transaction limit
    if (ctx.req.amount_msat > policy.max_transaction_msat) {
      return {
        outcome: 'DENY',
        reason: 'exceeds_max_transaction',
        rule_matched: 'max_transaction_msat',
      };
    }

    // Rolling 24h daily limit
    if (ctx.daily_spent_msat + ctx.req.amount_msat > policy.daily_limit_msat) {
      return {
        outcome: 'DENY',
        reason: 'exceeds_daily_limit',
        rule_matched: 'daily_limit_msat',
      };
    }

    // Sufficient balance
    if (ctx.balance_msat < ctx.req.amount_msat) {
      return { outcome: 'DENY', reason: 'insufficient_balance' };
    }

    return { outcome: 'ALLOW', reason: 'policy_passed' };
  } catch (err) {
    // FAIL CLOSED — any error is a DENY, never a throw
    return { outcome: 'DENY', reason: 'policy_engine_error' };
  }
}
```

---

### Pattern 3: Prefixed ULID Generation

**What:** All identifiers are ULIDs prefixed with a resource type prefix. Stored as `text` in SQLite. Never auto-increment integers.

**Why:** Prefixed IDs make logs scannable without joins: `"Policy pl_01HY9 denied tx_01HY1 for agent ag_01HX"`.

```typescript
// Source: CONTEXT.md decisions + ulidx docs
import { ulid } from 'ulidx';

type AgentId = `ag_${string}`;
type TransactionId = `tx_${string}`;
type PolicyId = `pl_${string}`;
type TokenId = `vtk_${string}`;

function generateAgentId(): AgentId {
  return `ag_${ulid()}`;
}

function generateTransactionId(): TransactionId {
  return `tx_${ulid()}`;
}

function generatePolicyId(): PolicyId {
  return `pl_${ulid()}`;
}

function generateAgentToken(): TokenId {
  return `vtk_${ulid()}`;
}
```

In Drizzle schema, use `$defaultFn`:

```typescript
// Source: Drizzle ORM SQLite column types docs
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulidx';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => `ag_${ulid()}`),
  name: text('name').notNull(),
  token_hash: text('token_hash').notNull(),  // hashed vtk_ token — NEVER store plaintext
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date()),
});
```

---

### Pattern 4: Two-Scope Fastify Auth via Plugin Encapsulation

**What:** Admin routes and agent routes live in separate Fastify plugins. Each plugin registers its own `onRequest` hook. The two hooks never overlap.

**When to use:** Separating operator endpoints (register agent, set policy) from agent endpoints (pay, balance, history).

```typescript
// Source: Fastify encapsulation docs + @fastify/bearer-auth patterns
import type { FastifyInstance } from 'fastify';

// Admin plugin — validates VAULTWARDEN_ADMIN_TOKEN
async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !timingSafeEqual(token, process.env.VAULTWARDEN_ADMIN_TOKEN!)) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid admin token' } });
    }
  });

  // Routes here inherit the hook
  app.post('/agents', registerAgentHandler);
  app.put('/agents/:id/policy', updatePolicyHandler);
}

// Agent plugin — validates vtk_ token, injects agent identity
async function agentRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token?.startsWith('vtk_')) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid agent token' } });
    }
    const agent = await agentsRepo.findByTokenHash(hashToken(token));
    if (!agent) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Unknown token' } });
    }
    req.agentId = agent.id;  // Inject for route handlers
  });

  app.post('/agents/:id/pay', paymentHandler);
  app.get('/agents/:id/balance', balanceHandler);
}

// Register both under same app instance
app.register(adminRoutes);
app.register(agentRoutes);
```

**Security note:** Agent tokens are stored hashed in the DB (use `crypto.createHash('sha256')`). The raw `vtk_` token is returned ONCE at registration and never stored or logged.

---

### Pattern 5: Rolling 24h Spend Window (PLCY-03)

**What:** Daily spend is computed by summing ledger debit entries within a rolling 24-hour window from now. No midnight reset — the window always trails 24h from the current timestamp.

```typescript
// Source: CONTEXT.md decisions + SQLite timestamp docs
// Timestamps stored as INTEGER milliseconds (timestamp_ms mode)
async function getDailySpend(tx: DrizzleTransaction, agentId: string): Promise<number> {
  const windowStart = Date.now() - 24 * 60 * 60 * 1000; // 24h ago in ms

  const result = await tx
    .select({ total: sql<number>`COALESCE(SUM(ABS(${ledgerEntries.amount_msat})), 0)` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.agent_id, agentId),
        eq(ledgerEntries.entry_type, 'PAYMENT'),
        gte(ledgerEntries.created_at, windowStart)
      )
    );

  return result[0]?.total ?? 0;
}
```

---

### Pattern 6: Pino Token Redaction (OBSV-05)

**What:** Pino's `redact` config masks `Authorization` headers and any field named `token` or `token_hash` before logs are written.

```typescript
// Source: Pino redaction docs (pinojs/pino/blob/main/docs/redaction.md)
import pino from 'pino';

const logger = pino({
  redact: {
    paths: [
      'req.headers.authorization',   // masks Bearer token in HTTP logs
      '*.token',                      // any object with a .token field
      '*.token_hash',                 // stored hash fields
      '*.vtk_*',                      // catch-all for vtk_ prefixed values
    ],
    censor: '[REDACTED]',
  },
});
```

---

### Pattern 7: Drizzle SQLite Schema for Append-Only Audit Log (OBSV-01, OBSV-02)

**What:** `audit_log` table has no application-level UPDATE or DELETE paths. Enforced by convention (the repo only exports an `insert` function) and optionally by a SQLite trigger.

```typescript
// Source: Drizzle ORM schema docs
export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey().$defaultFn(() => ulid()),
  agent_id: text('agent_id').notNull(),
  action: text('action', {
    enum: [
      'AGENT_REGISTERED',
      'POLICY_UPDATED',
      'PAYMENT_REQUEST',
      'PAYMENT_SETTLED',
      'PAYMENT_FAILED',
      'DEPOSIT',
    ],
  }).notNull(),
  policy_decision: text('policy_decision', {
    enum: ['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL'],
  }),
  amount_msat: integer('amount_msat'),
  ref_id: text('ref_id'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

// Repo — only exposes insert, never update/delete
export const auditRepo = {
  async insert(tx: DrizzleTransaction, entry: NewAuditEntry) {
    return tx.insert(auditLog).values(entry);
  },
};
```

---

### Pattern 8: Fastify Route with Zod v4 TypeProvider

**What:** Every route declares its Zod schemas inline with the route definition. The `ZodTypeProvider` drives both TS types and runtime validation.

```typescript
// Source: fastify-type-provider-zod v6.1.0 README
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';

// One-time setup at app startup:
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// Route definition:
app.withTypeProvider<ZodTypeProvider>().route({
  method: 'POST',
  url: '/agents/:id/pay',
  schema: {
    params: z.object({ id: z.string().startsWith('ag_') }),
    body: z.object({
      amount_msat: z.number().int().positive(),
      asset: z.enum(['BTC_on_LN']),
      purpose: z.string().max(200),
      destination_type: z.enum(['lightning_invoice', 'internal']),
      destination: z.string().max(2000),
    }),
    response: {
      200: z.object({
        transaction_id: z.string().startsWith('tx_'),
        policy_decision: z.enum(['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL']),
        mode: z.literal('simulated'),
        status: z.enum(['SETTLED', 'PENDING', 'FAILED']),
      }),
      403: z.object({
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    },
  },
  handler: async (req, reply) => {
    // req.body, req.params are fully typed from schemas above
    const result = await paymentsService.processPayment(req.agentId, req.body);
    return reply.send(result);
  },
});
```

---

### Pattern 9: SQLite WAL Mode + IMMEDIATE Transactions

**What:** Enable WAL mode at startup for better read/write concurrency. Use `IMMEDIATE` behavior for all write transactions to prevent TOCTOU races.

```typescript
// Source: better-sqlite3 performance docs
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const sqlite = new Database('./vaultwarden.db');
sqlite.pragma('journal_mode = WAL');      // Enable WAL for concurrent reads
sqlite.pragma('foreign_keys = ON');        // Enforce FK constraints
sqlite.pragma('synchronous = NORMAL');     // WAL default; safe with crash recovery

const db = drizzle({ client: sqlite });

// Write transactions — always use IMMEDIATE for payment paths
await db.transaction(
  async (tx) => { /* ... */ },
  { behavior: 'immediate' }
);
```

---

### Anti-Patterns to Avoid

- **Mutable balance counter:** Never `UPDATE agents SET balance = balance - amount`. Derive balance from ledger entry sums. A mutable counter cannot be audited or reconciled.
- **Policy check outside transaction:** Never check policy, then start a transaction to write the debit. The gap between check and write is a TOCTOU race. Policy read and ledger write MUST be in the same `IMMEDIATE` transaction.
- **Logging raw tokens:** Never log `req.headers.authorization` without the Pino `redact` config in place. Set up redaction before any other plugin that might log requests.
- **Storing plaintext agent tokens:** Hash the `vtk_` token with SHA-256 before storing. Return the raw token once in the registration response. The DB never stores the original.
- **Throwing from `evaluatePolicy()`:** The policy engine catch block must return `{ outcome: 'DENY' }`, not `throw`. Any propagation of exceptions from policy evaluation creates a fail-open path.
- **`z.any()` in payment body schemas:** Every field in a payment request must have a specific Zod type. `z.any()` or `z.unknown()` in the body allows injection of unexpected values that could affect policy routing.
- **Fire-and-forget audit writes:** The audit write must be awaited inside the transaction. If the write fails, the transaction rolls back and the payment does not proceed. An unwritten audit event is worse than a rejected payment.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Request validation | Custom validator middleware | Zod v4 + `fastify-type-provider-zod` | Handles type coercion, union discrimination, nested object validation, error formatting |
| Bearer token extraction | String parsing on `Authorization` header | `@fastify/bearer-auth` or Fastify `onRequest` hook | Handles malformed headers, missing headers, timing-safe comparison |
| Token generation | `Math.random()` or UUID v4 | `ulidx` ULID | Sortable, time-encoded, uses `crypto.randomBytes` (cryptographically secure) |
| Migrations | Manual SQL files | `drizzle-kit generate` + `drizzle-kit migrate` | Generates SQL diff from schema changes, tracks applied migrations |
| Structured logging | `console.log` or custom formatter | Pino with `redact` config | Automatic request correlation, JSON output, token masking, 10x faster |
| Rules engine for policy | External rules library | Custom TypeScript `evaluatePolicy()` | 50 lines of TypeScript, trivially unit-tested, no external dependency, auditable |
| Cursor pagination | Custom offset/limit | Drizzle `.where(gt(id, cursor))` pattern | Offset pagination is O(n) full-table scans; cursor is O(1) with an index |

**Key insight:** This phase has no novel algorithmic problems. Every "hard" part — validation, auth, logging, migrations, transactions — has a mature library solution. The only genuinely custom code is the policy engine, and it should be 50 lines.

---

## Common Pitfalls

### Pitfall 1: Zod v4 Import Path
**What goes wrong:** `import { z } from 'zod'` may resolve to Zod v3 API if the package has mixed exports. Route schema validation silently uses old API.
**Why it happens:** Zod v4 changed the import path. The `fastify-type-provider-zod` v6+ README uses `from 'zod/v4'`.
**How to avoid:** Always use `import { z } from 'zod/v4'` throughout the codebase. Add a lint rule if possible.
**Warning signs:** Schema `.parse()` behaves differently than expected; error message format differs.

### Pitfall 2: TOCTOU Race on Balance Checks
**What goes wrong:** Two concurrent payment requests both read the same balance (both see 1000 msat), both pass policy checks, both write debits — resulting in a negative balance.
**Why it happens:** SQLite's default `DEFERRED` transaction mode doesn't acquire a write lock until the first write statement. The read happens outside the lock.
**How to avoid:** Use `{ behavior: 'immediate' }` on all write transactions. This acquires a reserved lock at `BEGIN IMMEDIATE`, blocking concurrent writers from the read phase onward.
**Warning signs:** Integration tests with concurrent requests show double-spend. Balance goes negative.

### Pitfall 3: Token Stored in Plaintext
**What goes wrong:** `vtk_` tokens stored as plaintext in the DB. DB compromise = all agent tokens compromised.
**Why it happens:** Developer stores the generated token directly for easy lookup.
**How to avoid:** Generate token, hash with `crypto.createHash('sha256')`, store only the hash. Return raw token ONCE in registration response. Lookup is by hash comparison.
**Warning signs:** The `agents` table has a column that starts with `vtk_` values.

### Pitfall 4: Audit Log Written Outside Transaction
**What goes wrong:** Payment succeeds but process crashes before audit write. Event is permanently lost.
**Why it happens:** Developer writes audit log after the `db.transaction()` call returns.
**How to avoid:** Audit log insert MUST be inside the `db.transaction()` block. If audit insert fails, the transaction rolls back and the payment is rejected. Accept this — a payment without an audit trail is worse than a failed payment.
**Warning signs:** Tests show payment succeeds with mocked audit failure.

### Pitfall 5: Bearer Token in Pino HTTP Logs
**What goes wrong:** `pino-http` logs request headers including `Authorization: Bearer vtk_...` in plaintext.
**Why it happens:** `pino-http` by default logs the full request object.
**How to avoid:** Configure Pino with `redact: { paths: ['req.headers.authorization'] }` BEFORE registering `pino-http`. The redact config must be set at logger creation time.
**Warning signs:** Log output shows `"authorization": "Bearer vtk_..."`.

### Pitfall 6: Deposit Endpoint Auth Scope Confusion
**What goes wrong:** The deposit endpoint (`POST /agents/{id}/deposit`) is accessible by agents rather than only the operator.
**Why it happens:** Developer adds the deposit route in the wrong Fastify plugin scope (agent plugin vs admin plugin).
**How to avoid:** Deposit is an operator action (funding an agent's account). It MUST live in the admin-scoped plugin behind `VAULTWARDEN_ADMIN_TOKEN` validation.
**Warning signs:** An agent can increase its own balance by calling the deposit endpoint.

### Pitfall 7: `better-sqlite3` Not Rebuilt After Node.js Version Change
**What goes wrong:** `better-sqlite3` uses native bindings. After changing Node.js version, the prebuilt binary is incompatible.
**Why it happens:** `better-sqlite3` ships N-API bindings compiled for a specific Node.js version.
**How to avoid:** After installing Node.js 24 or switching versions, run `npm rebuild better-sqlite3`. If using Docker, pin Node version in Dockerfile.
**Warning signs:** `Error: The module 'better_sqlite3.node' was compiled against a different Node.js version`.

---

## Code Examples

### Database Client Setup

```typescript
// Source: Drizzle ORM + better-sqlite3 docs
// src/db/client.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const sqlite = new Database(process.env.DATABASE_PATH ?? './vaultwarden.db');
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');

export const db = drizzle({ client: sqlite, schema });
export type Database = typeof db;
```

### Config Validation at Startup

```typescript
// Source: Zod v4 docs + CONTEXT.md env var decisions
// src/config.ts
import { z } from 'zod/v4';

const configSchema = z.object({
  VAULTWARDEN_ADMIN_TOKEN: z.string().min(32),
  DATABASE_PATH: z.string().default('./vaultwarden.db'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export const config = configSchema.parse(process.env);
// Throws at startup with descriptive error if any required env var is missing
```

### Agent Registration Handler

```typescript
// Combines: Zod schema, Drizzle insert, token generation pattern
// routes/admin/agents.routes.ts
app.withTypeProvider<ZodTypeProvider>().route({
  method: 'POST',
  url: '/agents',
  schema: {
    body: z.object({
      name: z.string().min(1).max(100),
      metadata: z.record(z.string()).optional(),
    }),
    response: {
      201: z.object({
        agent_id: z.string(),
        token: z.string(),   // Raw vtk_ token — returned ONCE, never stored
        created_at: z.string().datetime(),
      }),
    },
  },
  handler: async (req, reply) => {
    const rawToken = generateAgentToken();             // `vtk_${ulid()}`
    const tokenHash = hashToken(rawToken);             // sha256 hex
    const agentId = generateAgentId();                 // `ag_${ulid()}`

    await db.insert(agents).values({
      id: agentId,
      name: req.body.name,
      token_hash: tokenHash,
    });

    // Insert default deny-all policy
    await db.insert(policies).values({
      id: generatePolicyId(),
      agent_id: agentId,
      max_transaction_msat: 0,
      daily_limit_msat: 0,
    });

    return reply.code(201).send({
      agent_id: agentId,
      token: rawToken,
      created_at: new Date().toISOString(),
    });
  },
});
```

### In-Memory DB for Vitest Integration Tests

```typescript
// Source: Vitest docs + better-sqlite3 in-memory pattern
// tests/helpers/db.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../src/db/schema';

export function createTestDb() {
  const sqlite = new Database(':memory:');  // In-memory — isolated per test file
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: './src/db/migrations' });
  return db;
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `ln-service` npm package | `lightning` npm package | 2021+ | `ln-service` README redirects TypeScript users to `lightning`. `lightning` has typed async functions for 200+ LND methods. |
| Zod v3 (`import { z } from 'zod'`) | Zod v4 (`import { z } from 'zod/v4'`) | Aug 2025 | 14x faster parsing, 57% smaller bundle. New import path required. |
| `ts-node` for running TypeScript | `tsx` | 2023+ | tsx is ~10x faster startup, uses esbuild internally, no tsconfig dependency |
| Vitest 3.x | Vitest 4.x | Late 2025 | Browser mode graduated stable; core API unchanged for Node.js testing |
| PostgreSQL for Phase 1 dev | SQLite for Phase 1 (PostgreSQL Phase 2+) | Design decision | Eliminates Docker dependency in Phase 1 dev setup; STACK.md explicitly endorses this tradeoff |

**Deprecated/outdated:**
- `pino-noir`: Replaced by Pino's built-in `redact` option (available since Pino 5+). Do not add pino-noir.
- `@fastify/jwt` for static tokens: JWT is for stateless session tokens. Static bearer tokens just need constant-time comparison, not JWT. Skip `@fastify/jwt` in Phase 1.
- TypeORM / Sequelize: Both hide SQL execution and use decorators. Not appropriate for a financial ledger service.

---

## Open Questions

1. **`fastify-type-provider-zod` package name**
   - What we know: There are two packages — `fastify-type-provider-zod` (community, v6.1.0, active) and `@fastify/type-provider-zod` (may not exist as a separate package — STACK.md referenced it but search found only the community version)
   - What's unclear: Whether Fastify officially publishes a scoped version or if the community package is the only one
   - Recommendation: Use `fastify-type-provider-zod` (community package, v6.1.x). Verify peer deps for Zod v4 compatibility before install. Import from `zod/v4`.

2. **Token storage: hash or encrypt?**
   - What we know: Hashing (SHA-256) is standard for API tokens — it's one-way and fast. Encryption would require key management.
   - What's unclear: If the operator ever needs to recover an agent's token, hashing makes this impossible.
   - Recommendation: Use SHA-256 hash. Document clearly that tokens cannot be recovered — only rotated. If token rotation is needed (Phase 4+), design a rotation endpoint.

3. **Cursor pagination field for audit_log**
   - What we know: Cursor pagination works best on a monotonically increasing field. `created_at` (integer ms) is a good candidate but may have collisions at ms precision. ULID PKs are also sortable.
   - What's unclear: Whether to use `created_at` or `id` (ULID) as the cursor field.
   - Recommendation: Use `id` (ULID) as the cursor — ULIDs are time-sortable and guaranteed unique. `WHERE id > cursor ORDER BY id ASC LIMIT 50`.

---

## Sources

### Primary (HIGH confidence)
- [fastify-type-provider-zod v6.1.0 README](https://github.com/turkerdev/fastify-type-provider-zod) — import pattern, route definition, Zod v4 import from `zod/v4`
- [Drizzle ORM Transactions docs](https://orm.drizzle.team/docs/transactions) — `db.transaction({ behavior: 'immediate' })`, nested savepoints, rollback
- [Drizzle ORM SQLite column types docs](https://orm.drizzle.team/docs/column-types/sqlite) — `$defaultFn()`, `timestamp_ms` mode, `text({ mode: 'json' })`
- [Drizzle ORM SQLite get-started docs](https://orm.drizzle.team/docs/get-started-sqlite) — `drizzle({ client: sqlite })` initialization
- [Pino redaction docs](https://github.com/pinojs/pino/blob/main/docs/redaction.md) — `redact.paths`, wildcard `*` syntax, `censor` option
- [better-sqlite3 performance docs](https://wchargin.com/better-sqlite3/performance.html) — WAL mode, `pragma journal_mode = WAL`
- [SQLite WAL mode official docs](https://sqlite.org/wal.html) — concurrent reads/writers, checkpoint behavior
- `.planning/research/STACK.md` — verified stack choices, version numbers, library rationale (HIGH — project research doc)
- `.planning/research/ARCHITECTURE.md` — component dependency graph, build order, data flow patterns (HIGH — project research doc)
- `.planning/phases/01-foundation/01-CONTEXT.md` — locked decisions, discretion areas (HIGH — user decisions)

### Secondary (MEDIUM confidence)
- [Fastify Type Providers docs](https://fastify.dev/docs/latest/Reference/Type-Providers/) — confirmed Zod provider exists, redirects to community package
- [@fastify/bearer-auth README](https://github.com/fastify/fastify-bearer-auth) — constant-time comparison, `onRequest` hook, auth function pattern
- [Fastify Encapsulation docs](https://fastify.dev/docs/latest/Reference/Encapsulation/) — scoped plugin auth hook pattern
- [Fastify Hooks docs](https://fastify.dev/docs/latest/Reference/Hooks/) — `onRequest` vs `preHandler` ordering
- [ulidx GitHub](https://github.com/perry-mitchell/ulidx) — TypeScript-first ULID, `crypto.randomBytes`, monotonic factory
- [SQLite date functions](https://sqlite.org/lang_datefunc.html) — timestamp arithmetic for rolling window query

### Tertiary (LOW confidence)
- WebSearch results on concurrent SQLite write safety — cross-referenced with official SQLite WAL docs, elevated to MEDIUM for WAL claims

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified via official docs and npm registry; versions confirmed
- Architecture: HIGH — patterns directly sourced from verified Drizzle, Fastify, and Pino docs; project architecture doc well-researched
- Pitfalls: MEDIUM-HIGH — most pitfalls derived from official docs + library behavior; TOCTOU pitfall verified against SQLite transaction semantics

**Research date:** 2026-02-26
**Valid until:** 2026-03-28 (30 days — stable ecosystem; Drizzle and Fastify release cadence is predictable)
