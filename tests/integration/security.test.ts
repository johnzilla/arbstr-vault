/**
 * Security and balance isolation tests (Plan 05)
 *
 * Tests:
 * - Pino token redaction: vtk_ tokens and related fields are masked before serialization
 * - Balance isolation: each agent's sub-account is independent (AGNT-02)
 * - Cross-agent access: agents cannot read/modify each other's resources (SEC-06)
 * - Fail-closed: service errors produce DENY, not crashes or HTTP 500s
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'stream';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { loggerConfig } from '../../src/plugins/pino.plugin.js';
import { paymentsService } from '../../src/modules/payments/payments.service.js';
import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_ADMIN_TOKEN = 'test-admin-token-for-integration-tests-only';

process.env.VAULT_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.NODE_ENV = 'test';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function buildTestApp() {
  const { db } = createTestDb();
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
async function pay(app: FastifyInstance, agentId: string, token: string, amount_msat: number) {
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

// ============================================================
// Token Redaction Tests
// ============================================================

describe('Token Redaction', () => {
  it('pino logger redacts top-level token field before serialization', () => {
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    // Build pino with the same redact config (force info level — loggerConfig silences in test)
    const logger = pino(
      {
        level: 'info',
        redact: loggerConfig.redact,
      },
      dest,
    );

    // Log sensitive fields that should be redacted
    logger.info({ token: 'vtk_my_secret_agent_token' }, 'agent token log');
    logger.info({ token_hash: 'sha256hashvalue' }, 'hash log');
    logger.info({ raw_token: 'vtk_raw_token_value' }, 'raw token log');
    logger.info({ req: { headers: { authorization: 'Bearer vtk_header_token' } } }, 'req log');
    logger.info({ nested: { token: 'vtk_nested_secret' } }, 'nested log');

    const allOutput = chunks.join('');

    // No raw vtk_ tokens should appear in log output
    expect(allOutput).not.toContain('vtk_my_secret_agent_token');
    expect(allOutput).not.toContain('vtk_raw_token_value');
    expect(allOutput).not.toContain('vtk_header_token');
    expect(allOutput).not.toContain('vtk_nested_secret');

    // Redaction censor should appear instead
    expect(allOutput).toContain('[REDACTED]');
  });

  it('top-level token field is masked in pino output — verified via parsed JSON', () => {
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const logger = pino({ level: 'info', redact: loggerConfig.redact }, dest);
    logger.info({ token: 'vtk_supersecrettoken' }, 'agent log');

    const line = JSON.parse(chunks[0]!) as { token: string };
    expect(line.token).toBe('[REDACTED]');
  });

  it('nested token field is masked in pino output', () => {
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const logger = pino({ level: 'info', redact: loggerConfig.redact }, dest);
    logger.info({ agent: { token: 'vtk_nested_token' } }, 'nested log');

    const line = JSON.parse(chunks[0]!) as { agent: { token: string } };
    expect(line.agent.token).toBe('[REDACTED]');
  });

  it('error responses do not include token values in response body', async () => {
    const { app } = buildTestApp();
    await app.ready();

    // Make a request with the admin token — response body should not contain it
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'test-agent' },
    });

    const body = JSON.parse(res.body);
    // The agent token is returned once on registration — it should NOT contain the admin token
    expect(JSON.stringify(body)).not.toContain(TEST_ADMIN_TOKEN);
  });

  it('Fastify app built with loggerStream captures redacted token output', async () => {
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const { db } = createTestDb();
    // Build app with custom stream (passes stream to pino); override level to info
    const app = buildApp({ db, loggerStream: dest });
    // Override the silent level set for test env so we can capture output
    app.log.level = 'info';
    await app.ready();

    // Manually log a token field — simulates what happens if code inadvertently logs a token
    app.log.info({ token: 'vtk_should_be_redacted' }, 'manual token log');

    // Small wait for stream flush
    await new Promise<void>((r) => setTimeout(r, 50));

    const allOutput = chunks.join('');
    expect(allOutput).not.toContain('vtk_should_be_redacted');
    expect(allOutput).toContain('[REDACTED]');
  });
});

// ============================================================
// Balance Isolation Tests (AGNT-02)
// ============================================================

describe('Balance Isolation (AGNT-02)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const result = buildTestApp();
    app = result.app;
    await app.ready();
  });

  it('agents have fully independent balances — payment from A does not affect B', async () => {
    const agentA = await registerAgent(app, 'Agent A');
    const agentB = await registerAgent(app, 'Agent B');

    // Deposit 100_000 to A, 50_000 to B
    await deposit(app, agentA.agent_id, 100_000);
    await deposit(app, agentB.agent_id, 50_000);

    // Set policies
    await setPolicy(app, agentA.agent_id, 50_000, 200_000);
    await setPolicy(app, agentB.agent_id, 50_000, 200_000);

    // Agent A pays 10_000
    const payRes = await pay(app, agentA.agent_id, agentA.token, 10_000);
    expect(JSON.parse(payRes.body).policy_decision).toBe('ALLOW');

    // Verify Agent A balance = 90_000
    const balA = await app.inject({
      method: 'GET',
      url: `/agents/${agentA.agent_id}/balance`,
      headers: { authorization: `Bearer ${agentA.token}` },
    });
    expect(JSON.parse(balA.body).balance_msat).toBe(90_000);

    // Verify Agent B balance = 50_000 (unaffected)
    const balB = await app.inject({
      method: 'GET',
      url: `/agents/${agentB.agent_id}/balance`,
      headers: { authorization: `Bearer ${agentB.token}` },
    });
    expect(JSON.parse(balB.body).balance_msat).toBe(50_000);
  });

  it("agent A's payment does not appear in agent B's audit history", async () => {
    const agentA = await registerAgent(app, 'Isolated Agent A');
    const agentB = await registerAgent(app, 'Isolated Agent B');

    await deposit(app, agentA.agent_id, 100_000);
    await setPolicy(app, agentA.agent_id, 50_000, 200_000);

    // Agent A makes a payment
    await pay(app, agentA.agent_id, agentA.token, 10_000);

    // Agent B's history should only contain their own events
    const histB = await app.inject({
      method: 'GET',
      url: `/agents/${agentB.agent_id}/history`,
      headers: { authorization: `Bearer ${agentB.token}` },
    });
    expect(histB.statusCode).toBe(200);
    const bodyB = JSON.parse(histB.body) as {
      entries: Array<{ agent_id: string; action: string }>;
    };

    // No entry in B's history should reference agent A
    for (const entry of bodyB.entries) {
      expect(entry.agent_id).not.toBe(agentA.agent_id);
    }

    // No PAYMENT_REQUEST or PAYMENT_SETTLED should appear in B's history
    const paymentEntries = bodyB.entries.filter(
      (e) => e.action === 'PAYMENT_REQUEST' || e.action === 'PAYMENT_SETTLED',
    );
    expect(paymentEntries).toHaveLength(0);
  });

  it('agent A cannot read agent B balance — returns 403', async () => {
    const agentA = await registerAgent(app, 'Token A');
    const agentB = await registerAgent(app, 'Token B');

    // Agent A tries to read Agent B's balance
    const res = await app.inject({
      method: 'GET',
      url: `/agents/${agentB.agent_id}/balance`,
      headers: { authorization: `Bearer ${agentA.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('forbidden');
  });

  it('agent B cannot read agent A history — returns 403', async () => {
    const agentA = await registerAgent(app, 'History Owner A');
    const agentB = await registerAgent(app, 'Intruder B');

    // Agent B tries to read Agent A's history
    const res = await app.inject({
      method: 'GET',
      url: `/agents/${agentA.agent_id}/history`,
      headers: { authorization: `Bearer ${agentB.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('forbidden');
  });
});

// ============================================================
// Fail-Closed Tests (SEC-06)
// ============================================================

describe('Fail-Closed on Service Errors (SEC-06)', () => {
  it('paymentsService.processPayment returns DENY when database throws', async () => {
    // Set up a proper DB, register an agent, then close the sqlite connection
    // to simulate mid-request DB failure at the payment service level.
    const { db, sqlite } = createTestDb();
    const app = buildApp(db);
    await app.ready();

    const agentRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { name: 'Fail Closed Agent' },
    });
    const { agent_id } = JSON.parse(agentRes.body) as { agent_id: string; token: string };
    await deposit(app, agent_id, 100_000);
    await setPolicy(app, agent_id, 50_000, 200_000);

    // Close the underlying SQLite connection to simulate DB unavailability
    // at the transaction layer. agentAuth uses the DB too, but we call
    // processPayment directly to test the service's own fail-closed behavior.
    sqlite.close();

    // Call the payment service directly — it should catch the DB error and return DENY
    const result = await paymentsService.processPayment(db, agent_id, {
      amount_msat: 1_000,
      asset: 'BTC_simulated',
      purpose: 'fail-closed test',
      destination_type: 'internal',
      destination: 'test-dest',
    });

    // Fail-closed: any DB error produces DENY, never ALLOW
    expect(result.policy_decision).toBe('DENY');
    expect(result.reason).toBe('internal_error');
    expect(result.status).toBe('FAILED');
    // transaction_id is still generated even on failure
    expect(result.transaction_id).toMatch(/^tx_/);
  });
});
