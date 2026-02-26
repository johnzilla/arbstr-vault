import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../src/db/schema.js';
import { ledgerRepo } from '../../src/modules/ledger/ledger.repo.js';
import { ledgerService } from '../../src/modules/ledger/ledger.service.js';
import { auditRepo } from '../../src/modules/audit/audit.repo.js';
import { simulatedWallet } from '../../src/modules/payments/wallet/simulated.wallet.js';
import type { TransactionId } from '../../src/types.js';

// ---- helpers ----------------------------------------------------------------

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  return db;
}

type Db = ReturnType<typeof makeDb>;

function createAgent(db: Db, id: string = 'ag_test01') {
  db.insert(schema.agents).values({
    id,
    name: 'Test Agent',
    token_hash: 'deadbeef'.repeat(8), // 64-char hex hash
  }).run();
  return id;
}

// ---- tests ------------------------------------------------------------------

describe('ledgerRepo', () => {
  let db: Db;
  let agentId: string;

  beforeEach(() => {
    db = makeDb();
    agentId = createAgent(db);
  });

  it('getBalance returns 0 for new agent', () => {
    const balance = ledgerRepo.getBalance(db, agentId);
    expect(balance).toBe(0);
  });

  it('deposit increases balance correctly', () => {
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: 50_000, entry_type: 'DEPOSIT' });
    const balance = ledgerRepo.getBalance(db, agentId);
    expect(balance).toBe(50_000);
  });

  it('multiple deposits accumulate', () => {
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: 30_000, entry_type: 'DEPOSIT' });
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: 20_000, entry_type: 'DEPOSIT' });
    const balance = ledgerRepo.getBalance(db, agentId);
    expect(balance).toBe(50_000);
  });

  it('debit (negative entry) reduces balance', () => {
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: 100_000, entry_type: 'DEPOSIT' });
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: -30_000, entry_type: 'PAYMENT' });
    const balance = ledgerRepo.getBalance(db, agentId);
    expect(balance).toBe(70_000);
  });

  it('getBalance after deposit + debit returns correct net', () => {
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: 200_000, entry_type: 'DEPOSIT' });
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: -50_000, entry_type: 'PAYMENT' });
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: -25_000, entry_type: 'PAYMENT' });
    const balance = ledgerRepo.getBalance(db, agentId);
    expect(balance).toBe(125_000);
  });

  it('getDailySpend only counts PAYMENT entries within last 24h', () => {
    // Recent PAYMENT — should count
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: -40_000, entry_type: 'PAYMENT' });
    // DEPOSIT — should NOT count
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: 100_000, entry_type: 'DEPOSIT' });
    const spend = ledgerRepo.getDailySpend(db, agentId);
    expect(spend).toBe(40_000);
  });

  it('getDailySpend ignores DEPOSIT entries', () => {
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: 500_000, entry_type: 'DEPOSIT' });
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: 200_000, entry_type: 'DEPOSIT' });
    const spend = ledgerRepo.getDailySpend(db, agentId);
    expect(spend).toBe(0);
  });

  it('getDailySpend ignores PAYMENT entries older than 24h', () => {
    // Insert an entry with created_at older than 24h directly via raw SQL
    const oldTimestamp = Date.now() - 86_400_001; // just outside the 24h window
    db.insert(schema.ledgerEntries).values({
      agent_id: agentId,
      amount_msat: -99_000,
      entry_type: 'PAYMENT',
      created_at: new Date(oldTimestamp),
    }).run();

    // Recent PAYMENT — should count
    ledgerRepo.insert(db, { agent_id: agentId, amount_msat: -10_000, entry_type: 'PAYMENT' });

    const spend = ledgerRepo.getDailySpend(db, agentId);
    // Only the recent payment (10_000) — the old one (99_000) is excluded
    expect(spend).toBe(10_000);
  });
});

describe('ledgerService', () => {
  let db: Db;
  let agentId: string;

  beforeEach(() => {
    db = makeDb();
    agentId = createAgent(db);
  });

  it('deposit returns new balance', () => {
    const newBalance = ledgerService.deposit(db, agentId, 75_000);
    expect(newBalance).toBe(75_000);
  });

  it('deposit creates both a ledger entry and an audit log entry', () => {
    ledgerService.deposit(db, agentId, 50_000);
    const balance = ledgerService.getBalance(db, agentId);
    expect(balance).toBe(50_000);

    const auditEntries = auditRepo.listByAgent(db, agentId, { limit: 10 });
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].action).toBe('DEPOSIT');
    expect(auditEntries[0].amount_msat).toBe(50_000);
  });

  it('debit inserts PAYMENT entry with negative amount', () => {
    // debit runs inside a transaction provided by the caller
    db.transaction((tx) => {
      ledgerService.debit(tx as Parameters<typeof ledgerService.debit>[0], agentId, 20_000, 'ref_001');
    });
    const entries = ledgerRepo.listByAgent(db, agentId, { limit: 10, entry_type: 'PAYMENT' });
    expect(entries.length).toBe(1);
    expect(entries[0].amount_msat).toBe(-20_000);
  });
});

describe('auditRepo', () => {
  let db: Db;
  let agentId: string;

  beforeEach(() => {
    db = makeDb();
    agentId = createAgent(db);
  });

  it('audit insert creates entry, listByAgent returns it', () => {
    auditRepo.insert(db, {
      agent_id: agentId,
      action: 'PAYMENT_REQUEST',
      policy_decision: 'ALLOW',
      amount_msat: 10_000,
      ref_id: 'tx_abc',
    });
    const entries = auditRepo.listByAgent(db, agentId, { limit: 10 });
    expect(entries.length).toBe(1);
    expect(entries[0].agent_id).toBe(agentId);
    expect(entries[0].action).toBe('PAYMENT_REQUEST');
    expect(entries[0].policy_decision).toBe('ALLOW');
    expect(entries[0].amount_msat).toBe(10_000);
  });

  it('auditRepo listByAgent respects action_type filter', () => {
    auditRepo.insert(db, { agent_id: agentId, action: 'PAYMENT_REQUEST', amount_msat: 10_000 });
    auditRepo.insert(db, { agent_id: agentId, action: 'DEPOSIT', amount_msat: 100_000 });
    auditRepo.insert(db, { agent_id: agentId, action: 'PAYMENT_SETTLED', amount_msat: 10_000 });

    const payments = auditRepo.listByAgent(db, agentId, { limit: 10, action_type: 'PAYMENT_REQUEST' });
    expect(payments.length).toBe(1);
    expect(payments[0].action).toBe('PAYMENT_REQUEST');

    const deposits = auditRepo.listByAgent(db, agentId, { limit: 10, action_type: 'DEPOSIT' });
    expect(deposits.length).toBe(1);
    expect(deposits[0].action).toBe('DEPOSIT');
  });
});

describe('simulatedWallet', () => {
  it('pay returns SETTLED with mode simulated', async () => {
    const txId = 'tx_test001' as TransactionId;
    const result = await simulatedWallet.pay({
      amount_msat: 10_000,
      asset: 'BTC',
      purpose: 'test payment',
      destination_type: 'lightning',
      destination: 'lnbc...invoice',
      transaction_id: txId,
    });
    expect(result.status).toBe('SETTLED');
    expect(result.mode).toBe('simulated');
    expect(result.transaction_id).toBe(txId);
    expect(result.settled_at).toBeInstanceOf(Date);
  });
});
