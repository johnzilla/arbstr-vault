import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { WalletBackend, PaymentRequest, PaymentResult } from './wallet.interface.js';
import type { CashuClient } from '../../../lib/cashu/cashu.client.js';
import { cashuRepo } from '../../cashu/cashu.repo.js';
import type { Proof } from '../../../lib/cashu/cashu.client.js';
import { MeltQuoteState } from '@cashu/cashu-ts';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * CashuWalletBackend — implements WalletBackend via Cashu ecash melt operations.
 *
 * Melt flow (paying a Lightning invoice via Cashu proofs):
 * 1. Get melt quote (amount + fee_reserve in sat)
 * 2. Select proofs from pool for (amount + fee_reserve) sat
 * 3. Inside synchronous better-sqlite3 transaction:
 *    - Lock proofs (PENDING) — prevents double-spend
 *    - Delete selected proofs from pool (they are about to be spent)
 * 4. Call meltProofs (async, OUTSIDE transaction)
 * 5. On PAID: release lock, store change proofs back in pool, return SETTLED
 * 6. On failure: release lock, restore proofs back to pool, return FAILED
 *
 * The synchronous select + lock + delete (step 3) is the Cashu equivalent of the
 * Lightning RESERVE pattern from Phase 2. It prevents concurrent double-spend of
 * the same proofs by using the UNIQUE constraint on cashu_pending.secret.
 *
 * IMPORTANT: Cashu amounts are in SATS, not msats.
 * Convert msat to sat with Math.ceil(msat / 1000) before proof selection.
 */
export class CashuWalletBackend implements WalletBackend {
  private readonly cashuClient: CashuClient;
  private readonly db: Db;

  constructor(cashuClient: CashuClient, db: Db) {
    this.cashuClient = cashuClient;
    this.db = db;
  }

  async pay(req: PaymentRequest): Promise<PaymentResult> {
    // Cashu uses sats, WalletBackend interface uses msat
    const amountSat = Math.ceil(req.amount_msat / 1000);

    // -----------------------------------------------------------------------
    // Step 1: Get melt quote — includes amount and fee_reserve in sat
    // -----------------------------------------------------------------------
    let meltQuote: Awaited<ReturnType<CashuClient['createMeltQuote']>>;
    try {
      meltQuote = await this.cashuClient.createMeltQuote(req.destination);
    } catch (err) {
      return {
        transaction_id: req.transaction_id,
        status: 'FAILED',
        mode: 'cashu',
        rail_used: 'cashu',
      };
    }

    // Total needed in sat: invoice amount + fee_reserve (Pitfall 2 from RESEARCH.md)
    const totalNeededSat = meltQuote.amount + meltQuote.fee_reserve;

    // -----------------------------------------------------------------------
    // Step 2: Check pool balance — return FAILED early if insufficient
    // -----------------------------------------------------------------------
    const poolBalance = cashuRepo.getPoolBalance(this.db);
    if (poolBalance < totalNeededSat) {
      return {
        transaction_id: req.transaction_id,
        status: 'FAILED',
        mode: 'cashu',
        rail_used: 'cashu',
        // Pool insufficient — caller should fund via Lightning mint before retrying
      };
    }

    // -----------------------------------------------------------------------
    // Step 3: Select proofs + lock + delete — all inside a single synchronous
    // better-sqlite3 transaction (Pitfall 3 from RESEARCH.md)
    // -----------------------------------------------------------------------
    let selectedProofs: Array<{ id: string; keyset_id: string; amount: number; secret: string; C: string }>;
    let lockSucceeded = false;

    try {
      this.db.transaction((tx) => {
        // Select proofs summing to >= totalNeededSat
        selectedProofs = cashuRepo.selectProofs(tx as unknown as Db, totalNeededSat);

        const proofSecrets = selectedProofs.map((p) => p.secret);

        // Lock proofs in PENDING table — returns false if any secret already locked
        const locked = cashuRepo.lockProofs(
          tx as unknown as Db,
          proofSecrets,
          String(req.transaction_id),
          meltQuote.quote,
        );

        if (!locked) {
          // Concurrent request already locked these proofs — abort transaction
          throw new Error('proofs_already_locked');
        }

        // Remove proofs from pool before melt (they will be re-inserted if melt fails)
        cashuRepo.deleteProofs(tx as unknown as Db, proofSecrets);

        lockSucceeded = true;
      }, { behavior: 'immediate' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message === 'proofs_already_locked') {
        return {
          transaction_id: req.transaction_id,
          status: 'FAILED',
          mode: 'cashu',
          rail_used: 'cashu',
        };
      }

      if (message === 'insufficient_cashu_proofs') {
        return {
          transaction_id: req.transaction_id,
          status: 'FAILED',
          mode: 'cashu',
          rail_used: 'cashu',
        };
      }

      // Unexpected transaction error
      return {
        transaction_id: req.transaction_id,
        status: 'FAILED',
        mode: 'cashu',
        rail_used: 'cashu',
      };
    }

    if (!lockSucceeded || !selectedProofs!) {
      return {
        transaction_id: req.transaction_id,
        status: 'FAILED',
        mode: 'cashu',
        rail_used: 'cashu',
      };
    }

    const proofSecrets = selectedProofs.map((p) => p.secret);

    // Convert DB proof rows to cashu-ts Proof objects
    const proofsForCashuTs: Proof[] = selectedProofs.map((p) => ({
      id: p.keyset_id,
      amount: p.amount,
      secret: p.secret,
      C: p.C,
    }));

    // -----------------------------------------------------------------------
    // Step 4: Execute melt (async, OUTSIDE the transaction)
    // -----------------------------------------------------------------------
    let meltResult: Awaited<ReturnType<CashuClient['meltProofs']>>;
    try {
      meltResult = await this.cashuClient.meltProofs(meltQuote, proofsForCashuTs);
    } catch (meltErr) {
      // Melt threw an exception — release lock and restore proofs to pool
      cashuRepo.releaseProofs(this.db, proofSecrets);
      cashuRepo.insertProofs(
        this.db,
        selectedProofs.map((p) => ({
          keyset_id: p.keyset_id,
          amount: p.amount,
          secret: p.secret,
          C: p.C,
        })),
      );
      return {
        transaction_id: req.transaction_id,
        status: 'FAILED',
        mode: 'cashu',
        rail_used: 'cashu',
      };
    }

    // -----------------------------------------------------------------------
    // Step 5 / 6: Handle melt result
    // -----------------------------------------------------------------------
    if (meltResult.quote.state === MeltQuoteState.PAID) {
      // SUCCESS — release PENDING lock
      cashuRepo.releaseProofs(this.db, proofSecrets);

      // Store change proofs back in pool (from fee_reserve overpayment)
      // Defensive: handle absent or empty change array
      if (meltResult.change && meltResult.change.length > 0) {
        cashuRepo.insertProofs(
          this.db,
          meltResult.change.map((cp) => ({
            keyset_id: cp.id,
            amount: cp.amount,
            secret: cp.secret,
            C: cp.C,
          })),
          String(req.transaction_id),
        );
      }

      // Calculate actual fee paid: fee_reserve - change_amount
      const changeAmountSat = meltResult.change
        ? meltResult.change.reduce((sum, cp) => sum + cp.amount, 0)
        : 0;
      const actualFeeSat = meltQuote.fee_reserve - changeAmountSat;
      const actualFeeMsat = actualFeeSat * 1000;

      return {
        transaction_id: req.transaction_id,
        status: 'SETTLED',
        mode: 'cashu',
        rail_used: 'cashu',
        settled_at: new Date(),
        // First proof secret as a Cashu token reference
        cashu_token_id: proofSecrets[0],
        fee_msat: actualFeeMsat >= 0 ? actualFeeMsat : 0,
      };
    }

    // FAILED or PENDING state from mint — release lock and restore proofs
    cashuRepo.releaseProofs(this.db, proofSecrets);
    cashuRepo.insertProofs(
      this.db,
      selectedProofs.map((p) => ({
        keyset_id: p.keyset_id,
        amount: p.amount,
        secret: p.secret,
        C: p.C,
      })),
    );

    return {
      transaction_id: req.transaction_id,
      status: 'FAILED',
      mode: 'cashu',
      rail_used: 'cashu',
    };
  }
}
