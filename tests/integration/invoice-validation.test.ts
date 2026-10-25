/**
 * BOLT11 destination checks on POST /agents/:id/pay and POST /agents/:id/withdrawals.
 *
 * The ledger debits amount_msat, but LND (and the Cashu melt) pay the invoice's own
 * amount, so the invoice must parse, carry an amount, be unexpired and equal
 * amount_msat exactly. Rejections happen before policy evaluation: no RESERVE,
 * no audit entry, no approval queued.
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
import { makeInvoice } from '../helpers/invoice.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const TEST_ADMIN_TOKEN = 'test-admin-token-for-integration-tests-only';
process.env.VAULT_ADMIN_TOKEN = TEST_ADMIN_TOKEN;

const AMOUNT = 25_000;

describe('BOLT11 destination validation', () => {
  let app: ReturnType<typeof buildApp>;
  let agentId: string;
  let token: string;

  const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

  const pay = (destination: string, amount_msat = AMOUNT, destination_type = 'lightning_invoice') =>
    app.inject({
      method: 'POST',
      url: `/agents/${agentId}/pay`,
      headers: { authorization: `Bearer ${token}` },
      payload: { amount_msat, asset: 'BTC_simulated', purpose: 'test', destination_type, destination },
    });

  const withdraw = (destination: string, amount_msat = AMOUNT) =>
    app.inject({
      method: 'POST',
      url: `/agents/${agentId}/withdrawals`,
      headers: { authorization: `Bearer ${token}` },
      payload: { destination, amount_msat },
    });

  const sideEffects = () => ({
    reserves: app.db.select().from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.entry_type, 'RESERVE')).all().length,
    paymentRequests: app.db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'PAYMENT_REQUEST')).all().length,
    withdrawalRequests: app.db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'WITHDRAWAL_REQUESTED')).all().length,
    approvals: app.db.select().from(schema.pendingApprovals).all().length,
  });

  beforeEach(async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    app = buildApp(db);
    await app.ready();

    const reg = await app.inject({ method: 'POST', url: '/agents', headers: admin, payload: { name: 'Invoice Agent' } });
    ({ agent_id: agentId, token } = reg.json() as { agent_id: string; token: string });
    await app.inject({
      method: 'PATCH', url: `/operator/agents/${agentId}/policy`, headers: admin,
      payload: { max_transaction_msat: 1_000_000, daily_limit_msat: 10_000_000 },
    });
    await app.inject({ method: 'POST', url: `/agents/${agentId}/deposit`, headers: admin, payload: { amount_msat: 5_000_000 } });
  });

  afterEach(async () => {
    await app.close();
  });

  const cases: Array<[string, () => string, string]> = [
    ['malformed string', () => 'lnbc...', 'invalid_invoice'],
    ['not an invoice at all', () => 'test-destination', 'invalid_invoice'],
    ['amountless invoice', () => makeInvoice(), 'invoice_amount_required'],
    ['expired invoice', () => makeInvoice({ amountMsat: AMOUNT, expiresInSec: -60 }), 'invoice_expired'],
    ['invoice for a different amount', () => makeInvoice({ amountMsat: AMOUNT - 1_000 }), 'invoice_amount_mismatch'],
  ];

  describe('POST /agents/:id/pay', () => {
    for (const [label, invoice, code] of cases) {
      it(`rejects ${label} with 400 ${code} and no side effects`, async () => {
        const before = sideEffects();
        const res = await pay(invoice());
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe(code);
        expect(sideEffects()).toEqual(before);
      });
    }

    it('reports the invoice amount on a mismatch', async () => {
      const res = await pay(makeInvoice({ amountMsat: 24_000 }));
      expect(res.json()).toMatchObject({ error: { code: 'invoice_amount_mismatch' }, invoice_amount_msat: 24_000 });
    });

    it('accepts an invoice for exactly amount_msat', async () => {
      const res = await pay(makeInvoice({ amountMsat: AMOUNT }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ policy_decision: 'ALLOW', status: 'SETTLED' });
    });

    it('does not apply to non-invoice destination types', async () => {
      const res = await pay('test-dest', AMOUNT, 'internal');
      expect(res.statusCode).toBe(200);
    });

    it('still returns 400 (not 500) for body validation errors', async () => {
      const res = await app.inject({
        method: 'POST', url: `/agents/${agentId}/pay`, headers: { authorization: `Bearer ${token}` },
        payload: { asset: 'BTC_simulated', purpose: 'x', destination_type: 'internal', destination: 'x' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /agents/:id/withdrawals', () => {
    for (const [label, invoice, code] of cases) {
      it(`rejects ${label} with 400 ${code} and queues nothing`, async () => {
        const before = sideEffects();
        const res = await withdraw(invoice());
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe(code);
        expect(sideEffects()).toEqual(before);
      });
    }

    it('queues a withdrawal for an invoice of exactly amount_msat', async () => {
      const res = await withdraw(makeInvoice({ amountMsat: AMOUNT }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'PENDING_APPROVAL', amount_msat: AMOUNT });
      expect(sideEffects().approvals).toBe(1);
    });

    it('still returns 400 (not 500) for body validation errors', async () => {
      const res = await app.inject({
        method: 'POST', url: `/agents/${agentId}/withdrawals`, headers: { authorization: `Bearer ${token}` },
        payload: { destination: makeInvoice({ amountMsat: AMOUNT }) },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
