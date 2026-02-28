import { eq, and, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { pendingApprovals } from '../../db/schema.js';
import { sql } from 'drizzle-orm';

type Db = BetterSQLite3Database<Record<string, never>>;

export interface CreateApprovalValues {
  agent_id: string;
  type: 'payment' | 'withdrawal';
  transaction_id: string;
  amount_msat: number;
  destination?: string | null;
  expires_at: Date;
}

export const approvalsRepo = {
  /**
   * Insert a new pending_approvals row.
   * Returns the inserted row via .returning().get().
   */
  create(db: Db, values: CreateApprovalValues) {
    return db
      .insert(pendingApprovals)
      .values({
        agent_id: values.agent_id,
        type: values.type,
        transaction_id: values.transaction_id,
        amount_msat: values.amount_msat,
        destination: values.destination ?? null,
        expires_at: values.expires_at,
        status: 'pending',
      })
      .returning()
      .get();
  },

  /**
   * Find a pending_approval row by its primary key.
   * Returns the row or undefined if not found.
   */
  findById(db: Db, id: string) {
    return db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.id, id))
      .get();
  },

  /**
   * Find a pending_approval row by the transaction_id.
   * Used by payment-status route to distinguish PENDING_APPROVAL from PENDING.
   */
  findByTransactionId(db: Db, transactionId: string) {
    return db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.transaction_id, transactionId))
      .get();
  },

  /**
   * Atomic CAS (Compare-And-Swap) update.
   * Updates status to newStatus ONLY IF the current status is 'pending'.
   * This prevents race conditions between manual resolution and timeout checker.
   *
   * Returns the updated row if CAS succeeded, undefined if already resolved.
   */
  claimForResolution(db: Db, id: string, newStatus: 'approved' | 'denied' | 'timed_out') {
    return db
      .update(pendingApprovals)
      .set({ status: newStatus, resolved_at: new Date() })
      .where(
        and(
          eq(pendingApprovals.id, id),
          eq(pendingApprovals.status, 'pending'),
        ),
      )
      .returning()
      .get();
  },

  /**
   * Find all pending approvals that have expired (expires_at <= now).
   * Used by the timeout checker in index.ts.
   */
  findExpired(db: Db) {
    return db
      .select()
      .from(pendingApprovals)
      .where(
        and(
          eq(pendingApprovals.status, 'pending'),
          lte(pendingApprovals.expires_at, new Date()),
        ),
      )
      .all();
  },

  /**
   * Count pending approvals for an agent.
   * Used by the operator dashboard (Plan 03).
   */
  countPending(db: Db, agentId: string): number {
    const result = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(pendingApprovals)
      .where(
        and(
          eq(pendingApprovals.agent_id, agentId),
          eq(pendingApprovals.status, 'pending'),
        ),
      )
      .get();
    return result?.count ?? 0;
  },

  /**
   * List all pending approvals (used by operator dashboard).
   */
  listPending(db: Db) {
    return db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.status, 'pending'))
      .all();
  },
};
