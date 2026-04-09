/**
 * Integration tests for POST /internal/reserve
 *
 * Covers:
 * - Happy path: valid internal token + valid agent => 200 with reservation_id and remaining_balance_msats
 * - Missing X-Internal-Token => 401
 * - Wrong X-Internal-Token => 401
 * - Invalid agent_token => 401 with "Invalid agent token"
 * - Insufficient balance => 402 with current_balance_msats and requested_msats
 * - After successful reserve, balance is reduced
 * - RESERVE ledger entry has negative amount_msat, entry_type 'RESERVE', mode 'simulated'
 * - Missing body fields => 400
 * - amount_msats=0 => 400
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { hashToken } from '../../src/modules/tokens/tokens.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_INTERNAL_TOKEN = 'test-internal-token-min-32-characters-long';
const TEST_ADMIN_TOKEN = 'test-admin-token-for-integration-tests-only';
const TEST_AGENT_TOKEN = 'vtk_test_agent_token_for_billing_reserved';

// Set env before config is parsed
process.env.VAULT_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;
process.env.VAULT_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
process.env.NODE_ENV = 'test';

function buildTestApp() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return buildApp(db);
}

async function setupTestAgent(app: ReturnType<typeof buildApp>) {
  const tokenHash = hashToken(TEST_AGENT_TOKEN);
  app.db.insert(schema.agents).values({
    id: 'ag_test123',
    name: 'Test Agent',
    token_hash: tokenHash,
  }).run();

  // Give agent 100,000 msats balance
  app.db.insert(schema.ledgerEntries).values({
    id: 'tx_deposit_setup',
    agent_id: 'ag_test123',
    amount_msat: 100_000,
    entry_type: 'DEPOSIT',
    mode: 'simulated',
  }).run();
}

describe('POST /internal/reserve', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
    await setupTestAgent(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('Test 1: valid reserve returns 200 with reservation_id and remaining_balance_msats', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: 50_000,
        correlation_id: 'corr_abc123',
        model: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reservation_id: string; remaining_balance_msats: number };
    expect(body.reservation_id).toMatch(/^tx_/);
    expect(body.remaining_balance_msats).toBe(50_000);
  });

  it('Test 2: missing X-Internal-Token returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: 50_000,
        correlation_id: 'corr_abc123',
        model: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('Test 3: wrong X-Internal-Token returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': 'wrong-token-that-is-long-enough-but-wrong' },
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: 50_000,
        correlation_id: 'corr_abc123',
        model: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('Test 4: invalid agent_token returns 401 with "Invalid agent token"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        agent_token: 'vtk_nonexistent_token',
        amount_msats: 50_000,
        correlation_id: 'corr_abc123',
        model: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.message).toBe('Invalid agent token');
  });

  it('Test 5: insufficient balance returns 402 with current_balance_msats and requested_msats', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: 200_000, // more than 100,000 balance
        correlation_id: 'corr_abc123',
        model: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body) as {
      error: { code: string; message: string };
      current_balance_msats: number;
      requested_msats: number;
    };
    expect(body.current_balance_msats).toBe(100_000);
    expect(body.requested_msats).toBe(200_000);
  });

  it('Test 6: after successful reserve, balance is reduced by amount_msats', async () => {
    const RESERVE_AMOUNT = 30_000;

    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: RESERVE_AMOUNT,
        correlation_id: 'corr_balance_check',
        model: 'claude-3-5-sonnet',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reservation_id: string; remaining_balance_msats: number };
    expect(body.remaining_balance_msats).toBe(100_000 - RESERVE_AMOUNT);
  });

  it('Test 7: RESERVE ledger entry has negative amount_msat, entry_type RESERVE, mode simulated', async () => {
    const RESERVE_AMOUNT = 50_000;

    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: RESERVE_AMOUNT,
        correlation_id: 'corr_ledger_check',
        model: 'gpt-4-turbo',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reservation_id: string; remaining_balance_msats: number };

    // Query the ledger entry directly
    const entry = app.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.id, body.reservation_id))
      .get();

    expect(entry).toBeDefined();
    expect(entry!.amount_msat).toBe(-RESERVE_AMOUNT);
    expect(entry!.entry_type).toBe('RESERVE');
    expect(entry!.mode).toBe('simulated');
    expect(entry!.ref_id).toBe('corr_ledger_check');
  });

  it('Test 8: missing body fields returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        // missing agent_token, amount_msats, correlation_id, model
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('Test 9: amount_msats=0 returns 400 (must be positive)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: 0,
        correlation_id: 'corr_zero',
        model: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

// Helper: reserve funds and return reservation_id (module-scoped for reuse)
async function reserveFunds(app: ReturnType<typeof buildApp>, amount: number = 50_000): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/reserve',
    headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
    payload: {
      agent_token: TEST_AGENT_TOKEN,
      amount_msats: amount,
      correlation_id: 'corr_settle_test',
      model: 'gpt-4o',
    },
  });
  return (JSON.parse(res.body) as { reservation_id: string }).reservation_id;
}

describe('POST /internal/settle', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
    await setupTestAgent(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('valid settle returns 200 with settled response', async () => {
    const reservationId = await reserveFunds(app, 50_000);

    const res = await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: reservationId,
        actual_msats: 32_000,
        tokens_in: 100,
        tokens_out: 200,
        provider: 'openai',
        latency_ms: 500,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      settled: boolean;
      refunded_msats: number;
      actual_msats: number;
      remaining_balance_msats: number;
    };
    expect(body.settled).toBe(true);
    expect(body.refunded_msats).toBe(18_000); // 50000 - 32000
    expect(body.actual_msats).toBe(32_000);
    expect(body.remaining_balance_msats).toBe(68_000); // 100000 - 32000
  });

  it('settle inserts RELEASE and PAYMENT ledger entries atomically', async () => {
    const reservationId = await reserveFunds(app, 50_000);

    const res = await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: reservationId,
        actual_msats: 30_000,
        tokens_in: 100,
        tokens_out: 200,
        provider: 'openai',
        latency_ms: 500,
      },
    });

    expect(res.statusCode).toBe(200);

    // Query ledger entries with ref_id = reservation_id
    const entries = app.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.ref_id, reservationId))
      .all();

    const releaseEntry = entries.find((e) => e.entry_type === 'RELEASE');
    const paymentEntry = entries.find((e) => e.entry_type === 'PAYMENT');

    expect(releaseEntry).toBeDefined();
    expect(releaseEntry!.amount_msat).toBe(50_000);
    expect(releaseEntry!.mode).toBe('simulated');

    expect(paymentEntry).toBeDefined();
    expect(paymentEntry!.amount_msat).toBe(-30_000);
    expect(paymentEntry!.mode).toBe('simulated');
  });

  it('settle is idempotent - second settle returns same response', async () => {
    const reservationId = await reserveFunds(app, 50_000);

    // First settle
    await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: reservationId,
        actual_msats: 20_000,
        tokens_in: 100,
        tokens_out: 200,
        provider: 'openai',
        latency_ms: 500,
      },
    });

    // Second settle (idempotent retry)
    const res2 = await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: reservationId,
        actual_msats: 20_000,
        tokens_in: 100,
        tokens_out: 200,
        provider: 'openai',
        latency_ms: 500,
      },
    });

    expect(res2.statusCode).toBe(200);
    const body = JSON.parse(res2.body) as { settled: boolean };
    expect(body.settled).toBe(true);

    // Count RELEASE entries with ref_id = reservation_id — exactly 1
    const releaseEntries = app.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.ref_id, reservationId))
      .all()
      .filter((e) => e.entry_type === 'RELEASE');
    expect(releaseEntries.length).toBe(1);

    // Count PAYMENT entries with ref_id = reservation_id — exactly 1
    const paymentEntries = app.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.ref_id, reservationId))
      .all()
      .filter((e) => e.entry_type === 'PAYMENT');
    expect(paymentEntries.length).toBe(1);
  });

  it('settle records audit metadata', async () => {
    const reservationId = await reserveFunds(app, 50_000);

    await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: reservationId,
        actual_msats: 25_000,
        tokens_in: 150,
        tokens_out: 500,
        provider: 'openai',
        latency_ms: 1200,
      },
    });

    const auditEntry = app.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.ref_id, reservationId))
      .get();

    expect(auditEntry).toBeDefined();
    expect(auditEntry!.action).toBe('PAYMENT_SETTLED');
    const meta = auditEntry!.metadata as { tokens_in: number; tokens_out: number; provider: string; latency_ms: number };
    expect(meta.tokens_in).toBe(150);
    expect(meta.tokens_out).toBe(500);
    expect(meta.provider).toBe('openai');
    expect(meta.latency_ms).toBe(1200);
  });

  it('settle with unknown reservation_id returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: 'tx_nonexistent',
        actual_msats: 10_000,
        tokens_in: 100,
        tokens_out: 200,
        provider: 'openai',
        latency_ms: 500,
      },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('settle with actual cost higher than reserved amount works correctly', async () => {
    const reservationId = await reserveFunds(app, 10_000);

    const res = await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: reservationId,
        actual_msats: 15_000,
        tokens_in: 100,
        tokens_out: 200,
        provider: 'openai',
        latency_ms: 500,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      settled: boolean;
      refunded_msats: number;
      actual_msats: number;
      remaining_balance_msats: number;
    };
    expect(body.settled).toBe(true);
    expect(body.refunded_msats).toBe(-5_000); // 10000 - 15000 = -5000 (overcharge)
    expect(body.remaining_balance_msats).toBe(85_000); // 100000 - 15000
  });

  it('balance after settle reflects actual cost not reserved amount', async () => {
    const reservationId = await reserveFunds(app, 80_000);
    // After reserve: balance = 100000 - 80000 = 20000

    const res = await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: reservationId,
        actual_msats: 30_000,
        tokens_in: 100,
        tokens_out: 200,
        provider: 'openai',
        latency_ms: 500,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { remaining_balance_msats: number };
    // RELEASE +80000, PAYMENT -30000 => net balance = 100000 - 30000 = 70000
    expect(body.remaining_balance_msats).toBe(70_000);
  });
});

describe('POST /internal/release', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
    await setupTestAgent(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('valid release returns 200 with released:true', async () => {
    const reservationId = await reserveFunds(app, 40_000);

    const res = await app.inject({
      method: 'POST',
      url: '/internal/release',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: { reservation_id: reservationId },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { released: boolean };
    expect(body.released).toBe(true);
  });

  it('release restores full reserved amount to balance', async () => {
    // Reserve 60,000 — balance drops to 40,000
    const reservationId = await reserveFunds(app, 60_000);

    await app.inject({
      method: 'POST',
      url: '/internal/release',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: { reservation_id: reservationId },
    });

    // After release, balance should be restored to 100,000
    // Verify by attempting a large reserve that would only succeed if balance is restored
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: 95_000,
        correlation_id: 'corr_balance_restore_check',
        model: 'gpt-4o',
      },
    });

    expect(res.statusCode).toBe(200); // Would be 402 if balance not restored
  });

  it('release is idempotent - second release returns same response', async () => {
    const reservationId = await reserveFunds(app, 30_000);

    // First release
    await app.inject({
      method: 'POST',
      url: '/internal/release',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: { reservation_id: reservationId },
    });

    // Second release (idempotent retry)
    const res2 = await app.inject({
      method: 'POST',
      url: '/internal/release',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: { reservation_id: reservationId },
    });

    expect(res2.statusCode).toBe(200);
    const body = JSON.parse(res2.body) as { released: boolean };
    expect(body.released).toBe(true);

    // Count RELEASE entries with ref_id = reservation_id — exactly 1
    const releaseEntries = app.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.ref_id, reservationId))
      .all()
      .filter((e) => e.entry_type === 'RELEASE');
    expect(releaseEntries.length).toBe(1);
  });

  it('release with unknown reservation_id returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/release',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: { reservation_id: 'tx_nonexistent' },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('release inserts RELEASE ledger entry with correct values', async () => {
    const reservationId = await reserveFunds(app, 45_000);

    await app.inject({
      method: 'POST',
      url: '/internal/release',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: { reservation_id: reservationId },
    });

    const releaseEntry = app.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.ref_id, reservationId))
      .get();

    expect(releaseEntry).toBeDefined();
    expect(releaseEntry!.entry_type).toBe('RELEASE');
    expect(releaseEntry!.amount_msat).toBe(45_000);
    expect(releaseEntry!.mode).toBe('simulated');
  });
});

describe('End-to-end billing flow', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
    await setupTestAgent(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('deposit -> reserve -> settle -> balance reflects actual cost', async () => {
    // Start with agent at 100,000 balance (set up in setupTestAgent)

    // Step a: Reserve 50,000 (remaining: 50,000)
    const reservationId = await reserveFunds(app, 50_000);

    // Step b & c: Settle with actual_msats: 12,000
    const settleRes = await app.inject({
      method: 'POST',
      url: '/internal/settle',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        reservation_id: reservationId,
        actual_msats: 12_000,
        tokens_in: 100,
        tokens_out: 200,
        provider: 'anthropic',
        latency_ms: 800,
      },
    });

    expect(settleRes.statusCode).toBe(200);
    const settleBody = JSON.parse(settleRes.body) as { remaining_balance_msats: number };
    // 100,000 - 12,000 = 88,000
    expect(settleBody.remaining_balance_msats).toBe(88_000);

    // Step d: Reserve again for 85,000 — should succeed (balance is 88,000)
    const reserve2Res = await app.inject({
      method: 'POST',
      url: '/internal/reserve',
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        agent_token: TEST_AGENT_TOKEN,
        amount_msats: 85_000,
        correlation_id: 'corr_second_reserve',
        model: 'claude-3-5-sonnet',
      },
    });

    expect(reserve2Res.statusCode).toBe(200);
    // Step e: remaining_balance_msats should be 3,000 (88,000 - 85,000)
    const reserve2Body = JSON.parse(reserve2Res.body) as { remaining_balance_msats: number };
    expect(reserve2Body.remaining_balance_msats).toBe(3_000);
  });
});
