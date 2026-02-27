import { eq, and, gt, desc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ledgerEntries } from '../../db/schema.js';

type Db = BetterSQLite3Database<Record<string, never>>;

export interface LedgerEntry {
  id?: string;
  agent_id: string;
  amount_msat: number;
  entry_type: 'DEPOSIT' | 'PAYMENT' | 'REFUND' | 'RESERVE' | 'RELEASE';
  ref_id?: string;
  payment_hash?: string;
  mode?: string;
}

export interface ListOpts {
  cursor?: string;
  limit: number;
  entry_type?: 'DEPOSIT' | 'PAYMENT' | 'REFUND' | 'RESERVE' | 'RELEASE';
}

export const ledgerRepo = {
  /**
   * Insert a ledger entry. If id is not provided, the schema $defaultFn generates it.
   */
  insert(db: Db, entry: LedgerEntry): void {
    db.insert(ledgerEntries).values({
      ...(entry.id ? { id: entry.id } : {}),
      agent_id: entry.agent_id,
      amount_msat: entry.amount_msat,
      entry_type: entry.entry_type,
      ref_id: entry.ref_id ?? null,
      payment_hash: entry.payment_hash ?? null,
      mode: (entry.mode ?? 'simulated') as 'simulated' | 'lightning' | 'cashu',
    }).run();
  },

  /**
   * Return the current balance for an agent as a single integer (millisatoshis).
   * Balance is ALWAYS derived from SUM of ledger_entries — never a mutable counter.
   */
  getBalance(db: Db, agentId: string): number {
    const result = db.select({
      balance: sql<number>`COALESCE(SUM(${ledgerEntries.amount_msat}), 0)`,
    })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.agent_id, agentId))
      .get();
    return result?.balance ?? 0;
  },

  /**
   * Return the rolling 24-hour spend for an agent.
   * Only counts PAYMENT entries (negative amounts) created within the last 86_400_000 ms.
   * Rolling window — no midnight reset.
   */
  getDailySpend(db: Db, agentId: string): number {
    const windowStart = Date.now() - 86_400_000;
    const result = db.select({
      daily_spend: sql<number>`COALESCE(SUM(ABS(${ledgerEntries.amount_msat})), 0)`,
    })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.agent_id, agentId),
          eq(ledgerEntries.entry_type, 'PAYMENT'),
          gt(ledgerEntries.created_at, new Date(windowStart)),
        ),
      )
      .get();
    return result?.daily_spend ?? 0;
  },

  /**
   * Cursor-paginated list of ledger entries for an agent.
   * Cursor is the last seen id; returns entries with id > cursor (descending by id).
   */
  listByAgent(db: Db, agentId: string, opts: ListOpts) {
    const conditions = [eq(ledgerEntries.agent_id, agentId)];
    if (opts.cursor) {
      conditions.push(gt(ledgerEntries.id, opts.cursor));
    }
    if (opts.entry_type) {
      conditions.push(eq(ledgerEntries.entry_type, opts.entry_type));
    }
    return db.select()
      .from(ledgerEntries)
      .where(and(...conditions))
      .orderBy(desc(ledgerEntries.id))
      .limit(opts.limit)
      .all();
  },

  /**
   * Update the payment_hash on an existing ledger entry.
   * Used to record the payment_hash on a RESERVE entry after the 'paying' event fires.
   *
   * @param db - Database connection
   * @param entryId - The ledger entry ID (same as txId for RESERVE entries)
   * @param paymentHash - LND payment hash hex string from 'paying' event
   */
  updatePaymentHash(db: Db, entryId: string, paymentHash: string): void {
    db.update(ledgerEntries)
      .set({ payment_hash: paymentHash })
      .where(eq(ledgerEntries.id, entryId))
      .run();
  },

  /**
   * Return all pending Lightning payments for crash recovery.
   * Returns RESERVE entries with mode='lightning' that have no corresponding
   * RELEASE or PAYMENT entry with the same ref_id.
   * Used at startup to re-subscribe to in-flight HTLCs via TrackPaymentV2.
   */
  getPendingLightningPayments(db: Db): Array<{
    id: string;
    agent_id: string;
    amount_msat: number;
    payment_hash: string | null;
    ref_id: string | null;
  }> {
    return db
      .select({
        id: ledgerEntries.id,
        agent_id: ledgerEntries.agent_id,
        amount_msat: ledgerEntries.amount_msat,
        payment_hash: ledgerEntries.payment_hash,
        ref_id: ledgerEntries.ref_id,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.entry_type, 'RESERVE'),
          eq(ledgerEntries.mode, 'lightning'),
          sql`${ledgerEntries.ref_id} NOT IN (
            SELECT ref_id FROM ${ledgerEntries} AS le2
            WHERE le2.entry_type IN ('RELEASE', 'PAYMENT')
            AND le2.ref_id IS NOT NULL
          )`,
        ),
      )
      .all() as Array<{
        id: string;
        agent_id: string;
        amount_msat: number;
        payment_hash: string | null;
        ref_id: string | null;
      }>;
  },
};
