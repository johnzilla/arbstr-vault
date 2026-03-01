# Phase 4: Operator Experience and Advanced Policy - Research

**Researched:** 2026-02-27
**Domain:** Human approval workflow, policy versioning, webhook notifications, operator dashboard, withdrawal mechanics
**Confidence:** HIGH (codebase is fully readable; patterns are established from Phases 1-3)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Human Approval Workflow
- Webhook callback to a configured operator URL when a payment triggers REQUIRE_HUMAN_APPROVAL; event type `approval_required`
- Operator approves or denies via REST API: POST /operator/approvals/:id/approve or /deny; returns the payment result immediately
- Default timeout: 5 minutes before auto-deny; configurable per-agent in policy (`approval_timeout_ms`)
- RESERVE the payment amount immediately when entering pending state (same RESERVE/RELEASE pattern as Lightning/Cashu); RELEASE on deny or timeout
- Agent's payment request returns `status: 'PENDING_APPROVAL'` with the transaction_id so the agent can poll for resolution

#### Withdrawal Mechanics
- Dedicated endpoint: POST /agents/:id/withdrawals — agent provides a BOLT11 invoice and amount
- Returns a withdrawal_id that enters the approval queue
- Withdrawals always require operator approval (no auto-approve path)
- No separate withdrawal limits — same per-agent max_transaction and daily_limit policy applies; approval is the primary safeguard
- Treasury fulfills approved withdrawals by paying the BOLT11 invoice via LND (reuses existing Lightning payment flow)

#### Notification Delivery
- Single operator webhook URL for all event types: `approval_required`, `balance_alert`, `withdrawal_requested`, `approval_timeout`
- Balance alerts check after each payment settles — if balance is below the configured per-agent floor, fire alert
- Cooldown period: after sending a balance alert for an agent, don't send another for that agent within a configurable cooldown (default 1 hour)
- Webhook failure handling: retry 3x with exponential backoff (1s, 5s, 15s), then log as `webhook_delivery_failed` in audit log; never block the payment flow
- Webhook URL configured in global config: `OPERATOR_WEBHOOK_URL`

#### Operator Dashboard API
- GET /operator/dashboard returns full snapshot per agent: balance, daily spend, daily utilization (% of daily limit), active policy (current version fields), pending approvals count, last payment timestamp, balance alert status (below floor or not)
- Basic filtering: query param `status` (active/all), sort by `balance`, `daily_spend`, or `name` (asc/desc)
- Single API call — no pagination needed for personal-use scale (10-50 agents)

#### Policy Versioning
- Append-only version history: every policy update creates a new version row with `effective_from` timestamp and `version` number
- Current policy = latest version for that agent
- Payment evaluation reads the policy version whose `effective_from` <= request timestamp (PLCY-09)
- Old versions are never deleted
- PATCH /operator/agents/:id/policy updates the policy; new version takes effect immediately (`effective_from = now`)

### Claude's Discretion
- Webhook payload schema and signing/verification
- Approval queue storage schema (new table vs extending audit_log)
- Policy version query optimization
- Dashboard response schema field names
- Timeout checker implementation (interval polling vs event-driven)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PAY-07 | Agent can propose a withdrawal to a master wallet or external address | New `pending_approvals` table; withdrawal entries; POST /agents/:id/withdrawals; operator approve/deny; reuses LND payment flow |
| PLCY-06 | Over-limit transactions route to pending state with operator notification | Modify policy engine to return REQUIRE_HUMAN_APPROVAL when amount > max_transaction; RESERVE + new pending_approvals row; webhook fire |
| PLCY-07 | Pending approvals time out to DENY after configurable interval | Background setInterval checker; reads pending_approvals rows past `expires_at`; writes RELEASE + APPROVAL_TIMEOUT audit + fires webhook |
| PLCY-08 | Policy changes are versioned with effective-from timestamps | New `policy_versions` append-only table; PATCH /operator/agents/:id/policy inserts new row; existing `policies` table becomes a view or is replaced |
| PLCY-09 | Policy evaluation uses the version active at payment request time | Query `policy_versions WHERE effective_from <= request_timestamp ORDER BY effective_from DESC LIMIT 1` inside Phase 1 transaction |
| OBSV-06 | Per-agent configurable balance alert threshold that notifies operator when balance drops below floor | New `alert_floor_msat` + `alert_cooldown_ms` columns on `policies` table (or policy_versions); post-settlement check + webhook |
| OBSV-07 | Operator can view all agents, their balances, recent spend, policy state, and daily utilization via API | GET /operator/dashboard; aggregates per-agent data in a single query set; adminAuth protected |
</phase_requirements>

---

## Summary

Phase 4 closes the loop on the operator control plane. All foundational primitives are already in place: the RESERVE/RELEASE ledger pattern (used identically for Lightning and Cashu), the auditRepo append-only log, the policy engine's `REQUIRE_HUMAN_APPROVAL` outcome type (currently unused), Zod/Fastify schema validation, and the adminAuth middleware. This phase activates those dormant capabilities and adds four new concerns: a pending approvals queue, policy versioning, webhook delivery, and the operator dashboard.

The most architecturally significant change is policy versioning. The current `policies` table has a `unique(agent_id)` constraint — one mutable row per agent. This must be replaced with an append-only `policy_versions` table. The policy engine's `PolicyConfig` interface and `evaluatePolicy()` function are pure and untyped to the DB, so they need no changes — only the data loading layer changes. The payments service Phase 1 transaction currently reads `agentsRepo.getWithPolicy()` which does a live lookup; this call must be replaced with a point-in-time version lookup.

The webhook delivery system must be completely fire-and-forget from Treasury's perspective. The Node.js built-in `fetch` API (available in Node 18+) is sufficient for HTTP POST with a 3-retry exponential backoff. No additional npm packages are needed. Payload signing is at Claude's discretion — HMAC-SHA256 over the JSON body using a shared secret is the standard pattern and is straightforward to implement without new dependencies.

**Primary recommendation:** Build in this order: (1) policy versioning schema + engine change, (2) approval queue + workflow, (3) withdrawal endpoint, (4) webhook delivery, (5) dashboard. The policy versioning change is a prerequisite for the correct behavior of PLCY-09 and must land first since every payment evaluation in Phase 4 depends on it.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| drizzle-orm | ^0.45.1 (installed) | Schema definition, migrations, queries | Already the project ORM; `sqliteTable`, `integer`, `text` for new tables |
| fastify | ^5.7.4 (installed) | Route handlers | All existing routes use Fastify + ZodTypeProvider |
| zod/v4 | ^4.3.6 (installed) | Request/response schema validation | Project uses `zod/v4` subpath import consistently |
| better-sqlite3 | ^12.6.2 (installed) | Synchronous SQLite driver | All transactions are synchronous; required by the payment service architecture |
| ulidx | ^2.4.1 (installed) | ID generation for new rows | All existing IDs use ULID via `ulid()` |
| drizzle-kit | ^0.31.9 (installed) | Migration generation | `npm run db:generate && npm run db:migrate` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node.js `fetch` | built-in (Node 18+) | Webhook HTTP POST | No new dependency needed; project runs on Node 18+ (tsx, ESM) |
| Node.js `crypto` | built-in | HMAC-SHA256 webhook signing | Already used in adminAuth for timingSafeEqual |
| Node.js `setInterval` | built-in | Timeout checker background loop | Simplest implementation; no job queue needed at personal-use scale |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Built-in `fetch` + manual retry | `axios` / `got` | axios/got have retry built in but add a dependency; manual 3-retry with exponential backoff is ~15 lines |
| `setInterval` timeout checker | Bull/BullMQ, node-cron | Job queue adds Redis dependency and operational complexity; setInterval polling every 30s is sufficient for 5-minute timeout windows |
| New `policy_versions` table | Keeping `policies` mutable + audit log reconstruction | Policy version lookup via audit log would require JSON parsing to reconstruct config; a proper versioned table is simpler and queryable |
| Separate `withdrawals` table | Reusing `pending_approvals` for both | Withdrawals and payment approvals have the same lifecycle (pending → approved/denied); a unified `pending_approvals` table with a `type` discriminator is cleaner |

**Installation:** No new npm packages required. All dependencies are already installed.

---

## Architecture Patterns

### Recommended Project Structure

New files needed in Phase 4:

```
src/
├── db/
│   ├── schema.ts                              # ADD: policy_versions, pending_approvals, agent_alert_config tables
│   └── migrations/
│       └── 0003_phase4_operator.sql           # generated by drizzle-kit
├── modules/
│   ├── policy/
│   │   └── policy.engine.ts                   # MODIFY: evaluatePolicy receives PolicyConfig with approval_timeout_ms
│   ├── approvals/
│   │   ├── approvals.repo.ts                  # NEW: CRUD for pending_approvals table
│   │   └── approvals.service.ts               # NEW: createApproval, resolveApproval, expireTimedOut
│   ├── webhook/
│   │   └── webhook.service.ts                 # NEW: sendWebhook with retry, HMAC signing
│   └── payments/
│       └── payments.service.ts                # MODIFY: handle REQUIRE_HUMAN_APPROVAL path
├── routes/
│   ├── admin/
│   │   ├── agents.routes.ts                   # MODIFY: PATCH /operator/agents/:id/policy (versioned)
│   │   ├── approvals.routes.ts                # NEW: POST /operator/approvals/:id/approve|deny
│   │   └── dashboard.routes.ts                # NEW: GET /operator/dashboard
│   └── agent/
│       ├── payments.routes.ts                 # MODIFY: add PENDING_APPROVAL to response status enum
│       └── withdrawals.routes.ts              # NEW: POST /agents/:id/withdrawals
└── app.ts                                     # MODIFY: register new routes
```

### Pattern 1: Policy Versioning — Append-Only Table

**What:** Replace the mutable `policies` table with an append-only `policy_versions` table. Each PATCH creates a new row; the "current" policy is the one with the highest `version` (or `effective_from`) for an agent. Point-in-time reads use `WHERE effective_from <= :request_ts ORDER BY effective_from DESC LIMIT 1`.

**When to use:** Every policy lookup. Payment evaluation in Phase 1 of processPayment must use point-in-time lookup, not current-only.

**Schema:**
```typescript
// src/db/schema.ts addition
export const policyVersions = sqliteTable('policy_versions', {
  id: text('id').primaryKey().$defaultFn(() => `pl_${ulid()}`),
  agent_id: text('agent_id').notNull().references(() => agents.id),
  version: integer('version').notNull(),        // monotonically increasing per agent
  max_transaction_msat: integer('max_transaction_msat').notNull().default(0),
  daily_limit_msat: integer('daily_limit_msat').notNull().default(0),
  max_fee_msat: integer('max_fee_msat').default(1000),
  approval_timeout_ms: integer('approval_timeout_ms').default(300_000), // 5 min default
  alert_floor_msat: integer('alert_floor_msat').default(0),
  alert_cooldown_ms: integer('alert_cooldown_ms').default(3_600_000),   // 1 hour default
  effective_from: integer('effective_from', { mode: 'timestamp_ms' }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date()).notNull(),
});
```

**Point-in-time lookup (PLCY-09):**
```typescript
// Inside Phase 1 IMMEDIATE transaction — requestTimestamp captured before transaction starts
const policy = db
  .select()
  .from(policyVersions)
  .where(
    and(
      eq(policyVersions.agent_id, agentId),
      lte(policyVersions.effective_from, new Date(requestTimestamp)),
    ),
  )
  .orderBy(desc(policyVersions.effective_from))
  .limit(1)
  .get();
```

**Migration note:** The existing `policies` table and its `.unique()` constraint will need to be dropped OR kept as-is with a migration that creates `policy_versions` and backfills existing policies. Backfilling is safer: for each row in `policies`, insert one `policy_versions` row with `version=1` and `effective_from=policies.created_at`.

### Pattern 2: Pending Approvals Queue

**What:** A dedicated `pending_approvals` table tracks both payment-approval requests and withdrawal requests in a single structure. The `type` column discriminates between them.

**Schema:**
```typescript
export const pendingApprovals = sqliteTable('pending_approvals', {
  id: text('id').primaryKey().$defaultFn(() => `apr_${ulid()}`),
  agent_id: text('agent_id').notNull().references(() => agents.id),
  type: text('type', { enum: ['payment', 'withdrawal'] }).notNull(),
  transaction_id: text('transaction_id').notNull(),  // ref_id in ledger/audit
  amount_msat: integer('amount_msat').notNull(),
  destination: text('destination'),                   // BOLT11 for withdrawal
  status: text('status', { enum: ['pending', 'approved', 'denied', 'timed_out'] })
    .notNull().default('pending'),
  expires_at: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  resolved_at: integer('resolved_at', { mode: 'timestamp_ms' }),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date()).notNull(),
});
```

**Lifecycle:**
1. Payment triggers REQUIRE_HUMAN_APPROVAL: RESERVE written (same as Lightning Phase 1.5), `pending_approvals` row inserted, webhook fired, response returns `status: 'PENDING_APPROVAL'`
2. Operator approves: PAYMENT proceeds via wallet, RELEASE removed, PAYMENT_SETTLED audit written, `pending_approvals.status = 'approved'`
3. Operator denies OR timeout: RELEASE written, PAYMENT_FAILED audit written, `pending_approvals.status = 'denied'|'timed_out'`, `approval_timeout` webhook fired

### Pattern 3: REQUIRE_HUMAN_APPROVAL Path in payments.service.ts

**What:** Activate the dormant `REQUIRE_HUMAN_APPROVAL` branch in `processPayment`. Currently the deny path returns immediately on any non-ALLOW outcome; the new path must RESERVE and park the request.

**Current code at denial point:**
```typescript
// Current (Phase 1-3): DENY and REQUIRE_HUMAN_APPROVAL both fall through to this
if (!walletShouldRun) {
  return {
    transaction_id: txId,
    policy_decision: denyOutcome,
    ...
    status: 'FAILED',
  };
}
```

**Required change:**
```typescript
if (denyOutcome === 'REQUIRE_HUMAN_APPROVAL') {
  // Write RESERVE — mirrors Lightning Phase 1.5 pattern
  db.transaction((tx) => {
    const tdb = tx as unknown as Db;
    ledgerRepo.insert(tdb, {
      id: txId,
      agent_id: agentId,
      amount_msat: -request.amount_msat,
      entry_type: 'RESERVE',
      ref_id: txId,
      mode: initialRail !== 'simulated' ? initialRail as 'lightning' | 'cashu' : 'simulated',
    });
  }, { behavior: 'immediate' });

  // Insert pending_approvals row
  const expiresAt = new Date(Date.now() + approvalTimeoutMs);
  approvalsRepo.create(db, { agent_id: agentId, type: 'payment', transaction_id: txId,
    amount_msat: request.amount_msat, destination: request.destination, expires_at: expiresAt });

  // Fire webhook (non-blocking — fire-and-forget)
  webhookService.send({ event: 'approval_required', agent_id: agentId,
    transaction_id: txId, amount_msat: request.amount_msat }).catch(() => {});

  return {
    transaction_id: txId,
    policy_decision: 'REQUIRE_HUMAN_APPROVAL',
    mode: initialRail,
    status: 'PENDING_APPROVAL',
  };
}
```

### Pattern 4: Webhook Service — Fire-and-Forget with Retry

**What:** Async function that POST-sends a JSON payload to `OPERATOR_WEBHOOK_URL`, retries 3x with exponential backoff on failure, then logs `webhook_delivery_failed` to audit log. Never throws or blocks.

```typescript
// src/modules/webhook/webhook.service.ts
import { createHmac } from 'crypto';
import { config } from '../../config.js';
import { auditRepo } from '../audit/audit.repo.js';

async function deliverWithRetry(url: string, payload: string, sig: string): Promise<void> {
  const delays = [1000, 5000, 15000];
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vaultwarden-Signature': sig,
        },
        body: payload,
        signal: AbortSignal.timeout(10_000), // 10s per attempt
      });
      if (res.ok) return;
    } catch { /* network error — retry */ }
    if (attempt < 3) await new Promise(r => setTimeout(r, delays[attempt]));
  }
  throw new Error('webhook_delivery_failed');
}

export const webhookService = {
  async send(event: WebhookEvent, db?: Db): Promise<void> {
    const url = config.OPERATOR_WEBHOOK_URL;
    if (!url) return; // webhook not configured — silently skip
    const payload = JSON.stringify({ ...event, timestamp: Date.now() });
    const sig = config.OPERATOR_WEBHOOK_SECRET
      ? createHmac('sha256', config.OPERATOR_WEBHOOK_SECRET).update(payload).digest('hex')
      : 'unsigned';
    try {
      await deliverWithRetry(url, payload, sig);
    } catch {
      if (db) {
        auditRepo.insert(db, { agent_id: event.agent_id ?? 'system',
          action: 'WEBHOOK_DELIVERY_FAILED', metadata: { event_type: event.event } });
      }
    }
  },
};
```

### Pattern 5: Timeout Checker — setInterval Background Loop

**What:** Spawned in `src/index.ts` after `buildApp()`. Polls `pending_approvals WHERE status='pending' AND expires_at <= now` every 30 seconds, resolves each expired approval to `timed_out`.

```typescript
// src/index.ts addition (after app.listen)
const TIMEOUT_POLL_INTERVAL_MS = 30_000;
setInterval(() => {
  const expired = approvalsRepo.findExpired(db);
  for (const approval of expired) {
    approvalsService.resolveExpired(db, approval); // writes RELEASE + audit + fires webhook
  }
}, TIMEOUT_POLL_INTERVAL_MS);
```

**Key property:** The interval is NOT registered on the Fastify app — it runs in `index.ts` so tests using `buildApp()` without `index.ts` are not affected.

### Pattern 6: Policy Version at PATCH /operator/agents/:id/policy

**What:** The existing `PUT /agents/:id/policy` updates the mutable `policies` table. In Phase 4 this becomes `PATCH /operator/agents/:id/policy` and inserts a new `policy_versions` row instead.

```typescript
// New version in agents.service.ts
updatePolicy(db: DB, agentId: string, policy: PolicyVersionInput): PolicyVersion {
  const existing = policyVersionsRepo.getCurrentVersion(db, agentId);
  const nextVersion = (existing?.version ?? 0) + 1;
  const now = new Date();

  return db.transaction((tx) => {
    const newVersion = policyVersionsRepo.insert(tx, {
      agent_id: agentId,
      version: nextVersion,
      ...policy,
      effective_from: now,
    });

    auditRepo.insert(tx as unknown as Db, {
      agent_id: agentId,
      action: 'POLICY_UPDATED',
      metadata: { version: nextVersion, ...policy },
    });

    return newVersion;
  }, { behavior: 'immediate' });
}
```

### Pattern 7: Operator Dashboard — Aggregated Single Query Set

**What:** GET /operator/dashboard assembles per-agent snapshots in a loop over all agents, calling `ledgerRepo.getBalance()` and `ledgerRepo.getDailySpend()` per agent. At personal-use scale (10-50 agents) this is N+1 queries but remains well under 1ms total for SQLite.

**Alternative for scale:** A single JOIN with GROUP BY across agents + ledger_entries is possible but adds complexity. At 10-50 agents, individual calls are clearer and the overhead is negligible.

```typescript
// Route handler sketch
const agents = agentsRepo.listAll(db);
const snapshots = agents.map(agent => {
  const balance = ledgerRepo.getBalance(db as Db, agent.id);
  const dailySpend = ledgerRepo.getDailySpend(db as Db, agent.id);
  const policy = policyVersionsRepo.getCurrent(db, agent.id);
  const pendingCount = approvalsRepo.countPending(db, agent.id);
  const lastPayment = auditRepo.getLastPayment(db as Db, agent.id);
  const dailyUtilization = policy?.daily_limit_msat
    ? Math.round((dailySpend / policy.daily_limit_msat) * 100)
    : 0;
  const belowFloor = policy?.alert_floor_msat ? balance < policy.alert_floor_msat : false;
  return { agent_id: agent.id, name: agent.name, balance_msat: balance,
    daily_spend_msat: dailySpend, daily_utilization_pct: dailyUtilization,
    pending_approvals_count: pendingCount, policy, last_payment_at: lastPayment?.created_at,
    balance_below_floor: belowFloor };
});
```

### Anti-Patterns to Avoid

- **Blocking the payment flow for webhook delivery:** Webhook delivery MUST be fire-and-forget. `webhookService.send(...).catch(() => {})` — never `await` without catching in the payment path.
- **Using the mutable `policies` table for point-in-time reads:** After policy versioning is in place, any code that reads the old `policies` table for payment evaluation is a bug. The `policies` table should be removed or clearly deprecated once migration is complete.
- **Writing RESERVE and pending_approvals row in separate transactions:** The RESERVE ledger entry and the `pending_approvals` row must be written atomically. If they split, a crash between them leaves the balance reserved with no record of why.
- **Running the timeout checker inside the Fastify app lifecycle:** `setInterval` in `index.ts` only, not in `buildApp()`. Tests that construct a `buildApp()` instance do not want background timers firing.
- **Polling for approval resolution from inside the agent's payment request:** The agent returns `PENDING_APPROVAL` immediately. Resolution is operator-driven via POST /operator/approvals/:id/approve|deny. The agent polls `GET /agents/:id/payments/:tx_id` to check status — the existing payment-status route already handles `RESERVE`-without-settlement as `PENDING`, but it needs a new status `PENDING_APPROVAL` to distinguish from Lightning in-flight pending.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTTP retry with backoff | Custom exponential retry loop from scratch | 15-line helper using `fetch` + `setTimeout` | Simple enough to inline; no library needed at this scale |
| HMAC signing | Custom crypto | Node.js `crypto.createHmac('sha256', secret)` | Already in codebase (adminAuth uses `crypto.timingSafeEqual`) |
| Background job scheduling | cron library or Bull queue | `setInterval` in index.ts | Redis dependency unwarranted for a 30s polling loop |
| Policy version lookup | Manual SQL string | Drizzle `lte()` + `desc()` + `limit(1)` | Drizzle already handles date comparison with SQLite integer timestamps |
| Approval queue | Redis/message broker | SQLite `pending_approvals` table | personal-use scale; synchronous SQLite transactions already handle TOCTOU |

**Key insight:** The entire Phase 4 feature set fits within the existing synchronous SQLite + Fastify architecture. No new infrastructure (Redis, cron, message brokers) is needed.

---

## Common Pitfalls

### Pitfall 1: Policy Engine Receives Wrong Version During Evaluation
**What goes wrong:** `processPayment` reads the current policy (latest version) but the payment request was submitted milliseconds before a policy update. Result: payment is evaluated against the wrong policy version.
**Why it happens:** The policy lookup happens inside an IMMEDIATE transaction, but if it reads the "latest" row without a timestamp bound, a concurrent policy update between the request time and the transaction start will be included.
**How to avoid:** Capture `requestTimestamp = Date.now()` BEFORE opening the Phase 1 transaction. Inside the transaction, query `policy_versions WHERE effective_from <= requestTimestamp`. This is the exact PLCY-09 requirement.
**Warning signs:** Tests where a policy update and a payment happen in the same millisecond produce non-deterministic results.

### Pitfall 2: Forgetting to Handle `PENDING_APPROVAL` in payment-status Route
**What goes wrong:** An agent calls `GET /agents/:id/payments/:tx_id` for a pending-approval payment and gets `PENDING` (because RESERVE exists but no RELEASE/PAYMENT). But the agent can't tell if it's a Lightning in-flight or a human-approval-waiting state.
**Why it happens:** `determinePaymentStatus()` in `payment-status.routes.ts` currently maps `RESERVE-only` to `PENDING`. Pending approvals also produce a RESERVE-only state.
**How to avoid:** Add a check: if `pending_approvals` table has a row for this `transaction_id` with `status='pending'`, return `PENDING_APPROVAL` status from the payment-status route.
**Warning signs:** Agent receives `PENDING` with no payment_hash for a payment that triggered approval.

### Pitfall 3: Approval Timeout Race with Manual Resolution
**What goes wrong:** Operator approves at the same moment the timeout checker fires, producing a double-RELEASE or double-PAYMENT_FAILED.
**Why it happens:** `setInterval` callback and the approve route handler both see `status='pending'` and both try to resolve.
**How to avoid:** Resolve via a single atomic update: `UPDATE pending_approvals SET status=:new WHERE id=:id AND status='pending' RETURNING *`. Only the transaction that claims the row with the CAS update proceeds. Use `{ behavior: 'immediate' }` transaction. If the update returns zero rows, the approval was already resolved — return 409 Conflict from the approve route.
**Warning signs:** Double-RELEASE entries in ledger for a single approval.

### Pitfall 4: Balance Alert Firing in the Payment Flow Before Confirming Settlement
**What goes wrong:** Balance alert fires optimistically, before the payment actually settles, so the operator receives spurious alerts for payments that fail.
**Why it happens:** Alert check runs after the RESERVE debit, not after PAYMENT_SETTLED.
**How to avoid:** Fire the balance alert ONLY in the SETTLED path (Phase 2), after writing PAYMENT_SETTLED audit. Never in the RESERVE phase.
**Warning signs:** Operator webhook receives `balance_alert` events for transactions that later show as FAILED.

### Pitfall 5: Migration Breaks Existing Tests
**What goes wrong:** The old `policies` table (with `.unique()` constraint) co-exists with the new `policy_versions` table. Code that calls `agentsService.updatePolicy()` still writes to `policies` — tests that relied on policy reads from `policies` now get stale data.
**Why it happens:** Partial migration — the schema migration was run but the service-layer code wasn't updated consistently.
**How to avoid:** In the same plan/wave that adds `policy_versions`, update `agentsService.updatePolicy()`, `agentsRepo.getWithPolicy()`, and `processPayment`'s policy read to all use `policy_versions`. Do not leave any code path reading from `policies` for active policy evaluation.
**Warning signs:** Tests pass individually but fail when run together; policy changes don't affect payment decisions in tests.

### Pitfall 6: Withdrawal Policy Check Skipped
**What goes wrong:** POST /agents/:id/withdrawals accepts a BOLT11 invoice and amount but doesn't evaluate the agent's policy (max_transaction_msat, daily_limit_msat). An agent could request a 1 BTC withdrawal and it goes straight to the approval queue without a policy check.
**Why it happens:** Withdrawal is a new code path that bypasses the existing payments.service policy evaluation.
**How to avoid:** Run policy evaluation (same `evaluatePolicy()` call) on the withdrawal amount before creating the pending_approvals row. If the policy returns DENY, return an error immediately. If it returns ALLOW or REQUIRE_HUMAN_APPROVAL, proceed to the approval queue (withdrawals always require human approval per the locked decision).
**Warning signs:** Withdrawals for amounts above max_transaction_msat appear in the approval queue.

---

## Code Examples

Verified patterns from the existing codebase:

### Drizzle point-in-time query (SQLite integer timestamps)
```typescript
// Source: drizzle-orm pattern — lte() with Date object
import { lte, desc, eq, and } from 'drizzle-orm';

const policy = db
  .select()
  .from(policyVersions)
  .where(
    and(
      eq(policyVersions.agent_id, agentId),
      lte(policyVersions.effective_from, new Date(requestTimestamp)),
    ),
  )
  .orderBy(desc(policyVersions.effective_from))
  .limit(1)
  .get();
// Returns null if no version was effective at requestTimestamp
```

### Atomic CAS update for approval resolution
```typescript
// Source: existing drizzle pattern (agents.service.ts updatePolicy)
const claimed = db
  .update(pendingApprovals)
  .set({ status: 'approved', resolved_at: new Date() })
  .where(and(eq(pendingApprovals.id, approvalId), eq(pendingApprovals.status, 'pending')))
  .returning()
  .get(); // returns undefined if no row was updated
if (!claimed) {
  // Already resolved — return 409
}
```

### New route in app.ts (following existing pattern)
```typescript
// Source: src/app.ts pattern
import { adminApprovalsRoutes } from './routes/admin/approvals.routes.js';
import { adminDashboardRoutes } from './routes/admin/dashboard.routes.js';
import { agentWithdrawalRoutes } from './routes/agent/withdrawals.routes.js';
// ...inside buildApp():
app.register(adminApprovalsRoutes);
app.register(adminDashboardRoutes);
app.register(agentWithdrawalRoutes);
```

### Config additions for webhook (zod/v4 pattern)
```typescript
// Source: src/config.ts pattern
OPERATOR_WEBHOOK_URL: z.string().url().optional(),
OPERATOR_WEBHOOK_SECRET: z.string().min(16).optional(),
```

### Audit action enum extension
```typescript
// Source: src/db/schema.ts auditLog table
// Add to action enum:
'APPROVAL_REQUESTED',
'APPROVAL_GRANTED',
'APPROVAL_DENIED',
'APPROVAL_TIMEOUT',
'WITHDRAWAL_REQUESTED',
'WITHDRAWAL_COMPLETED',
'WEBHOOK_DELIVERY_FAILED',
```

### New route prefix pattern for operator routes
```typescript
// Existing admin routes use /agents prefix without /operator
// New operator-specific routes should use /operator prefix for clarity
// POST /operator/approvals/:id/approve
// POST /operator/approvals/:id/deny
// GET  /operator/dashboard
// These use adminAuth (same VAULTWARDEN_ADMIN_TOKEN)
```

### RESERVE write inside approval path (mirrors Phase 1.5 Lightning pattern)
```typescript
// Source: src/modules/payments/payments.service.ts — Phase 1.5 block
db.transaction((tx) => {
  const tdb = tx as unknown as Db;
  ledgerRepo.insert(tdb, {
    id: txId,
    agent_id: agentId,
    amount_msat: -request.amount_msat,
    entry_type: 'RESERVE',
    ref_id: txId,
    mode: 'simulated', // or initialRail if known
  });
  // Write pending_approvals row in SAME transaction
  approvalsRepo.create(tdb as unknown as ApprovalsDb, { ... });
}, { behavior: 'immediate' });
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Mutable `policies` table (1 row per agent) | `policy_versions` append-only table | Phase 4 | Every payment evaluation changes to point-in-time lookup |
| `REQUIRE_HUMAN_APPROVAL` unused in processPayment | Activates pending-approval RESERVE path | Phase 4 | Payments can now pause for operator review |
| No withdrawal path | POST /agents/:id/withdrawals with approval queue | Phase 4 | Agents can propose balance withdrawals |

**Deprecated/outdated after Phase 4:**
- `PUT /agents/:id/policy` (mutable update): Replaced by `PATCH /operator/agents/:id/policy` (versioned insert). The old route should return 410 Gone or redirect after migration.
- Direct reads from `policies` table in `agentsRepo.getWithPolicy()`: This method must be updated to read from `policy_versions` or be renamed to avoid confusion.

---

## Open Questions

1. **Should the old `policies` table be preserved or dropped?**
   - What we know: it has a `unique(agent_id)` constraint and is currently the single source of truth for payment evaluation. Tests use it heavily.
   - What's unclear: migration strategy — can we keep it as a "legacy current policy" view (updated by trigger from `policy_versions`) or should we migrate tests to use `policy_versions` directly?
   - Recommendation: Keep `policies` table intact for now (zero migration risk). Create `policy_versions` as a new table. Backfill existing agents on migration. Update service layer to write to BOTH during a transition period, then remove `policies` reads in a follow-up cleanup.

2. **Where should `alert_floor_msat` and `alert_cooldown_ms` live — on `policy_versions` or as separate `agent_alerts` config?**
   - What we know: CONTEXT.md says "per-agent configurable balance alert threshold"; it's configurable via API.
   - What's unclear: should alert config version with the policy (making it point-in-time) or be a separate mutable setting?
   - Recommendation: Include in `policy_versions` since it's a per-agent config that operators adjust over time. This avoids a separate table while enabling historical insight into what the alert threshold was at any point.

3. **Should the timeout checker use `db` from the global module or from `app.db`?**
   - What we know: `buildApp()` accepts an injected `db` for test isolation. The global `db` from `src/db/client.ts` is the production instance.
   - What's unclear: how to pass the production `db` to `setInterval` in `index.ts` without coupling.
   - Recommendation: `index.ts` creates `db` by calling `createDb()` before calling `buildApp()`, and the same `db` instance is passed to both `buildApp()` and the `setInterval` callback. Tests that use `buildApp()` with an injected test DB don't run `index.ts`, so they're unaffected.

---

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection — `src/db/schema.ts`, `src/modules/payments/payments.service.ts`, `src/modules/policy/policy.engine.ts`, `src/modules/agents/agents.service.ts`, `src/modules/ledger/ledger.repo.ts`, `src/modules/audit/audit.repo.ts`, `src/app.ts`, `src/config.ts`, all route files
- Existing migrations `0000_redundant_nebula.sql`, `0001_white_whirlwind.sql`, `0002_easy_jetstream.sql` — understand column naming and drizzle-kit output format
- `.planning/phases/04-operator-experience-and-advanced-policy/04-CONTEXT.md` — locked decisions and discretion areas
- `.planning/REQUIREMENTS.md` — requirement definitions for PAY-07, PLCY-06 through PLCY-09, OBSV-06, OBSV-07
- `.planning/STATE.md` — accumulated architectural decisions from Phases 1-3

### Secondary (MEDIUM confidence)
- Node.js built-in `fetch` with `AbortSignal.timeout()` — available in Node 18+ (project uses tsx/ESM which requires Node 18+)
- Drizzle ORM `lte()`, `desc()`, `limit(1)` for point-in-time queries — standard drizzle-orm query builder patterns consistent with existing codebase usage

### Tertiary (LOW confidence)
- None — all findings are derived from direct codebase inspection

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all existing dependencies identified from package.json
- Architecture: HIGH — derived from direct reading of all Phase 1-3 source files; patterns are established and consistent
- Pitfalls: HIGH — derived from direct analysis of existing code paths and their edge cases (e.g., CAS update pattern, timestamp capture timing)

**Research date:** 2026-02-27
**Valid until:** Until codebase changes — internal research, not dependent on external sources
