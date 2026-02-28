/**
 * Withdrawals, Balance Alerts, and Dashboard tests (Plan 04-03)
 *
 * Validates:
 * - PAY-07: Agent can propose withdrawal via POST /agents/:id/withdrawals
 * - OBSV-06: Balance alert fires when balance drops below configured floor with cooldown
 * - OBSV-07: GET /operator/dashboard returns complete per-agent snapshot
 * - Withdrawal policy check prevents over-limit withdrawals from entering queue
 * - Dashboard includes all required fields: balance, daily spend, utilization, policy, pending count, last payment, floor alert
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { alertsService } from '../../src/modules/alerts/alerts.service.js';
import type { FastifyInstance } from 'fastify';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type Db = BetterSQLite3Database<Record<string, never>>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_ADMIN_TOKEN = 'test-admin-token-for-integration-tests-only';

process.env.VAULTWARDEN_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.NODE_ENV = 'test';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

function buildTestApp() {
  const db = createTestDb();
  const app = buildApp(db);
  return { app, db };
}

// Helper: register a new agent and return { agent_id, token }
async function registerAgent(app: FastifyInstance, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { agent_id: string; token: string };
}

// Helper: deposit funds for an agent
async function deposit(app: FastifyInstance, agentId: string, amountMsat: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/deposit`,
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload: { amount_msat: amountMsat },
  });
  expect(res.statusCode).toBe(200);
}

// Helper: configure policy with full Phase 4 fields
async function setPolicy(
  app: FastifyInstance,
  agentId: string,
  opts: {
    maxTxMsat: number;
    dailyLimitMsat: number;
    approvalTimeoutMs?: number;
    alertFloorMsat?: number;
    alertCooldownMs?: number;
  },
) {
  const payload: Record<string, number> = {
    max_transaction_msat: opts.maxTxMsat,
    daily_limit_msat: opts.dailyLimitMsat,
  };
  if (opts.approvalTimeoutMs !== undefined) payload.approval_timeout_ms = opts.approvalTimeoutMs;
  if (opts.alertFloorMsat !== undefined) payload.alert_floor_msat = opts.alertFloorMsat;
  if (opts.alertCooldownMs !== undefined) payload.alert_cooldown_ms = opts.alertCooldownMs;

  const res = await app.inject({
    method: 'PATCH',
    url: `/operator/agents/${agentId}/policy`,
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload,
  });
  expect(res.statusCode).toBe(200);
}

// Helper: submit a payment
async function submitPayment(app: FastifyInstance, agentId: string, token: string, amountMsat: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/pay`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      amount_msat: amountMsat,
      asset: 'BTC_simulated',
      purpose: 'test payment',
      destination_type: 'internal',
      destination: 'test-dest',
    },
  });
  return res;
}

// Helper: submit a withdrawal
async function submitWithdrawal(
  app: FastifyInstance,
  agentId: string,
  token: string,
  amountMsat: number,
  destination = 'lnbc100u1ptest...',
) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/withdrawals`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      destination,
      amount_msat: amountMsat,
    },
  });
  return res;
}

// ============================================================================
// Withdrawal tests
// ============================================================================

describe('Withdrawal endpoint (PAY-07)', () => {
  // Test 1: POST /agents/:id/withdrawals with valid BOLT11 returns PENDING_APPROVAL
  it('returns PENDING_APPROVAL for valid withdrawal request', async () => {
    const { app } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'withdrawal-agent-1');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, {
      maxTxMsat: 50_000,
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 300_000,
    });

    const res = await submitWithdrawal(app, agent_id, token, 20_000);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe('PENDING_APPROVAL');
    expect(body.withdrawal_id).toMatch(/^apr_/);
    expect(body.transaction_id).toMatch(/^tx_/);
    expect(body.amount_msat).toBe(20_000);
  });

  // Test 2: Withdrawal exceeding daily_limit_msat is denied immediately
  it('denies withdrawal that exceeds daily_limit_msat before entering queue', async () => {
    const { app } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'withdrawal-agent-2');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, {
      maxTxMsat: 100_000,
      dailyLimitMsat: 10_000, // Daily limit is 10_000
    });

    // Attempt to withdraw 50_000 (exceeds daily_limit_msat=10_000)
    const res = await submitWithdrawal(app, agent_id, token, 50_000);
    expect(res.statusCode).toBe(400);

    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('exceeds_daily_limit');
  });

  // Test 3: Withdrawal with deny-all default policy is denied
  it('denies withdrawal when agent has deny-all policy (default after registration)', async () => {
    const { app } = buildTestApp();
    await app.ready();

    // Register agent — agents start with deny-all policy (max_transaction_msat=0, daily_limit_msat=0)
    const { agent_id, token } = await registerAgent(app, 'withdrawal-agent-3-denyall');
    await deposit(app, agent_id, 100_000);

    // Do NOT update policy — the default deny-all policy should reject the withdrawal
    const res = await submitWithdrawal(app, agent_id, token, 20_000);
    expect(res.statusCode).toBe(400);

    const body = JSON.parse(res.body);
    // deny_all_policy: both limits are 0
    expect(body.error.code).toBe('deny_all_policy');
  });

  // Test 4: Withdrawal RESERVE debits balance
  it('RESERVE entry debits balance immediately after withdrawal submission', async () => {
    const { app } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'withdrawal-agent-4');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, {
      maxTxMsat: 50_000,
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 300_000,
    });

    // Submit withdrawal of 30_000
    const withdrawRes = await submitWithdrawal(app, agent_id, token, 30_000);
    expect(withdrawRes.statusCode).toBe(200);

    // Check balance — should be reduced by the withdrawal amount (RESERVE)
    const balRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(balRes.statusCode).toBe(200);
    const balBody = JSON.parse(balRes.body);
    expect(balBody.balance_msat).toBe(70_000); // 100_000 - 30_000
  });
});

// ============================================================================
// Balance alert tests
// ============================================================================

describe('Balance alert service (OBSV-06)', () => {
  beforeEach(() => {
    // Reset cooldowns between tests to prevent interference
    alertsService._resetCooldowns();
  });

  // Test 5: Payment that drops balance below alert_floor fires alert
  it('fires BALANCE_ALERT audit entry when payment drops balance below alert_floor', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'alert-agent-5');
    await deposit(app, agent_id, 50_000);
    await setPolicy(app, agent_id, {
      maxTxMsat: 50_000,
      dailyLimitMsat: 100_000,
      alertFloorMsat: 30_000, // Alert when balance drops below 30_000
      alertCooldownMs: 60_000,  // Minimum cooldown allowed by API validation (60_000 ms)
    });

    // Make a payment of 25_000 (balance goes from 50_000 to 25_000, below floor of 30_000)
    const payRes = await submitPayment(app, agent_id, token, 25_000);
    expect(payRes.statusCode).toBe(200);
    expect(JSON.parse(payRes.body).status).toBe('SETTLED');

    // Give the fire-and-forget alert a moment to resolve (it's synchronous in test context)
    await new Promise(r => setTimeout(r, 50));

    // Verify BALANCE_ALERT audit entry exists
    const narrowDb = db as unknown as Db;
    const { auditLog } = await import('../../src/db/schema.js');
    const { eq, and } = await import('drizzle-orm');
    const alerts = db.select().from(auditLog).where(
      and(
        eq(auditLog.agent_id, agent_id),
        eq(auditLog.action, 'BALANCE_ALERT'),
      ),
    ).all();

    expect(alerts.length).toBe(1);
    const alertEntry = alerts[0];
    expect(alertEntry.metadata).toBeTruthy();
    const metadata = alertEntry.metadata as Record<string, unknown>;
    expect(metadata.balance_msat).toBe(25_000);
    expect(metadata.alert_floor_msat).toBe(30_000);
  });

  // Test 6: Cooldown prevents duplicate alerts
  it('cooldown prevents duplicate BALANCE_ALERT within cooldown period', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'alert-agent-6');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, {
      maxTxMsat: 50_000,
      dailyLimitMsat: 100_000,
      alertFloorMsat: 80_000, // Alert floor is very high — any payment triggers it
      alertCooldownMs: 60_000_000, // Very long cooldown (60_000 seconds)
    });

    // First payment — should trigger alert (balance drops below 80_000)
    await submitPayment(app, agent_id, token, 25_000); // balance -> 75_000
    await new Promise(r => setTimeout(r, 50));

    // Second payment — cooldown prevents second alert
    await submitPayment(app, agent_id, token, 1_000); // balance -> 74_000
    await new Promise(r => setTimeout(r, 50));

    // Verify only ONE alert was fired
    const { auditLog } = await import('../../src/db/schema.js');
    const { eq, and } = await import('drizzle-orm');
    const alerts = db.select().from(auditLog).where(
      and(
        eq(auditLog.agent_id, agent_id),
        eq(auditLog.action, 'BALANCE_ALERT'),
      ),
    ).all();

    expect(alerts.length).toBe(1);

    // Reset cooldowns and make another payment — new alert should fire
    alertsService._resetCooldowns();
    await submitPayment(app, agent_id, token, 1_000); // balance -> 73_000
    await new Promise(r => setTimeout(r, 50));

    const alertsAfterReset = db.select().from(auditLog).where(
      and(
        eq(auditLog.agent_id, agent_id),
        eq(auditLog.action, 'BALANCE_ALERT'),
      ),
    ).all();

    expect(alertsAfterReset.length).toBe(2);
  });

  // Test 7: No alert when balance stays above floor
  it('does not fire BALANCE_ALERT when balance stays above floor', async () => {
    const { app, db } = buildTestApp();
    await app.ready();

    const { agent_id, token } = await registerAgent(app, 'alert-agent-7');
    await deposit(app, agent_id, 50_000);
    await setPolicy(app, agent_id, {
      maxTxMsat: 50_000,
      dailyLimitMsat: 100_000,
      alertFloorMsat: 10_000, // Low floor — balance stays well above
      alertCooldownMs: 3_600_000,
    });

    // Make a small payment (balance 50_000 - 5_000 = 45_000 — above floor of 10_000)
    await submitPayment(app, agent_id, token, 5_000);
    await new Promise(r => setTimeout(r, 50));

    // Verify NO BALANCE_ALERT entry
    const { auditLog } = await import('../../src/db/schema.js');
    const { eq, and } = await import('drizzle-orm');
    const alerts = db.select().from(auditLog).where(
      and(
        eq(auditLog.agent_id, agent_id),
        eq(auditLog.action, 'BALANCE_ALERT'),
      ),
    ).all();

    expect(alerts.length).toBe(0);
  });
});

// ============================================================================
// Dashboard tests
// ============================================================================

describe('Operator dashboard (OBSV-07)', () => {
  // Test 8: GET /operator/dashboard returns per-agent snapshot
  it('returns per-agent snapshot with all required fields', async () => {
    const { app } = buildTestApp();
    await app.ready();

    // Register 2 agents with different configurations
    const { agent_id: agent1Id, token: token1 } = await registerAgent(app, 'dashboard-agent-A');
    const { agent_id: agent2Id, token: _token2 } = await registerAgent(app, 'dashboard-agent-B');

    await deposit(app, agent1Id, 100_000);
    await deposit(app, agent2Id, 50_000);

    await setPolicy(app, agent1Id, {
      maxTxMsat: 20_000,
      dailyLimitMsat: 80_000,
      alertFloorMsat: 30_000,
    });
    await setPolicy(app, agent2Id, {
      maxTxMsat: 10_000,
      dailyLimitMsat: 40_000,
    });

    // Make a payment for agent1 (so last_payment_at is populated)
    await submitPayment(app, agent1Id, token1, 10_000);

    const res = await app.inject({
      method: 'GET',
      url: '/operator/dashboard',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.total_agents).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.agents)).toBe(true);

    const snap1 = body.agents.find((a: any) => a.agent_id === agent1Id);
    expect(snap1).toBeDefined();
    expect(snap1.balance_msat).toBe(90_000); // 100_000 - 10_000
    expect(snap1.daily_spend_msat).toBe(10_000);
    expect(snap1.daily_utilization_pct).toBe(13); // Math.round(10_000 / 80_000 * 100) = 12.5 -> rounds to 13
    expect(snap1.pending_approvals_count).toBe(0);
    expect(snap1.policy).toBeTruthy();
    expect(snap1.policy.max_transaction_msat).toBe(20_000);
    expect(snap1.policy.alert_floor_msat).toBe(30_000);
    expect(snap1.last_payment_at).toBeTruthy(); // Made a payment
    expect(snap1.balance_below_floor).toBe(false); // 90_000 > 30_000
    expect(snap1.created_at).toBeTruthy();

    const snap2 = body.agents.find((a: any) => a.agent_id === agent2Id);
    expect(snap2).toBeDefined();
    expect(snap2.balance_msat).toBe(50_000);
    expect(snap2.last_payment_at).toBeNull(); // No payments
  });

  // Test 9: Dashboard includes pending approvals count
  it('dashboard includes pending_approvals_count per agent', async () => {
    const { app } = buildTestApp();
    await app.ready();

    const { agent_id: agent1Id, token: token1 } = await registerAgent(app, 'approval-dash-agent-1');
    const { agent_id: agent2Id } = await registerAgent(app, 'approval-dash-agent-2');

    await deposit(app, agent1Id, 100_000);
    await setPolicy(app, agent1Id, {
      maxTxMsat: 5_000,          // Low limit triggers REQUIRE_HUMAN_APPROVAL
      dailyLimitMsat: 100_000,
      approvalTimeoutMs: 300_000,
    });
    await setPolicy(app, agent2Id, {
      maxTxMsat: 50_000,
      dailyLimitMsat: 100_000,
    });

    // Submit over-limit payment (triggers REQUIRE_HUMAN_APPROVAL -> creates pending approval)
    const payRes = await submitPayment(app, agent1Id, token1, 10_000);
    expect(JSON.parse(payRes.body).status).toBe('PENDING_APPROVAL');

    const dashRes = await app.inject({
      method: 'GET',
      url: '/operator/dashboard',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(dashRes.statusCode).toBe(200);

    const body = JSON.parse(dashRes.body);
    const snap1 = body.agents.find((a: any) => a.agent_id === agent1Id);
    const snap2 = body.agents.find((a: any) => a.agent_id === agent2Id);

    expect(snap1.pending_approvals_count).toBe(1);
    expect(snap2.pending_approvals_count).toBe(0);
    expect(body.total_pending_approvals).toBeGreaterThanOrEqual(1);
  });

  // Test 10: Dashboard sorting works
  it('dashboard supports sort_by=balance&sort_order=desc', async () => {
    const { app } = buildTestApp();
    await app.ready();

    const { agent_id: agent1Id } = await registerAgent(app, 'sort-agent-low');
    const { agent_id: agent2Id } = await registerAgent(app, 'sort-agent-high');

    // agent1 gets 20_000, agent2 gets 80_000
    await deposit(app, agent1Id, 20_000);
    await deposit(app, agent2Id, 80_000);

    const res = await app.inject({
      method: 'GET',
      url: '/operator/dashboard?sort_by=balance&sort_order=desc',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    const snapAgents = body.agents.filter(
      (a: any) => a.agent_id === agent1Id || a.agent_id === agent2Id,
    );
    expect(snapAgents.length).toBe(2);

    // First (highest balance) should be agent2 with 80_000
    const firstIdx = snapAgents.findIndex((a: any) => a.agent_id === agent2Id);
    const secondIdx = snapAgents.findIndex((a: any) => a.agent_id === agent1Id);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  // Test 11: Dashboard reports balance_below_floor correctly
  it('dashboard reports balance_below_floor correctly', async () => {
    const { app } = buildTestApp();
    await app.ready();

    const { agent_id: agentAboveId } = await registerAgent(app, 'floor-agent-above');
    const { agent_id: agentBelowId } = await registerAgent(app, 'floor-agent-below');

    // Agent above: balance 80_000, floor 50_000 -> above floor
    await deposit(app, agentAboveId, 80_000);
    await setPolicy(app, agentAboveId, {
      maxTxMsat: 100_000,
      dailyLimitMsat: 200_000,
      alertFloorMsat: 50_000,
    });

    // Agent below: balance 20_000, floor 50_000 -> below floor
    await deposit(app, agentBelowId, 20_000);
    await setPolicy(app, agentBelowId, {
      maxTxMsat: 100_000,
      dailyLimitMsat: 200_000,
      alertFloorMsat: 50_000,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/operator/dashboard',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    const snapAbove = body.agents.find((a: any) => a.agent_id === agentAboveId);
    const snapBelow = body.agents.find((a: any) => a.agent_id === agentBelowId);

    expect(snapAbove.balance_below_floor).toBe(false); // 80_000 >= 50_000
    expect(snapBelow.balance_below_floor).toBe(true);  // 20_000 < 50_000
  });
});
