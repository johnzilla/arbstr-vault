import { inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { cashuProofs, cashuPending } from '../../db/schema.js';

type Db = BetterSQLite3Database<Record<string, never>>;

export type CashuProofRow = {
  id: string;
  keyset_id: string;
  amount: number;
  secret: string;
  C: string;
  created_at: Date;
};

export const cashuRepo = {
  // ---- Proof Pool ----

  /**
   * Store new proofs in the pool (after mint or received as change from melt).
   */
  insertProofs(
    db: Db,
    proofs: Array<{ keyset_id: string; amount: number; secret: string; C: string }>,
    sourceTxId?: string,
  ): void {
    for (const proof of proofs) {
      db.insert(cashuProofs).values({
        keyset_id: proof.keyset_id,
        amount: proof.amount,
        secret: proof.secret,
        C: proof.C,
        source_tx_id: sourceTxId ?? null,
      }).run();
    }
  },

  /**
   * Select proofs summing to >= targetSat from the pool.
   * Uses a greedy approach: sort by amount desc, accumulate until >= target.
   * Throws if pool has insufficient total.
   *
   * NOTE: For melt operations, caller must pass targetSat = meltQuote.amount + meltQuote.fee_reserve.
   * Do NOT pass only meltQuote.amount — fee_reserve must be included (Pitfall 2 in RESEARCH.md).
   */
  selectProofs(
    db: Db,
    targetSat: number,
  ): Array<{ id: string; keyset_id: string; amount: number; secret: string; C: string }> {
    const rows = db
      .select({
        id: cashuProofs.id,
        keyset_id: cashuProofs.keyset_id,
        amount: cashuProofs.amount,
        secret: cashuProofs.secret,
        C: cashuProofs.C,
      })
      .from(cashuProofs)
      .orderBy(sql`${cashuProofs.amount} DESC`)
      .all();

    const selected: typeof rows = [];
    let accumulated = 0;

    for (const row of rows) {
      if (accumulated >= targetSat) break;
      selected.push(row);
      accumulated += row.amount;
    }

    if (accumulated < targetSat) {
      throw new Error('insufficient_cashu_proofs');
    }

    return selected;
  },

  /**
   * Delete proofs by secret (after successful melt — proofs are spent).
   */
  deleteProofs(db: Db, secrets: string[]): void {
    if (secrets.length === 0) return;
    db.delete(cashuProofs).where(inArray(cashuProofs.secret, secrets)).run();
  },

  /**
   * Get all proofs (for keyset rotation check and total pool balance).
   */
  getAllProofs(db: Db): Array<{
    id: string;
    keyset_id: string;
    amount: number;
    secret: string;
    C: string;
    created_at: Date;
  }> {
    return db
      .select({
        id: cashuProofs.id,
        keyset_id: cashuProofs.keyset_id,
        amount: cashuProofs.amount,
        secret: cashuProofs.secret,
        C: cashuProofs.C,
        created_at: cashuProofs.created_at,
      })
      .from(cashuProofs)
      .all() as Array<{
        id: string;
        keyset_id: string;
        amount: number;
        secret: string;
        C: string;
        created_at: Date;
      }>;
  },

  /**
   * Get proofs by keyset ID (for targeted rotation swap).
   */
  getProofsByKeyset(
    db: Db,
    keysetId: string,
  ): Array<{ id: string; keyset_id: string; amount: number; secret: string; C: string }> {
    return db
      .select({
        id: cashuProofs.id,
        keyset_id: cashuProofs.keyset_id,
        amount: cashuProofs.amount,
        secret: cashuProofs.secret,
        C: cashuProofs.C,
      })
      .from(cashuProofs)
      .where(sql`${cashuProofs.keyset_id} = ${keysetId}`)
      .all();
  },

  /**
   * Get total pool balance in sat.
   */
  getPoolBalance(db: Db): number {
    const result = db
      .select({ total: sql<number>`COALESCE(SUM(${cashuProofs.amount}), 0)` })
      .from(cashuProofs)
      .get();
    return result?.total ?? 0;
  },

  // ---- PENDING Lock ----

  /**
   * Lock proofs for a melt/swap operation. Returns false if any proof secret is already locked.
   *
   * Uses UNIQUE constraint on cashu_pending.secret — concurrent insert throws, caught as false.
   * This MUST be called inside a better-sqlite3 synchronous transaction (same transaction that
   * selects and deletes proofs from the pool) to prevent double-spend.
   */
  lockProofs(
    db: Db,
    proofSecrets: string[],
    txId: string,
    meltQuoteId?: string,
  ): boolean {
    try {
      for (const secret of proofSecrets) {
        db.insert(cashuPending).values({
          secret,
          tx_id: txId,
          melt_quote_id: meltQuoteId ?? null,
        }).run();
      }
      return true;
    } catch {
      // UNIQUE constraint violation — at least one proof is already locked (double-spend blocked)
      return false;
    }
  },

  /**
   * Release PENDING lock (on settle or fail).
   */
  releaseProofs(db: Db, proofSecrets: string[]): void {
    if (proofSecrets.length === 0) return;
    db.delete(cashuPending).where(inArray(cashuPending.secret, proofSecrets)).run();
  },

  /**
   * Get all PENDING operations (for crash recovery).
   */
  getPendingOperations(db: Db): Array<{
    secret: string;
    tx_id: string;
    melt_quote_id: string | null;
    created_at: Date;
  }> {
    return db
      .select({
        secret: cashuPending.secret,
        tx_id: cashuPending.tx_id,
        melt_quote_id: cashuPending.melt_quote_id,
        created_at: cashuPending.created_at,
      })
      .from(cashuPending)
      .all() as Array<{
        secret: string;
        tx_id: string;
        melt_quote_id: string | null;
        created_at: Date;
      }>;
  },
};
