import { eq, and, gt, gte, lte, desc, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { auditLog } from '../../db/schema.js';

type Db = BetterSQLite3Database<Record<string, never>>;

type AuditAction =
  | 'AGENT_REGISTERED'
  | 'POLICY_UPDATED'
  | 'PAYMENT_REQUEST'
  | 'PAYMENT_SETTLED'
  | 'PAYMENT_FAILED'
  | 'DEPOSIT'
  | 'CASHU_MINT'
  | 'CASHU_MELT'
  | 'CASHU_KEYSET_SWAP'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_TIMEOUT'
  | 'WITHDRAWAL_REQUESTED'
  | 'WITHDRAWAL_COMPLETED'
  | 'WEBHOOK_DELIVERY_FAILED'
  | 'BALANCE_ALERT';

export interface AuditEntry {
  agent_id: string;
  action: AuditAction;
  policy_decision?: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL';
  policy_reason?: string;
  amount_msat?: number;
  ref_id?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditListOpts {
  cursor?: string;
  limit: number;
  action_type?: AuditAction;
  start_date?: number; // created_at as integer ms
  end_date?: number;   // created_at as integer ms
}

export const auditRepo = {
  /**
   * Append an audit log entry.
   * This is the ONLY write operation — no update, no delete.
   * The append-only invariant is enforced by the module's API surface.
   */
  insert(db: Db, entry: AuditEntry): void {
    db.insert(auditLog).values({
      agent_id: entry.agent_id,
      action: entry.action,
      policy_decision: entry.policy_decision ?? null,
      policy_reason: entry.policy_reason ?? null,
      amount_msat: entry.amount_msat ?? null,
      ref_id: entry.ref_id ?? null,
      metadata: entry.metadata ?? null,
    }).run();
  },

  /**
   * Cursor-paginated list of audit log entries for an agent.
   * Optional filters: action_type, start_date (ms), end_date (ms).
   * Used by the history endpoint.
   */
  listByAgent(db: Db, agentId: string, opts: AuditListOpts) {
    const conditions = [eq(auditLog.agent_id, agentId)];
    if (opts.cursor) {
      conditions.push(gt(auditLog.id, opts.cursor));
    }
    if (opts.action_type) {
      conditions.push(eq(auditLog.action, opts.action_type));
    }
    if (opts.start_date !== undefined) {
      conditions.push(gte(auditLog.created_at, new Date(opts.start_date)));
    }
    if (opts.end_date !== undefined) {
      conditions.push(lte(auditLog.created_at, new Date(opts.end_date)));
    }
    return db.select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.id))
      .limit(opts.limit)
      .all();
  },

  /**
   * Get the timestamp of the most recent PAYMENT_SETTLED or PAYMENT_FAILED audit entry for an agent.
   * Returns the ISO string, or null if no payments have been processed.
   * Used by the operator dashboard (Plan 03) for last_payment_at field.
   */
  getLastPaymentTimestamp(db: Db, agentId: string): string | null {
    const row = db.select({ created_at: auditLog.created_at })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.agent_id, agentId),
          inArray(auditLog.action, ['PAYMENT_SETTLED', 'PAYMENT_FAILED']),
        ),
      )
      .orderBy(desc(auditLog.created_at))
      .limit(1)
      .get();
    return row?.created_at ? row.created_at.toISOString() : null;
  },
};
