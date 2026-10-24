/**
 * Stale billing reservation sweeper (reservationsService.expireStale).
 *
 * - Releases internal-billing reservations still open after the TTL
 * - Leaves young, settled and released reservations alone
 * - Never touches reservations from /pay approvals, withdrawals or Lightning
 * - A late settle from core after expiry is refused with 409 and moves no funds
 * - Releasing a stale reservation frees the agent's daily limit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { hashToken } from '../../src/modules/tokens/tokens.service.js';
import { ledgerRepo } from '../../src/modules/ledger/ledger.repo.js';
import { reservationsService } from '../../src/modules/billing/reservations.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_INTERNAL_TOKEN = 'test-internal-token-min-32-characters-long';
const TEST_AGENT_TOKEN = 'vtk_test_agent_token_for_sweeper';
const AGENT_ID = 'ag_sweeper';
const STARTING_BALANCE = 1_000_000;
const TTL_MS = 900_000;

process.env.VAULT_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;

type Db = BetterSQLite3Database<Record<string, never>>;

function buildTestApp() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return buildApp(db);
}

describe('stale billing reservation sweeper', () => {
  let app: ReturnType<typeof buildApp>;

  const db = () => app.db as unknown as Db;
  const balance = () => ledgerRepo.getBalance(db(), AGENT_ID);
  const sweep = (ageMs: number) => reservationsService.expireStale(db(), TTL_MS, Date.now() + ageMs);

  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: { 'x-internal-token': TEST_INTERNAL_TOKEN }, payload });

  async function reserve(amount_msats: number): Promise<string> {
    const res = await post('/internal/reserve', {
      agent_token: TEST_AGENT_TOKEN, amount_msats, correlation_id: 'corr-sweep', model: 'gpt-4o',
    });
    expect(res.statusCode).toBe(200);
    return res.json().reservation_id as string;
  }

  const settle = (reservation_id: string, actual_msats: number) =>
    post('/internal/settle', {
      reservation_id, actual_msats, metadata: { tokens_in: 1, tokens_out: 1, provider: 'p', latency_ms: 1 },
    });

  function entriesFor(ref: string, entry_type: 'RELEASE' | 'PAYMENT') {
    return app.db.select().from(schema.ledgerEntries)
      .where(and(eq(schema.ledgerEntries.ref_id, ref), eq(schema.ledgerEntries.entry_type, entry_type)))
      .all();
  }

  function setDailyLimit(daily_limit_msat: number) {
    app.db.insert(schema.policyVersions).values({
      agent_id: AGENT_ID, version: 2, max_transaction_msat: 100_000, daily_limit_msat, effective_from: new Date(Date.now() - 1),
    }).run();
  }

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
    app.db.insert(schema.agents).values({ id: AGENT_ID, name: 'Sweeper Agent', token_hash: hashToken(TEST_AGENT_TOKEN) }).run();
    app.db.insert(schema.policyVersions).values({
      agent_id: AGENT_ID, version: 1, max_transaction_msat: 100_000, daily_limit_msat: 10_000_000, effective_from: new Date(0),
    }).run();
    app.db.insert(schema.ledgerEntries).values({
      id: 'tx_sweep_deposit', agent_id: AGENT_ID, amount_msat: STARTING_BALANCE, entry_type: 'DEPOSIT', mode: 'simulated',
    }).run();
  });

  afterEach(async () => {
    await app.close();
  });

  it('releases an open billing reservation older than the TTL and audits it', async () => {
    const rid = await reserve(25_000);
    expect(balance()).toBe(STARTING_BALANCE - 25_000);

    const expired = sweep(TTL_MS + 1_000);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ reservation_id: rid, agent_id: AGENT_ID, amount_msat: 25_000 });
    expect(balance()).toBe(STARTING_BALANCE);

    const [release] = entriesFor(rid, 'RELEASE');
    expect(release.amount_msat).toBe(25_000);

    const audit = app.db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.ref_id, rid), eq(schema.auditLog.action, 'RESERVATION_EXPIRED')))
      .get();
    expect(audit?.amount_msat).toBe(25_000);
    expect(audit?.metadata).toMatchObject({ source: 'internal_billing', ttl_ms: TTL_MS });
  });

  it('leaves reservations younger than the TTL open', async () => {
    await reserve(25_000);
    expect(sweep(TTL_MS - 60_000)).toHaveLength(0);
    expect(balance()).toBe(STARTING_BALANCE - 25_000);
  });

  it('does not touch settled or released reservations', async () => {
    const settled = await reserve(10_000);
    await settle(settled, 4_000);
    const released = await reserve(10_000);
    await post('/internal/release', { reservation_id: released });
    const before = balance();

    expect(sweep(TTL_MS + 1_000)).toHaveLength(0);
    expect(balance()).toBe(before);
    expect(entriesFor(settled, 'RELEASE')).toHaveLength(1);
    expect(entriesFor(released, 'RELEASE')).toHaveLength(1);
  });

  it('ignores reservations that did not come from internal billing', async () => {
    // Shape written by /pay approvals and withdrawals: RESERVE with ref_id = id, no billing audit
    app.db.insert(schema.ledgerEntries).values({
      id: 'tx_approval_hold', agent_id: AGENT_ID, amount_msat: -50_000, entry_type: 'RESERVE',
      ref_id: 'tx_approval_hold', mode: 'simulated', created_at: new Date(Date.now() - 2 * TTL_MS),
    }).run();

    expect(sweep(TTL_MS + 1_000)).toHaveLength(0);
    expect(entriesFor('tx_approval_hold', 'RELEASE')).toHaveLength(0);
    expect(balance()).toBe(STARTING_BALANCE - 50_000);
  });

  it('refuses a late settle after expiry with 409 and charges nothing', async () => {
    const rid = await reserve(25_000);
    sweep(TTL_MS + 1_000);

    const res = await settle(rid, 20_000);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_released');
    expect(entriesFor(rid, 'PAYMENT')).toHaveLength(0);
    expect(balance()).toBe(STARTING_BALANCE);
  });

  it('is idempotent across sweeps', async () => {
    await reserve(25_000);
    expect(sweep(TTL_MS + 1_000)).toHaveLength(1);
    expect(sweep(TTL_MS + 120_000)).toHaveLength(0);
    expect(balance()).toBe(STARTING_BALANCE);
  });

  it('frees the daily limit held by a stale reservation', async () => {
    setDailyLimit(15_000);
    await reserve(10_000); // core crashed: never settled

    const blocked = await post('/internal/reserve', {
      agent_token: TEST_AGENT_TOKEN, amount_msats: 6_000, correlation_id: 'corr-next', model: 'gpt-4o',
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().reason).toBe('exceeds_daily_limit');

    sweep(TTL_MS + 1_000);
    await reserve(6_000);
  });
});
