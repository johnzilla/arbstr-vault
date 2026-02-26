import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

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
async function deposit(app: FastifyInstance, agentId: string, amount_msat: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/deposit`,
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload: { amount_msat },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

// Helper: set policy for an agent
async function setPolicy(
  app: FastifyInstance,
  agentId: string,
  max_transaction_msat: number,
  daily_limit_msat: number,
) {
  const res = await app.inject({
    method: 'PUT',
    url: `/agents/${agentId}/policy`,
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    payload: { max_transaction_msat, daily_limit_msat },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

// Helper: submit a payment
async function pay(
  app: FastifyInstance,
  agentId: string,
  token: string,
  amount_msat: number,
) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/pay`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      amount_msat,
      asset: 'BTC_simulated',
      purpose: 'Test payment',
      destination_type: 'internal',
      destination: 'test-destination',
    },
  });
  return res;
}

describe('Payment API — end-to-end integration tests', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const result = buildTestApp();
    app = result.app;
    await app.ready();
  });

  // ------------------------------------------------------------------
  // a. Happy path — payment allowed
  // ------------------------------------------------------------------

  it('a. happy path — ALLOW returns SETTLED with tx_ id', async () => {
    const { agent_id, token } = await registerAgent(app, 'Happy Agent');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, 50_000, 200_000);

    const res = await pay(app, agent_id, token, 10_000);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy_decision).toBe('ALLOW');
    expect(body.mode).toBe('simulated');
    expect(body.status).toBe('SETTLED');
    expect(body.transaction_id).toMatch(/^tx_/);
  });

  // ------------------------------------------------------------------
  // b. Balance reduced after payment
  // ------------------------------------------------------------------

  it('b. balance decreases by payment amount after ALLOW', async () => {
    const { agent_id, token } = await registerAgent(app, 'Balance Agent');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, 50_000, 200_000);

    await pay(app, agent_id, token, 10_000);

    const balanceRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(balanceRes.statusCode).toBe(200);
    const body = JSON.parse(balanceRes.body);
    expect(body.balance_msat).toBe(90_000);
  });

  // ------------------------------------------------------------------
  // c. Policy deny — exceeds max transaction
  // ------------------------------------------------------------------

  it('c. DENY when amount exceeds max_transaction_msat', async () => {
    const { agent_id, token } = await registerAgent(app, 'MaxTx Agent');
    await deposit(app, agent_id, 200_000);
    await setPolicy(app, agent_id, 50_000, 200_000);

    const res = await pay(app, agent_id, token, 60_000);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy_decision).toBe('DENY');
    expect(body.reason).toBe('exceeds_max_transaction');
  });

  // ------------------------------------------------------------------
  // d. Policy deny — exceeds daily limit
  // ------------------------------------------------------------------

  it('d. DENY when cumulative payments exceed daily_limit_msat', async () => {
    const { agent_id, token } = await registerAgent(app, 'Daily Limit Agent');
    await deposit(app, agent_id, 500_000);
    // Policy: max 50_000 per tx, 100_000 per day
    await setPolicy(app, agent_id, 50_000, 100_000);

    // Make two payments totalling 90_000 (within daily limit)
    await pay(app, agent_id, token, 50_000);
    await pay(app, agent_id, token, 40_000);

    // Third payment would push over daily limit (90_000 + 20_000 = 110_000 > 100_000)
    const res = await pay(app, agent_id, token, 20_000);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy_decision).toBe('DENY');
    expect(body.reason).toBe('exceeds_daily_limit');
  });

  // ------------------------------------------------------------------
  // e. Policy deny — insufficient balance
  // ------------------------------------------------------------------

  it('e. DENY when balance insufficient', async () => {
    const { agent_id, token } = await registerAgent(app, 'Poor Agent');
    await deposit(app, agent_id, 1_000);
    // Large policy limits — balance is the constraint
    await setPolicy(app, agent_id, 100_000, 1_000_000);

    const res = await pay(app, agent_id, token, 5_000);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy_decision).toBe('DENY');
    expect(body.reason).toBe('insufficient_balance');
  });

  // ------------------------------------------------------------------
  // f. Policy deny — no policy configured (deny-all default)
  // ------------------------------------------------------------------

  it('f. DENY when no policy configured (deny-all default)', async () => {
    // Register agent — default policy is deny-all (max_transaction: 0, daily_limit: 0)
    const { agent_id, token } = await registerAgent(app, 'No Policy Agent');
    await deposit(app, agent_id, 100_000);
    // Do NOT call setPolicy — use the deny-all default

    const res = await pay(app, agent_id, token, 1_000);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.policy_decision).toBe('DENY');
    expect(body.reason).toBe('deny_all_policy');
  });

  // ------------------------------------------------------------------
  // g. Audit trail — DENY still produces an audit entry
  // ------------------------------------------------------------------

  it('g. DENY payment still produces PAYMENT_REQUEST audit entry', async () => {
    const { agent_id, token } = await registerAgent(app, 'Audit Deny Agent');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, 50_000, 200_000);

    // Make a payment that exceeds max_transaction
    await pay(app, agent_id, token, 60_000);

    const historyRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/history?action_type=PAYMENT_REQUEST`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.statusCode).toBe(200);
    const body = JSON.parse(historyRes.body);
    const deniedEntry = body.entries.find(
      (e: { policy_decision: string }) => e.policy_decision === 'DENY',
    );
    expect(deniedEntry).toBeDefined();
    expect(deniedEntry.action).toBe('PAYMENT_REQUEST');
    expect(deniedEntry.policy_decision).toBe('DENY');
  });

  // ------------------------------------------------------------------
  // h. Audit trail — ALLOW produces two entries
  // ------------------------------------------------------------------

  it('h. ALLOW payment produces PAYMENT_REQUEST and PAYMENT_SETTLED audit entries', async () => {
    const { agent_id, token } = await registerAgent(app, 'Audit Allow Agent');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, 50_000, 200_000);

    await pay(app, agent_id, token, 10_000);

    const historyRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/history`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.statusCode).toBe(200);
    const body = JSON.parse(historyRes.body);

    const paymentRequest = body.entries.find(
      (e: { action: string }) => e.action === 'PAYMENT_REQUEST',
    );
    const paymentSettled = body.entries.find(
      (e: { action: string }) => e.action === 'PAYMENT_SETTLED',
    );

    expect(paymentRequest).toBeDefined();
    expect(paymentRequest.policy_decision).toBe('ALLOW');
    expect(paymentSettled).toBeDefined();
    expect(paymentSettled.ref_id).toMatch(/^tx_/);
  });

  // ------------------------------------------------------------------
  // i. Auth — wrong agent token returns 401
  // ------------------------------------------------------------------

  it('i. invalid vtk_ token returns 401', async () => {
    const { agent_id } = await registerAgent(app, 'Auth Test Agent');
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, 50_000, 200_000);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agent_id}/pay`,
      headers: { authorization: 'Bearer vtk_invalid_token_xyz' },
      payload: {
        amount_msat: 1_000,
        asset: 'BTC_simulated',
        purpose: 'test',
        destination_type: 'internal',
        destination: 'test-dest',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------
  // j. Auth — agent cannot pay from another agent's account
  // ------------------------------------------------------------------

  it('j. agent cannot make payment from another agent account — returns 403', async () => {
    const agentA = await registerAgent(app, 'Agent A');
    const agentB = await registerAgent(app, 'Agent B');
    await deposit(app, agentB.agent_id, 100_000);
    await setPolicy(app, agentB.agent_id, 50_000, 200_000);

    // Agent A tries to pay from Agent B's account
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentB.agent_id}/pay`,
      headers: { authorization: `Bearer ${agentA.token}` },
      payload: {
        amount_msat: 1_000,
        asset: 'BTC_simulated',
        purpose: 'test',
        destination_type: 'internal',
        destination: 'test-dest',
      },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('forbidden');
  });

  // ------------------------------------------------------------------
  // k. Validation — Zod rejects invalid body
  // ------------------------------------------------------------------

  it('k. missing amount_msat returns 400', async () => {
    const { agent_id, token } = await registerAgent(app, 'Validation Agent');

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agent_id}/pay`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        // amount_msat intentionally missing
        asset: 'BTC_simulated',
        purpose: 'test',
        destination_type: 'internal',
        destination: 'test-dest',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ------------------------------------------------------------------
  // l. Audit filterable by time range
  // ------------------------------------------------------------------

  it('l. audit history filterable by start_date and end_date', async () => {
    const { agent_id, token } = await registerAgent(app, 'Time Filter Agent');
    await deposit(app, agent_id, 200_000);
    await setPolicy(app, agent_id, 50_000, 200_000);

    const before = Date.now();
    await pay(app, agent_id, token, 10_000);
    const after = Date.now();

    // Query with time range that includes the payment
    const historyRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/history?start_date=${before - 1}&end_date=${after + 1000}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.statusCode).toBe(200);
    const body = JSON.parse(historyRes.body);
    // Should include entries from the payment
    expect(body.entries.length).toBeGreaterThan(0);

    // Query with time range that excludes everything (far future)
    const emptyRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/history?start_date=${after + 1_000_000}&end_date=${after + 2_000_000}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(emptyRes.statusCode).toBe(200);
    const emptyBody = JSON.parse(emptyRes.body);
    expect(emptyBody.entries.length).toBe(0);
  });
});
