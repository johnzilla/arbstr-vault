/**
 * Policy enforcement on POST /internal/reserve.
 *
 * Reserve runs the same policy engine as /agents/:id/pay (fail-closed):
 * - missing or deny-all policy => 403 policy_denied
 * - amount above max_transaction_msat => 403 (REQUIRE_HUMAN_APPROVAL is a deny here)
 * - settled payments + open reservations + amount above daily_limit_msat => 403
 * - the policy version in effect now applies
 * - every decision writes a PAYMENT_REQUEST audit entry; denials write no RESERVE
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, eq } from 'drizzle-orm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { hashToken } from '../../src/modules/tokens/tokens.service.js';
import { ledgerRepo } from '../../src/modules/ledger/ledger.repo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_INTERNAL_TOKEN = 'test-internal-token-min-32-characters-long';
const TEST_AGENT_TOKEN = 'vtk_test_agent_token_for_reserve_policy';
const AGENT_ID = 'ag_policy';
const STARTING_BALANCE = 1_000_000;

process.env.VAULT_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;

function buildTestApp() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return buildApp(db);
}

describe('POST /internal/reserve policy enforcement', () => {
  let app: ReturnType<typeof buildApp>;
  let version = 0;

  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: { 'x-internal-token': TEST_INTERNAL_TOKEN }, payload });

  const reserve = (amount_msats: number) =>
    post('/internal/reserve', { agent_token: TEST_AGENT_TOKEN, amount_msats, correlation_id: 'corr-p', model: 'gpt-4o' });

  const balance = () => ledgerRepo.getBalance(app.db, AGENT_ID);

  function setPolicy(max_transaction_msat: number, daily_limit_msat: number, approval_timeout_ms: number | null = null) {
    version += 1;
    app.db.insert(schema.policyVersions).values({
      agent_id: AGENT_ID,
      version,
      max_transaction_msat,
      daily_limit_msat,
      approval_timeout_ms,
      // Strictly increasing so the newest version wins getVersionAt
      effective_from: new Date(Date.now() - 1_000 + version),
    }).run();
  }

  function reserveEntries() {
    return app.db.select().from(schema.ledgerEntries)
      .where(and(eq(schema.ledgerEntries.agent_id, AGENT_ID), eq(schema.ledgerEntries.entry_type, 'RESERVE')))
      .all();
  }

  function requestAudits() {
    return app.db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.agent_id, AGENT_ID), eq(schema.auditLog.action, 'PAYMENT_REQUEST')))
      .all();
  }

  beforeEach(async () => {
    version = 0;
    app = buildTestApp();
    await app.ready();
    app.db.insert(schema.agents).values({ id: AGENT_ID, name: 'Policy Agent', token_hash: hashToken(TEST_AGENT_TOKEN) }).run();
    app.db.insert(schema.ledgerEntries).values({
      id: 'tx_policy_deposit', agent_id: AGENT_ID, amount_msat: STARTING_BALANCE, entry_type: 'DEPOSIT', mode: 'simulated',
    }).run();
  });

  afterEach(async () => {
    await app.close();
  });

  it('denies when the agent has no policy', async () => {
    const res = await reserve(1_000);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'policy_denied' }, reason: 'no_policy_configured' });
    expect(reserveEntries()).toHaveLength(0);
    expect(balance()).toBe(STARTING_BALANCE);
  });

  it('denies under the deny-all default policy, even at zero cost', async () => {
    setPolicy(0, 0);
    for (const amount of [1_000, 0]) {
      const res = await reserve(amount);
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe('deny_all_policy');
    }
    expect(reserveEntries()).toHaveLength(0);
  });

  it('allows within limits and audits the ALLOW decision', async () => {
    setPolicy(10_000, 100_000);
    const res = await reserve(10_000); // exactly at max_transaction_msat
    expect(res.statusCode).toBe(200);
    expect(balance()).toBe(STARTING_BALANCE - 10_000);

    const [audit] = requestAudits();
    expect(audit.policy_decision).toBe('ALLOW');
    expect(audit.amount_msat).toBe(10_000);
    expect(audit.ref_id).toBe(res.json().reservation_id);
  });

  it('denies above max_transaction_msat and audits the DENY decision', async () => {
    setPolicy(10_000, 100_000);
    const res = await reserve(10_001);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('exceeds_max_transaction');
    expect(reserveEntries()).toHaveLength(0);

    const [audit] = requestAudits();
    expect(audit.policy_decision).toBe('DENY');
    expect(audit.policy_reason).toBe('exceeds_max_transaction');
  });

  it('treats REQUIRE_HUMAN_APPROVAL as a deny (billing cannot wait for an operator)', async () => {
    setPolicy(10_000, 100_000, 300_000);
    const res = await reserve(20_000);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('exceeds_max_transaction_requires_approval');
    expect(reserveEntries()).toHaveLength(0);
    expect(balance()).toBe(STARTING_BALANCE);
  });

  it('counts settled payments against the daily limit', async () => {
    setPolicy(10_000, 15_000);
    const first = await reserve(10_000);
    await post('/internal/settle', {
      reservation_id: first.json().reservation_id,
      actual_msats: 10_000,
      metadata: { tokens_in: 1, tokens_out: 1, provider: 'p', latency_ms: 1 },
    });

    const res = await reserve(6_000); // 10_000 spent + 6_000 > 15_000
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('exceeds_daily_limit');

    expect((await reserve(5_000)).statusCode).toBe(200); // exactly at the limit
  });

  it('counts open reservations against the daily limit until they are released', async () => {
    setPolicy(10_000, 15_000);
    const open = await reserve(10_000);
    expect(open.statusCode).toBe(200);

    // Concurrent in-flight request: would exceed the limit if both settled in full
    expect((await reserve(6_000)).json().reason).toBe('exceeds_daily_limit');

    await post('/internal/release', { reservation_id: open.json().reservation_id });
    expect((await reserve(6_000)).statusCode).toBe(200);
  });

  it('applies the newest policy version', async () => {
    setPolicy(0, 0);
    expect((await reserve(1_000)).statusCode).toBe(403);

    setPolicy(10_000, 100_000);
    expect((await reserve(1_000)).statusCode).toBe(200);
  });

  it('still returns 402 with balance details when limits allow but funds do not', async () => {
    setPolicy(10_000_000, 10_000_000);
    const res = await reserve(STARTING_BALANCE + 1);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({
      error: { code: 'insufficient_balance' },
      current_balance_msats: STARTING_BALANCE,
      requested_msats: STARTING_BALANCE + 1,
    });
  });
});
