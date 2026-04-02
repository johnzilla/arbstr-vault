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
process.env.VAULTWARDEN_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
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
