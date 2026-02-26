import { eq, and, gt, desc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ledgerEntries } from '../../db/schema.js';

type Db = BetterSQLite3Database<Record<string, never>>;

export interface LedgerEntry {
  id?: string;
  agent_id: string;
  amount_msat: number;
  entry_type: 'DEPOSIT' | 'PAYMENT' | 'REFUND';
  ref_id?: string;
}

export interface ListOpts {
  cursor?: string;
  limit: number;
  entry_type?: 'DEPOSIT' | 'PAYMENT' | 'REFUND';
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
};
