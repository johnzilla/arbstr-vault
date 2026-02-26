import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ledgerRepo } from './ledger.repo.js';
import { auditRepo } from '../audit/audit.repo.js';

// Use the minimal-schema database type (Record<string, never>) which satisfies
// TablesRelationalConfig and is compatible with both the db instance and tx objects.
type Db = BetterSQLite3Database<Record<string, never>>;

export const ledgerService = {
  /**
   * Get current balance for an agent (millisatoshis).
   * Always derived from SUM of ledger entries — never a mutable counter.
   */
  getBalance(db: Db, agentId: string): number {
    return ledgerRepo.getBalance(db, agentId);
  },

  /**
   * Get rolling 24-hour spend for an agent (millisatoshis).
   * Rolling window, not midnight-reset.
   */
  getDailySpend(db: Db, agentId: string): number {
    return ledgerRepo.getDailySpend(db, agentId);
  },

  /**
   * Deposit funds for an agent.
   * Runs inside its own immediate transaction:
   *   1. Inserts a DEPOSIT ledger entry (positive amount)
   *   2. Inserts a DEPOSIT audit log entry
   * Returns the new balance after the deposit.
   */
  deposit(db: Db, agentId: string, amount_msat: number): number {
    db.transaction((tx) => {
      ledgerRepo.insert(tx as Db, {
        agent_id: agentId,
        amount_msat: amount_msat,
        entry_type: 'DEPOSIT',
      });
      auditRepo.insert(tx as Db, {
        agent_id: agentId,
        action: 'DEPOSIT',
        amount_msat: amount_msat,
      });
    }, { behavior: 'immediate' });
    return ledgerRepo.getBalance(db, agentId);
  },

  /**
   * Debit funds from an agent's account.
   * Inserts a PAYMENT ledger entry with a NEGATIVE amount_msat.
   * Does NOT start its own transaction — caller (payment service) wraps this in their transaction.
   * Accepts a tx (drizzle transaction object) rather than db.
   */
  debit(tx: Db, agentId: string, amount_msat: number, refId: string): void {
    ledgerRepo.insert(tx, {
      agent_id: agentId,
      amount_msat: -amount_msat, // stored as negative to reduce balance
      entry_type: 'PAYMENT',
      ref_id: refId,
    });
  },
};
