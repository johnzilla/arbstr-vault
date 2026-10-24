/**
 * Contract tests: arbstr core (Rust) ↔ vault internal billing API.
 *
 * Payloads below mirror the serde_json::json! bodies built in arbstr core's
 * src/proxy/vault.rs (VaultClient::reserve / settle / release) exactly,
 * including Option<u32> tokens serialized as null. If core changes a body
 * shape, update the fixture here first — a failing test means the two
 * services no longer agree.
 *
 * Response assertions check what core deserializes:
 * - reserve: `reservation_id` (string)
 * - settle:  SettleResponse { settled: bool, refunded_msats: Option<u64> }
 *            (a negative refund fails u64 deserialization in core)
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
import { ledgerRepo } from '../../src/modules/ledger/ledger.repo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_INTERNAL_TOKEN = 'test-internal-token-min-32-characters-long';
const TEST_AGENT_TOKEN = 'vtk_test_agent_token_for_core_contract';
const AGENT_ID = 'ag_contract';
const STARTING_BALANCE = 100_000;

// --- core payload builders (keep in lockstep with arbstr src/proxy/vault.rs) ---

function coreReserveBody(amount_msats: number, correlation_id = 'corr-0001') {
  return { agent_token: TEST_AGENT_TOKEN, amount_msats, correlation_id, model: 'gpt-4o' };
}

function coreSettleBody(
  reservation_id: string,
  actual_msats: number,
  tokens: { tokens_in: number | null; tokens_out: number | null } = { tokens_in: 120, tokens_out: 340 },
) {
  return {
    reservation_id,
    actual_msats,
    metadata: { ...tokens, provider: 'provider-alpha', latency_ms: 812 },
  };
}

function coreReleaseBody(reservation_id: string, reason = 'provider_error') {
  return { reservation_id, reason };
}

// --- harness ---

function buildTestApp() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return buildApp(db);
}

describe('core ↔ vault billing contract', () => {
  let app: ReturnType<typeof buildApp>;

  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: { 'x-internal-token': TEST_INTERNAL_TOKEN }, payload });

  const balance = () => ledgerRepo.getBalance(app.db, AGENT_ID);

  async function reserve(amount: number): Promise<string> {
    const res = await post('/internal/reserve', coreReserveBody(amount));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reservation_id: unknown };
    expect(typeof body.reservation_id).toBe('string');
    return body.reservation_id as string;
  }

  function expectCoreSettleResponse(body: { settled: unknown; refunded_msats: unknown }) {
    expect(body.settled).toBe(true);
    expect(Number.isInteger(body.refunded_msats)).toBe(true);
    expect(body.refunded_msats as number).toBeGreaterThanOrEqual(0);
  }

  beforeEach(async () => {
    app = buildTestApp();
    await app.ready();
    app.db.insert(schema.agents).values({ id: AGENT_ID, name: 'Contract Agent', token_hash: hashToken(TEST_AGENT_TOKEN) }).run();
    app.db.insert(schema.ledgerEntries).values({
      id: 'tx_contract_deposit', agent_id: AGENT_ID, amount_msat: STARTING_BALANCE, entry_type: 'DEPOSIT', mode: 'simulated',
    }).run();
  });

  afterEach(async () => {
    await app.close();
  });

  it('settle accepts core\'s nested metadata body and charges actual cost', async () => {
    const rid = await reserve(5_000);
    const res = await post('/internal/settle', coreSettleBody(rid, 1_200));

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectCoreSettleResponse(body);
    expect(body.refunded_msats).toBe(3_800);
    expect(balance()).toBe(STARTING_BALANCE - 1_200);

    const audit = app.db.select().from(schema.auditLog).where(eq(schema.auditLog.ref_id, rid)).get();
    expect(audit?.metadata).toMatchObject({ tokens_in: 120, tokens_out: 340, provider: 'provider-alpha', latency_ms: 812 });
  });

  it('settle accepts null token counts (provider reported no usage)', async () => {
    const rid = await reserve(5_000);
    const res = await post('/internal/settle', coreSettleBody(rid, 2_000, { tokens_in: null, tokens_out: null }));

    expect(res.statusCode).toBe(200);
    expectCoreSettleResponse(res.json());
    expect(balance()).toBe(STARTING_BALANCE - 2_000);
  });

  it('zero-cost reserve and settle work for free local-tier providers', async () => {
    const rid = await reserve(0);
    const res = await post('/internal/settle', coreSettleBody(rid, 0));

    expect(res.statusCode).toBe(200);
    expectCoreSettleResponse(res.json());
    expect(balance()).toBe(STARTING_BALANCE);
  });

  it('release accepts core\'s body (with reason) and restores the hold', async () => {
    const rid = await reserve(5_000);
    expect(balance()).toBe(STARTING_BALANCE - 5_000);

    const res = await post('/internal/release', coreReleaseBody(rid));
    expect(res.statusCode).toBe(200);
    expect(balance()).toBe(STARTING_BALANCE);
  });

  it('settle above the reservation is capped at the reserved amount', async () => {
    const rid = await reserve(1_000);
    const res = await post('/internal/settle', coreSettleBody(rid, 500_000));

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectCoreSettleResponse(body);
    expect(body.actual_msats).toBe(1_000);
    expect(body.refunded_msats).toBe(0);
    expect(balance()).toBe(STARTING_BALANCE - 1_000);

    const audit = app.db.select().from(schema.auditLog).where(eq(schema.auditLog.ref_id, rid)).get();
    expect(audit?.metadata).toMatchObject({ capped: true, requested_msats: 500_000 });
  });

  it('settle after release is refused with 409 and does not charge', async () => {
    const rid = await reserve(3_000);
    await post('/internal/release', coreReleaseBody(rid));

    const res = await post('/internal/settle', coreSettleBody(rid, 3_000));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_released');
    expect(balance()).toBe(STARTING_BALANCE);
  });

  it('release after settle is refused with 409 and keeps the charge', async () => {
    const rid = await reserve(3_000);
    await post('/internal/settle', coreSettleBody(rid, 2_500));

    const res = await post('/internal/release', coreReleaseBody(rid));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_settled');
    expect(balance()).toBe(STARTING_BALANCE - 2_500);
  });

  it('replayed settle (core pending-settlement retry) is idempotent and keeps the first amount', async () => {
    const rid = await reserve(5_000);
    await post('/internal/settle', coreSettleBody(rid, 1_500));

    const res = await post('/internal/settle', coreSettleBody(rid, 4_000));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectCoreSettleResponse(body);
    expect(body.actual_msats).toBe(1_500);
    expect(body.refunded_msats).toBe(3_500);
    expect(balance()).toBe(STARTING_BALANCE - 1_500);

    const payments = app.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.ref_id, rid)).all()
      .filter((e) => e.entry_type === 'PAYMENT');
    expect(payments).toHaveLength(1);
  });
});
