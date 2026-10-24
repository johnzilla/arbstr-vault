// Stale billing reservation sweeper.
//
// arbstr core reserves before calling a provider and settles or releases after.
// If core crashes in between, the RESERVE stays open: it holds the agent's funds
// and counts against the daily limit. expireStale releases those reservations.
//
// Only internal-billing reservations are swept — identified by the PAYMENT_REQUEST
// audit entry /internal/reserve writes with metadata.source = 'internal_billing'.
// Reservations held by /pay approvals, withdrawals and in-flight Lightning payments
// have their own lifecycles and are never touched here.
import { and, eq, lt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ledgerEntries } from '../../db/schema.js';
import { ledgerRepo } from '../ledger/ledger.repo.js';
import { auditRepo } from '../audit/audit.repo.js';

type Db = BetterSQLite3Database<Record<string, never>>;

export interface ExpiredReservation {
  reservation_id: string;
  agent_id: string;
  amount_msat: number;
  age_ms: number;
}

const isOpen = sql`NOT EXISTS (SELECT 1 FROM ledger_entries rel WHERE rel.entry_type = 'RELEASE' AND rel.ref_id = ${ledgerEntries.id})`;

const isInternalBilling = sql`EXISTS (SELECT 1 FROM audit_log a WHERE a.ref_id = ${ledgerEntries.id} AND a.action = 'PAYMENT_REQUEST' AND json_extract(a.metadata, '$.source') = 'internal_billing')`;

export const reservationsService = {
  /**
   * Release internal-billing reservations open for longer than ttlMs.
   * Each release writes RELEASE + RESERVATION_EXPIRED atomically, re-checking that
   * the reservation is still open so a concurrent settle or release wins.
   * A later settle from core gets 409 already_released and moves no funds.
   */
  expireStale(db: Db, ttlMs: number, now: number = Date.now()): ExpiredReservation[] {
    const candidates = db.select({
      id: ledgerEntries.id,
      agent_id: ledgerEntries.agent_id,
      amount_msat: ledgerEntries.amount_msat,
      created_at: ledgerEntries.created_at,
    })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.entry_type, 'RESERVE'),
          lt(ledgerEntries.created_at, new Date(now - ttlMs)),
          isOpen,
          isInternalBilling,
        ),
      )
      .all();

    const expired: ExpiredReservation[] = [];
    for (const r of candidates) {
      const held = Math.abs(r.amount_msat);
      const age_ms = now - r.created_at.getTime();

      const released = db.transaction((tx) => {
        const tdb = tx as unknown as Db;
        const stillOpen = tdb.select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(and(eq(ledgerEntries.id, r.id), isOpen))
          .get();
        if (!stillOpen) return false;

        ledgerRepo.insert(tdb, {
          agent_id: r.agent_id,
          amount_msat: held,
          entry_type: 'RELEASE',
          ref_id: r.id,
          mode: 'simulated',
        });
        auditRepo.insert(tdb, {
          agent_id: r.agent_id,
          action: 'RESERVATION_EXPIRED',
          amount_msat: held,
          ref_id: r.id,
          metadata: { source: 'internal_billing', age_ms, ttl_ms: ttlMs },
        });
        return true;
      }, { behavior: 'immediate' });

      if (released) {
        expired.push({ reservation_id: r.id, agent_id: r.agent_id, amount_msat: held, age_ms });
      }
    }
    return expired;
  },
};
