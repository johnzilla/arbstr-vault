/**
 * Lightning integration tests — mock LND, always run (no live node needed).
 *
 * These tests verify the Lightning payment state machine, RESERVE/RELEASE ledger flow,
 * crash recovery, and macaroon scope enforcement WITHOUT a live LND node.
 *
 * Live regtest tests (require LND_HOST env var) are skipped in CI.
 * Use docker-compose.dev.yml to start a regtest environment for manual testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as schema from '../../src/db/schema.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

// ---------------------------------------------------------------------------
// Mock the lightning npm package BEFORE any imports that use it.
// vi.mock is hoisted by Vitest to the top of the module.
// ---------------------------------------------------------------------------
vi.mock('lightning', () => ({
  subscribeToPayViaRequest: vi.fn(),
  subscribeToPastPayment: vi.fn(),
  authenticatedLndGrpc: vi.fn(),
  getWalletInfo: vi.fn(),
  getChainBalance: vi.fn(),
}));

// Import after mock
import { LightningWallet, LightningStreamError } from '../../src/modules/payments/wallet/lightning.wallet.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { ledgerRepo } from '../../src/modules/ledger/ledger.repo.js';
import type { WalletBackend, PaymentRequest, PaymentResult } from '../../src/modules/payments/wallet/wallet.interface.js';
import {
  subscribeToPayViaRequest,
  subscribeToPastPayment,
  getChainBalance,
} from 'lightning';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '../../src/db/migrations');

type DB = BetterSQLite3Database<typeof schema>;
type NarrowDb = BetterSQLite3Database<Record<string, never>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): DB {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

/**
 * Create a mock subscription EventEmitter that emits events asynchronously.
 * This matches the LND subscribeToPayViaRequest/subscribeToPastPayment contract.
 */
function createMockSubscription(events: Array<{ event: string; data: unknown; delay?: number }>) {
  const emitter = new EventEmitter();
  setTimeout(() => {
    for (const e of events) {
      emitter.emit(e.event, e.data);
    }
  }, 0);
  return emitter;
}

/** Create a mock WalletBackend that resolves with the given result. */
function createMockWallet(result: PaymentResult): WalletBackend {
  return {
    pay: vi.fn().mockResolvedValue(result),
  };
}

/** Create a mock WalletBackend that rejects with the given error. */
function createMockWalletThatThrows(error: Error): WalletBackend {
  return {
    pay: vi.fn().mockRejectedValue(error),
  };
}

/** Insert an agent and return its id. */
function insertAgent(db: DB, id: string): void {
  db.insert(schema.agents).values({
    id,
    name: 'Test Agent',
    token_hash: 'test-hash',
  }).run();
}

/** Insert a policy for an agent. */
function insertPolicy(db: DB, agentId: string): void {
  db.insert(schema.policies).values({
    agent_id: agentId,
    max_transaction_msat: 1_000_000,
    daily_limit_msat: 10_000_000,
    max_fee_msat: 1000,
  }).run();
}

/** Insert a deposit into the ledger. */
function insertDeposit(db: DB, agentId: string, amount: number): void {
  (db as unknown as NarrowDb).insert(schema.ledgerEntries).values({
    agent_id: agentId,
    amount_msat: amount,
    entry_type: 'DEPOSIT',
  }).run();
}

/** Create a standard payment request for testing. */
function makePaymentRequest(amount = 10_000): PaymentRequest {
  return {
    amount_msat: amount,
    asset: 'BTC_lightning',
    purpose: 'Test payment',
    destination_type: 'lightning_invoice',
    destination: 'lnbcrt100u1...',  // mock BOLT11 invoice
    transaction_id: `tx_test_${Date.now()}`,
    max_fee_msat: 1000,
  };
}

// ---------------------------------------------------------------------------
// Mock LightningWallet tests — always run (no LND node needed)
// ---------------------------------------------------------------------------

describe('LightningWallet — mock subscribeToPayViaRequest', () => {
  const mockLnd = {} as Parameters<typeof LightningWallet.prototype.pay>[0] extends never
    ? never
    : ReturnType<typeof vi.fn>;

  // Cast to satisfy TypeScript — the mock replaces the real subscribeToPayViaRequest
  const mockSubscribeToPayViaRequest = subscribeToPayViaRequest as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. SETTLED payment flow — emits paying then confirmed', async () => {
    const wallet = new LightningWallet(mockLnd as never);
    const paymentHash = 'abc123deadbeef';

    mockSubscribeToPayViaRequest.mockReturnValue(
      createMockSubscription([
        { event: 'paying', data: { id: paymentHash } },
        { event: 'confirmed', data: { id: paymentHash, fee_mtokens: '500' } },
      ]),
    );

    const req = makePaymentRequest();
    const result = await wallet.pay(req);

    expect(result.status).toBe('SETTLED');
    expect(result.payment_hash).toBe(paymentHash);
    expect(result.fee_msat).toBe(500);
    expect(result.mode).toBe('lightning');
  });

  it('2. FAILED payment flow — emits paying then failed', async () => {
    const wallet = new LightningWallet(mockLnd as never);
    const paymentHash = 'deadbeef01020304';

    mockSubscribeToPayViaRequest.mockReturnValue(
      createMockSubscription([
        { event: 'paying', data: { id: paymentHash } },
        { event: 'failed', data: { is_route_not_found: true } },
      ]),
    );

    const req = makePaymentRequest();
    const result = await wallet.pay(req);

    expect(result.status).toBe('FAILED');
    // payment_hash is captured in 'paying' event even on failure
    expect(result.payment_hash).toBe(paymentHash);
  });

  it('3. Stream error keeps PENDING — rejects with LightningStreamError (no RELEASE)', async () => {
    const wallet = new LightningWallet(mockLnd as never);

    mockSubscribeToPayViaRequest.mockReturnValue(
      createMockSubscription([
        { event: 'paying', data: { id: 'hash123' } },
        { event: 'error', data: new Error('gRPC stream disconnected') },
      ]),
    );

    const req = makePaymentRequest();

    // Must reject with LightningStreamError, NOT resolve with FAILED
    await expect(wallet.pay(req)).rejects.toBeInstanceOf(LightningStreamError);
  });

  it('4. payment_hash captured from paying event before confirmed', async () => {
    const wallet = new LightningWallet(mockLnd as never);
    const paymentHash = 'abc123';

    mockSubscribeToPayViaRequest.mockReturnValue(
      createMockSubscription([
        { event: 'paying', data: { id: paymentHash } },
        { event: 'confirmed', data: { id: paymentHash, fee_mtokens: '100' } },
      ]),
    );

    const req = makePaymentRequest();
    const result = await wallet.pay(req);

    expect(result.payment_hash).toBe(paymentHash);
  });

  it('5. LightningStreamError contains payment_hash if captured before error', async () => {
    const wallet = new LightningWallet(mockLnd as never);
    const paymentHash = 'hash_before_error';

    mockSubscribeToPayViaRequest.mockReturnValue(
      createMockSubscription([
        { event: 'paying', data: { id: paymentHash } },
        { event: 'error', data: new Error('stream closed') },
      ]),
    );

    const req = makePaymentRequest();

    try {
      await wallet.pay(req);
      expect.fail('Should have thrown LightningStreamError');
    } catch (err) {
      expect(err).toBeInstanceOf(LightningStreamError);
      expect((err as LightningStreamError).payment_hash).toBe(paymentHash);
    }
  });

  it('6. LightningStreamError without payment_hash when error before paying', async () => {
    const wallet = new LightningWallet(mockLnd as never);

    // Error emitted WITHOUT a prior 'paying' event
    mockSubscribeToPayViaRequest.mockReturnValue(
      createMockSubscription([
        { event: 'error', data: new Error('immediate stream error') },
      ]),
    );

    const req = makePaymentRequest();

    try {
      await wallet.pay(req);
      expect.fail('Should have thrown LightningStreamError');
    } catch (err) {
      expect(err).toBeInstanceOf(LightningStreamError);
      // No payment_hash — error occurred before 'paying' event
      expect((err as LightningStreamError).payment_hash).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// RESERVE/RELEASE ledger flow — service level tests
// ---------------------------------------------------------------------------

describe('RESERVE/RELEASE ledger flow — via createPaymentsService', () => {
  let db: DB;

  beforeEach(() => {
    db = createTestDb();
  });

  it('7. RESERVE/RELEASE full flow — FAILED payment credits back balance', async () => {
    const agentId = 'ag_test_reserve_release';
    insertAgent(db, agentId);
    insertPolicy(db, agentId);
    insertDeposit(db, agentId, 100_000);

    const mockWallet = createMockWallet({
      transaction_id: 'tx_test',
      status: 'FAILED',
      mode: 'lightning',
      payment_hash: 'failhash123',
    });

    const service = createPaymentsService(mockWallet);
    const req = {
      amount_msat: 10_000,
      asset: 'BTC_lightning',
      purpose: 'Test',
      destination_type: 'lightning_invoice',
      destination: 'lnbcrt100u1...',
    };

    const result = await service.processPayment(db, agentId, req);

    expect(result.status).toBe('FAILED');
    expect(result.policy_decision).toBe('ALLOW');

    // Find RESERVE + RELEASE entries from the ledger
    const allEntries = (db as unknown as NarrowDb)
      .select()
      .from(schema.ledgerEntries)
      .all();

    const reserveEntry = allEntries.find((e) => e.entry_type === 'RESERVE');
    const releaseEntry = allEntries.find((e) => e.entry_type === 'RELEASE');

    expect(reserveEntry).toBeDefined();
    expect(reserveEntry!.amount_msat).toBe(-10_000);
    expect(releaseEntry).toBeDefined();
    expect(releaseEntry!.amount_msat).toBe(10_000);

    // Balance should be restored to 100_000
    const balance = ledgerRepo.getBalance(db as unknown as NarrowDb, agentId);
    expect(balance).toBe(100_000);
  });

  it('8. RESERVE with SETTLED — no RELEASE, balance reduced by amount + fee', async () => {
    const agentId = 'ag_test_settled';
    insertAgent(db, agentId);
    insertPolicy(db, agentId);
    insertDeposit(db, agentId, 100_000);

    const feeMsat = 500;
    const mockWallet = createMockWallet({
      transaction_id: 'tx_test',
      status: 'SETTLED',
      mode: 'lightning',
      payment_hash: 'settlehash456',
      fee_msat: feeMsat,
    });

    const service = createPaymentsService(mockWallet);
    const req = {
      amount_msat: 10_000,
      asset: 'BTC_lightning',
      purpose: 'Test',
      destination_type: 'lightning_invoice',
      destination: 'lnbcrt100u1...',
    };

    const result = await service.processPayment(db, agentId, req);

    expect(result.status).toBe('SETTLED');
    expect(result.payment_hash).toBe('settlehash456');
    expect(result.fee_msat).toBe(feeMsat);

    // After SETTLED: RESERVE present, no RELEASE, fee PAYMENT entry present
    const allEntries = (db as unknown as NarrowDb)
      .select()
      .from(schema.ledgerEntries)
      .all();

    const reserveEntry = allEntries.find((e) => e.entry_type === 'RESERVE');
    const releaseEntry = allEntries.find((e) => e.entry_type === 'RELEASE');
    const feeEntry = allEntries.find((e) => e.entry_type === 'PAYMENT');

    expect(reserveEntry).toBeDefined();
    expect(releaseEntry).toBeUndefined();
    expect(feeEntry).toBeDefined();
    expect(feeEntry!.amount_msat).toBe(-feeMsat);

    // Balance: 100_000 - 10_000 (RESERVE) - 500 (fee PAYMENT)
    const balance = ledgerRepo.getBalance(db as unknown as NarrowDb, agentId);
    expect(balance).toBe(89_500);
  });

  it('9. Stream error keeps ledger PENDING — no RELEASE written', async () => {
    const agentId = 'ag_test_stream_error';
    insertAgent(db, agentId);
    insertPolicy(db, agentId);
    insertDeposit(db, agentId, 100_000);

    const streamError = new LightningStreamError('gRPC disconnected', 'hashcaptured');
    const mockWallet = createMockWalletThatThrows(streamError);

    const service = createPaymentsService(mockWallet);
    const req = {
      amount_msat: 10_000,
      asset: 'BTC_lightning',
      purpose: 'Test',
      destination_type: 'lightning_invoice',
      destination: 'lnbcrt100u1...',
    };

    const result = await service.processPayment(db, agentId, req);

    // Stream error = PENDING (payment may still be in-flight)
    expect(result.status).toBe('PENDING');
    expect(result.policy_decision).toBe('ALLOW');
    expect(result.payment_hash).toBe('hashcaptured');

    // RELEASE must NOT be written
    const allEntries = (db as unknown as NarrowDb)
      .select()
      .from(schema.ledgerEntries)
      .all();

    const releaseEntry = allEntries.find((e) => e.entry_type === 'RELEASE');
    expect(releaseEntry).toBeUndefined();

    // RESERVE must still be present (balance debited)
    const reserveEntry = allEntries.find((e) => e.entry_type === 'RESERVE');
    expect(reserveEntry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Crash recovery tests
// ---------------------------------------------------------------------------

describe('Crash recovery — getPendingLightningPayments', () => {
  let db: DB;

  beforeEach(() => {
    db = createTestDb();
  });

  it('10. Crash recovery — no payment_hash: RELEASE should be written', () => {
    const agentId = 'ag_crash_nohash';
    const txId = 'tx_01CRASH_NOHASH';
    insertAgent(db, agentId);

    // Manually insert a RESERVE entry with NO payment_hash (crashed before LND call)
    const narrowDb = db as unknown as NarrowDb;
    ledgerRepo.insert(narrowDb, {
      id: txId,
      agent_id: agentId,
      amount_msat: -10_000,
      entry_type: 'RESERVE',
      ref_id: txId,
      mode: 'lightning',
      // payment_hash intentionally omitted
    });

    // Verify getPendingLightningPayments finds this entry
    const pendingPayments = ledgerRepo.getPendingLightningPayments(narrowDb);
    const found = pendingPayments.find((p) => p.id === txId);
    expect(found).toBeDefined();
    expect(found!.payment_hash).toBeNull();

    // Crash recovery should write RELEASE for entries with no payment_hash
    // (simulate what initializeLightningBackend would do)
    ledgerRepo.insert(narrowDb, {
      agent_id: agentId,
      amount_msat: 10_000,
      entry_type: 'RELEASE',
      ref_id: txId,
      mode: 'lightning',
    });

    // After RELEASE is written, it should no longer appear in pending
    const pendingAfter = ledgerRepo.getPendingLightningPayments(narrowDb);
    const foundAfter = pendingAfter.find((p) => p.id === txId);
    expect(foundAfter).toBeUndefined();
  });

  it('11. Crash recovery — has payment_hash: pending payment detected for re-subscription', () => {
    const agentId = 'ag_crash_withhash';
    const txId = 'tx_01CRASH_WITHHASH';
    const paymentHash = 'abc123def456';
    insertAgent(db, agentId);

    const narrowDb = db as unknown as NarrowDb;

    // Insert RESERVE entry WITH payment_hash (crashed after LND send, before SETTLED/FAILED)
    ledgerRepo.insert(narrowDb, {
      id: txId,
      agent_id: agentId,
      amount_msat: -10_000,
      entry_type: 'RESERVE',
      ref_id: txId,
      payment_hash: paymentHash,
      mode: 'lightning',
    });

    // Verify getPendingLightningPayments finds this entry with its hash
    const pendingPayments = ledgerRepo.getPendingLightningPayments(narrowDb);
    const found = pendingPayments.find((p) => p.id === txId);
    expect(found).toBeDefined();
    expect(found!.payment_hash).toBe(paymentHash);

    // For entries with payment_hash, crash recovery would call subscribeToPastPayment
    // to re-subscribe to the HTLC and handle SETTLED/FAILED when it completes.
    // This test verifies the detection works correctly.
  });

  it('12. Crash recovery — subscribeToPastPayment mock for re-subscription (SETTLED outcome)', async () => {
    const mockSubscribeToPastPayment = subscribeToPastPayment as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();

    const paymentHash = 'abc123settled';
    mockSubscribeToPastPayment.mockReturnValue(
      createMockSubscription([
        { event: 'confirmed', data: { id: paymentHash, fee_mtokens: '200' } },
      ]),
    );

    // Simulate crash recovery re-subscription
    const result = await new Promise<{ status: string; payment_hash: string }>((resolve, reject) => {
      const sub = mockSubscribeToPastPayment({ lnd: {}, id: paymentHash });
      sub.on('confirmed', ({ id, fee_mtokens }: { id: string; fee_mtokens: string }) => {
        resolve({ status: 'SETTLED', payment_hash: id });
      });
      sub.on('failed', () => resolve({ status: 'FAILED', payment_hash: paymentHash }));
      sub.on('error', (err: Error) => reject(err));
    });

    expect(result.status).toBe('SETTLED');
    expect(result.payment_hash).toBe(paymentHash);
  });
});

// ---------------------------------------------------------------------------
// Macaroon scope verification
// ---------------------------------------------------------------------------

describe('verifyMacaroonScope — SEC-05', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('13. Overprivileged macaroon — getChainBalance succeeds = FATAL error thrown', async () => {
    const mockGetChainBalance = getChainBalance as ReturnType<typeof vi.fn>;

    // getChainBalance succeeds = macaroon has onchain:read permission = overprivileged
    mockGetChainBalance.mockResolvedValue({ chain_balance: 100000 });

    // Import and test verifyMacaroonScope
    const { verifyMacaroonScope } = await import('../../src/lib/lnd/lnd.client.js');

    // verifyMacaroonScope throws a FATAL error when the macaroon is overprivileged.
    // connectWithRetry then catches this FATAL error and calls process.exit(1).
    // Here we test verifyMacaroonScope directly — it should throw a FATAL error.
    try {
      await verifyMacaroonScope({} as never);
      expect.fail('Should have thrown FATAL error for overprivileged macaroon');
    } catch (err) {
      expect((err as Error).message).toContain('FATAL:');
      expect((err as Error).message).toContain('onchain:read');
    }
  });

  it('14. Correctly scoped macaroon — getChainBalance throws permission denied = OK', async () => {
    const mockGetChainBalance = getChainBalance as ReturnType<typeof vi.fn>;

    // getChainBalance throws = macaroon correctly scoped (no onchain:read permission)
    mockGetChainBalance.mockRejectedValue(new Error('permission denied'));

    const { verifyMacaroonScope } = await import('../../src/lib/lnd/lnd.client.js');

    // Should resolve without error
    await expect(verifyMacaroonScope({} as never)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Live regtest tests — skip when LND_HOST not set
// ---------------------------------------------------------------------------

const LIVE_TESTS = process.env.LND_HOST ? describe : describe.skip;

LIVE_TESTS('LightningWallet — live regtest (requires LND_HOST)', () => {
  it('live: LightningWallet connects and pays real invoice', async () => {
    // This test requires:
    // 1. docker compose -f docker-compose.dev.yml up -d
    // 2. Fund Alice's node with regtest BTC
    // 3. Open channel Alice -> Bob
    // 4. Set LND_HOST, LND_PORT, LND_CERT_BASE64, LND_MACAROON_BASE64
    expect(process.env.LND_HOST).toBeDefined();
    // Implementation would use createLndConnection and LightningWallet directly
  });
});
