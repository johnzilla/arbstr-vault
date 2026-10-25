/**
 * Approved payments and withdrawals pay through the configured wallet.
 *
 * - Lightning: wallet gets the stored invoice; the approval hold becomes the debit (as in /pay)
 * - Cashu: chosen below CASHU_THRESHOLD_MSAT when both rails exist; PAYMENT + RELEASE of the hold
 * - FAILED releases the hold; a Lightning stream error stays PENDING with the hold kept
 * - Withdrawal holds (written as 'simulated') are re-marked 'lightning' so recovery tracks them
 * - Crash recovery never releases the hold of an approval still awaiting the operator
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { ledgerRepo } from '../../src/modules/ledger/ledger.repo.js';
import { LightningStreamError } from '../../src/modules/payments/wallet/lightning.wallet.js';
import type { WalletBackend, PaymentResult } from '../../src/modules/payments/wallet/wallet.interface.js';
import { makeInvoice } from '../helpers/invoice.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

const ADMIN = 'test-admin-token-for-integration-tests-only';
process.env.VAULT_ADMIN_TOKEN = ADMIN;

type Db = BetterSQLite3Database<Record<string, never>>;

const START = 1_000_000;

function mockWallet(mode: 'lightning' | 'cashu', result: Partial<PaymentResult> | Error) {
  return {
    pay: vi.fn(async (req: { transaction_id: string }) => {
      if (result instanceof Error) throw result;
      return { transaction_id: req.transaction_id, status: 'SETTLED', mode, ...result } as PaymentResult;
    }),
  } satisfies WalletBackend;
}

describe('approved payments use the configured wallet', () => {
  let app: FastifyInstance & { db: BetterSQLite3Database<typeof schema> };
  let agentId: string;
  let token: string;

  async function setup(wallets: { wallet?: WalletBackend; cashuWallet?: WalletBackend }) {
    const sqlite = new Database(':memory:');
    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    app = buildApp({ db, ...wallets }) as typeof app;
    await app.ready();

    const admin = { authorization: `Bearer ${ADMIN}` };
    const reg = await app.inject({ method: 'POST', url: '/agents', headers: admin, payload: { name: 'rails' } });
    ({ agent_id: agentId, token } = reg.json());
    await app.inject({ method: 'POST', url: `/agents/${agentId}/deposit`, headers: admin, payload: { amount_msat: START } });
    // Everything above 5,000 msat needs approval; fee cap 2 sat
    await app.inject({
      method: 'PATCH', url: `/operator/agents/${agentId}/policy`, headers: admin,
      payload: { max_transaction_msat: 5_000, daily_limit_msat: 10_000_000, approval_timeout_ms: 300_000, max_fee_msat: 2_000 },
    });
  }

  const db = () => app.db as unknown as Db;
  const balance = () => ledgerRepo.getBalance(db(), agentId);
  const entries = (txId: string) =>
    app.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.ref_id, txId)).all();
  const audit = (txId: string, action: 'PAYMENT_SETTLED' | 'PAYMENT_FAILED') =>
    app.db.select().from(schema.auditLog)
      .where(and(eq(schema.auditLog.ref_id, txId), eq(schema.auditLog.action, action))).get();

  // A real signed regtest invoice for exactly the requested amount
  let invoice = '';

  async function requestPayment(amount: number) {
    invoice = makeInvoice({ amountMsat: amount });
    const res = await app.inject({
      method: 'POST', url: `/agents/${agentId}/pay`, headers: { authorization: `Bearer ${token}` },
      payload: { amount_msat: amount, asset: 'BTC_lightning', purpose: 'p', destination_type: 'lightning_invoice', destination: invoice },
    });
    expect(res.json().status).toBe('PENDING_APPROVAL');
    return res.json().transaction_id as string;
  }

  async function approve(txId: string) {
    const apr = app.db.select().from(schema.pendingApprovals)
      .where(eq(schema.pendingApprovals.transaction_id, txId)).get()!;
    const res = await app.inject({
      method: 'POST', url: `/operator/approvals/${apr.id}/approve`, headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().payment_status as string;
  }

  it('lightning: pays the stored invoice; the hold becomes the debit, fee charged separately', async () => {
    const ln = mockWallet('lightning', { payment_hash: 'hash-ln', fee_msat: 700 });
    await setup({ wallet: ln });
    const txId = await requestPayment(20_000);

    expect(await approve(txId)).toBe('SETTLED');

    expect(ln.pay).toHaveBeenCalledOnce();
    expect(ln.pay.mock.calls[0][0]).toMatchObject({
      destination: invoice, destination_type: 'lightning_invoice', amount_msat: 20_000, max_fee_msat: 2_000,
    });
    expect(balance()).toBe(START - 20_000 - 700);
    const reserve = entries(txId).find((e) => e.entry_type === 'RESERVE')!;
    expect(reserve).toMatchObject({ mode: 'lightning', payment_hash: 'hash-ln' });
    expect(entries(txId).filter((e) => e.entry_type === 'RELEASE')).toHaveLength(0);
    expect(audit(txId, 'PAYMENT_SETTLED')?.metadata).toMatchObject({ rail: 'lightning', fee_msat: 700 });
  });

  it('cashu: below the threshold with both rails, PAYMENT + RELEASE of the hold', async () => {
    const ln = mockWallet('lightning', {});
    const cashu = mockWallet('cashu', { cashu_token_id: 'tok-1', fee_msat: 1_000 });
    await setup({ wallet: ln, cashuWallet: cashu });
    const txId = await requestPayment(20_000); // < 1,000,000 msat default threshold

    expect(await approve(txId)).toBe('SETTLED');

    expect(cashu.pay).toHaveBeenCalledOnce();
    expect(ln.pay).not.toHaveBeenCalled();
    expect(balance()).toBe(START - 20_000 - 1_000);
    expect(audit(txId, 'PAYMENT_SETTLED')?.metadata).toMatchObject({ rail: 'cashu', cashu_token_id: 'tok-1' });
  });

  it('lightning FAILED releases the hold and audits the failure', async () => {
    const ln = mockWallet('lightning', { status: 'FAILED', payment_hash: 'hash-fail' });
    await setup({ wallet: ln });
    const txId = await requestPayment(20_000);

    expect(await approve(txId)).toBe('FAILED');

    expect(balance()).toBe(START);
    expect(audit(txId, 'PAYMENT_FAILED')?.metadata).toMatchObject({ rail: 'lightning', error: 'wallet_failed' });
  });

  it('lightning stream error stays PENDING: hold kept, hash stored, recovery tracks it', async () => {
    const ln = mockWallet('lightning', new LightningStreamError('stream closed', 'hash-inflight'));
    await setup({ wallet: ln });
    const txId = await requestPayment(20_000);

    expect(await approve(txId)).toBe('PENDING');

    expect(balance()).toBe(START - 20_000);
    expect(entries(txId).filter((e) => e.entry_type === 'RELEASE')).toHaveLength(0);
    const pending = ledgerRepo.getPendingLightningPayments(db());
    expect(pending).toEqual([expect.objectContaining({ id: txId, payment_hash: 'hash-inflight' })]);
  });

  it('withdrawal: the simulated-mode hold is re-marked lightning and paid to the destination', async () => {
    const ln = mockWallet('lightning', { payment_hash: 'hash-wd', fee_msat: 0 });
    await setup({ wallet: ln });
    const res = await app.inject({
      method: 'POST', url: `/agents/${agentId}/withdrawals`, headers: { authorization: `Bearer ${token}` },
      payload: { destination: (invoice = makeInvoice({ amountMsat: 30_000 })), amount_msat: 30_000 },
    });
    const txId = res.json().transaction_id as string;
    expect(entries(txId).find((e) => e.entry_type === 'RESERVE')?.mode).toBe('simulated');

    expect(await approve(txId)).toBe('SETTLED');

    expect(ln.pay.mock.calls[0][0]).toMatchObject({ destination: invoice, amount_msat: 30_000 });
    expect(entries(txId).find((e) => e.entry_type === 'RESERVE')).toMatchObject({ mode: 'lightning', payment_hash: 'hash-wd' });
    expect(balance()).toBe(START - 30_000);
  });

  it('a real rail with no stored destination fails without calling the wallet', async () => {
    const ln = mockWallet('lightning', {});
    await setup({ wallet: ln });
    const txId = await requestPayment(20_000);
    app.db.update(schema.pendingApprovals).set({ destination: null })
      .where(eq(schema.pendingApprovals.transaction_id, txId)).run();

    expect(await approve(txId)).toBe('FAILED');
    expect(ln.pay).not.toHaveBeenCalled();
    expect(balance()).toBe(START);
    expect(audit(txId, 'PAYMENT_FAILED')?.metadata).toMatchObject({ error: 'missing_destination' });
  });

  it('crash recovery skips holds of approvals still awaiting the operator', async () => {
    await setup({ wallet: mockWallet('lightning', {}) });
    const txId = await requestPayment(20_000);
    // The hold is a 'lightning' RESERVE with no payment_hash — the shape recovery releases
    expect(entries(txId).find((e) => e.entry_type === 'RESERVE')).toMatchObject({ mode: 'lightning', payment_hash: null });

    expect(ledgerRepo.getPendingLightningPayments(db())).toHaveLength(0);
  });
});
