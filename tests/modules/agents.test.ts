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

// Admin token for tests — must be >= 32 chars (config validation)
const TEST_ADMIN_TOKEN = 'test-admin-token-for-integration-tests-only';

// Override environment before config is evaluated
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

describe('Agent Management API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const result = buildTestApp();
    app = result.app;
    await app.ready();
  });

  // ------------------------------------------------------------------
  // POST /agents — register agent
  // ------------------------------------------------------------------

  it('POST /agents with admin token returns 201 with agent_id and vtk_ token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Test Agent' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.agent_id).toMatch(/^ag_/);
    expect(body.token).toMatch(/^vtk_/);
    expect(body.created_at).toBeDefined();
  });

  it('POST /agents without admin token returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'Test Agent' },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('unauthorized');
  });

  it('POST /agents with wrong admin token returns 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { name: 'Test Agent' },
    });

    expect(response.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------
  // GET /agents/:id — get agent with deny-all policy
  // ------------------------------------------------------------------

  it('GET /agents/:id with admin token returns agent with deny-all policy', async () => {
    // First register an agent
    const registerRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Policy Test Agent' },
    });
    expect(registerRes.statusCode).toBe(201);
    const { agent_id } = JSON.parse(registerRes.body);

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.agent_id).toBe(agent_id);
    expect(body.name).toBe('Policy Test Agent');
    expect(body.policy.max_transaction_msat).toBe(0);
    expect(body.policy.daily_limit_msat).toBe(0);
  });

  // ------------------------------------------------------------------
  // GET /agents/:id/balance — balance check with agent token
  // ------------------------------------------------------------------

  it('GET /agents/:id/balance with agent vtk_ token returns 0 balance', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Balance Test Agent' },
    });
    expect(registerRes.statusCode).toBe(201);
    const { agent_id, token } = JSON.parse(registerRes.body);

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.agent_id).toBe(agent_id);
    expect(body.balance_msat).toBe(0);
    expect(body.asset).toBe('BTC_simulated');
  });

  // ------------------------------------------------------------------
  // POST /agents/:id/deposit — deposit increases balance
  // ------------------------------------------------------------------

  it('POST /agents/:id/deposit with admin token increases balance', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Deposit Test Agent' },
    });
    expect(registerRes.statusCode).toBe(201);
    const { agent_id, token } = JSON.parse(registerRes.body);

    const depositRes = await app.inject({
      method: 'POST',
      url: `/agents/${agent_id}/deposit`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { amount_msat: 100_000 },
    });

    expect(depositRes.statusCode).toBe(200);
    const depositBody = JSON.parse(depositRes.body);
    expect(depositBody.agent_id).toBe(agent_id);
    expect(depositBody.amount_msat).toBe(100_000);
    expect(depositBody.balance_msat).toBe(100_000);
    expect(depositBody.transaction_id).toMatch(/^tx_/);

    // Verify balance via agent endpoint
    const balanceRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(balanceRes.statusCode).toBe(200);
    const balanceBody = JSON.parse(balanceRes.body);
    expect(balanceBody.balance_msat).toBe(100_000);
  });

  it('GET /agents/:id/balance after multiple deposits shows correct total', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Multi-Deposit Agent' },
    });
    const { agent_id, token } = JSON.parse(registerRes.body);

    await app.inject({
      method: 'POST',
      url: `/agents/${agent_id}/deposit`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { amount_msat: 50_000 },
    });

    await app.inject({
      method: 'POST',
      url: `/agents/${agent_id}/deposit`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { amount_msat: 75_000 },
    });

    const balanceRes = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/balance`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(balanceRes.body).balance_msat).toBe(125_000);
  });

  // ------------------------------------------------------------------
  // PUT /agents/:id/policy — update policy
  // ------------------------------------------------------------------

  it('PUT /agents/:id/policy with admin token updates policy', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Policy Update Agent' },
    });
    const { agent_id } = JSON.parse(registerRes.body);

    const policyRes = await app.inject({
      method: 'PUT',
      url: `/agents/${agent_id}/policy`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: {
        max_transaction_msat: 10_000,
        daily_limit_msat: 100_000,
      },
    });

    expect(policyRes.statusCode).toBe(200);
    const body = JSON.parse(policyRes.body);
    expect(body.agent_id).toBe(agent_id);
    expect(body.policy.max_transaction_msat).toBe(10_000);
    expect(body.policy.daily_limit_msat).toBe(100_000);
    expect(body.policy.updated_at).toBeDefined();
  });

  // ------------------------------------------------------------------
  // Cross-agent access — 403 enforcement
  // ------------------------------------------------------------------

  it('Agent cannot access another agent balance — returns 403', async () => {
    // Register agent A
    const agentARes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Agent A' },
    });
    const { agent_id: agentAId, token: agentAToken } = JSON.parse(agentARes.body);

    // Register agent B
    const agentBRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Agent B' },
    });
    const { agent_id: agentBId } = JSON.parse(agentBRes.body);

    // Agent A tries to access Agent B's balance
    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agentBId}/balance`,
      headers: { authorization: `Bearer ${agentAToken}` },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('forbidden');
  });

  // ------------------------------------------------------------------
  // GET /agents/:id/history — audit log
  // ------------------------------------------------------------------

  it('GET /agents/:id/history returns AGENT_REGISTERED entry', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'History Test Agent' },
    });
    expect(registerRes.statusCode).toBe(201);
    const { agent_id, token } = JSON.parse(registerRes.body);

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/history`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.entries.length).toBeGreaterThan(0);
    const registrationEntry = body.entries.find(
      (e: { action: string }) => e.action === 'AGENT_REGISTERED',
    );
    expect(registrationEntry).toBeDefined();
    expect(registrationEntry.agent_id).toBe(agent_id);
  });

  it('GET /agents/:id/history after deposit includes DEPOSIT entry', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'History Deposit Agent' },
    });
    const { agent_id, token } = JSON.parse(registerRes.body);

    await app.inject({
      method: 'POST',
      url: `/agents/${agent_id}/deposit`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { amount_msat: 5_000 },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/agents/${agent_id}/history`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const depositEntry = body.entries.find((e: { action: string }) => e.action === 'DEPOSIT');
    expect(depositEntry).toBeDefined();
    expect(depositEntry.amount_msat).toBe(5_000);
  });
});
