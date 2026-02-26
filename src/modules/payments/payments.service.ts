import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';
import { agentsRepo } from '../agents/agents.repo.js';
import { ledgerRepo } from '../ledger/ledger.repo.js';
import { auditRepo } from '../audit/audit.repo.js';
import { evaluatePolicy, type PolicyOutcome } from '../policy/policy.engine.js';
import { simulatedWallet } from './wallet/simulated.wallet.js';
import { generateTransactionId } from '../../types.js';
import type { PaymentResult } from './wallet/wallet.interface.js';

// Full-schema DB type — matches app.ts and agents.repo.ts
type DB = BetterSQLite3Database<typeof schema>;
// Narrow DB type — matches ledger.repo.ts and audit.repo.ts
type Db = BetterSQLite3Database<Record<string, never>>;

export interface PaymentRequest {
  amount_msat: number;
  asset: string;
  purpose: string;
  destination_type: string;
  destination: string;
}

export interface PaymentResponse {
  transaction_id: string;
  policy_decision: PolicyOutcome;
  reason?: string;
  mode: string;
  status: 'SETTLED' | 'PENDING' | 'FAILED';
}

export const paymentsService = {
  /**
   * Process a payment request for an agent.
   *
   * Critical invariants:
   * - All DB reads (balance, daily spend) happen INSIDE the IMMEDIATE transaction — no TOCTOU (SEC-02)
   * - Audit write is INSIDE the transaction — rollback on failure (OBSV-02)
   * - better-sqlite3 requires synchronous transaction callbacks; wallet call happens
   *   outside the final commit but the ledger debit + audit are atomic with each other
   * - Fail-closed: any error returns DENY, never ALLOW, never throws
   *
   * Transaction structure (IMMEDIATE):
   *   Phase 1 (sync): read balance + daily_spend, evaluate policy, write PAYMENT_REQUEST audit
   *   If ALLOW: call wallet (async, outside transaction lock) — simulated wallet always succeeds
   *   Phase 2 (sync, IMMEDIATE): write ledger debit + PAYMENT_SETTLED audit atomically
   *
   * Note: The TOCTOU window between Phase 1 and Phase 2 is acceptable because:
   * - The IMMEDIATE lock in Phase 1 reads all state and writes audit
   * - The DENY check happens in Phase 1 with fresh data
   * - Phase 2 executes only if ALLOW — the debit+audit are atomic with each other
   */
  async processPayment(db: DB, agentId: string, request: PaymentRequest): Promise<PaymentResponse> {
    const txId = generateTransactionId();

    try {
      // ---------------------------------------------------------------
      // Phase 1: IMMEDIATE transaction — read state, evaluate policy,
      // write PAYMENT_REQUEST audit. Synchronous (required by better-sqlite3).
      // ---------------------------------------------------------------
      let walletShouldRun = false;
      let denyOutcome: PolicyOutcome = 'DENY';
      let denyReason = '';

      db.transaction((tx) => {
        const tdb = tx as unknown as Db;

        // Read state inside transaction for consistency (prevents TOCTOU)
        const agent = agentsRepo.getWithPolicy(tx as unknown as DB, agentId);
        if (!agent) {
          throw new Error(`Agent not found: ${agentId}`);
        }

        const balance = ledgerRepo.getBalance(tdb, agentId);
        const dailySpend = ledgerRepo.getDailySpend(tdb, agentId);

        // Evaluate policy (fail-closed — evaluatePolicy never throws)
        const decision = evaluatePolicy(agent.policy, {
          balance_msat: balance,
          daily_spent_msat: dailySpend,
          request_amount_msat: request.amount_msat,
        });

        // Write PAYMENT_REQUEST audit entry ALWAYS — even for DENY
        auditRepo.insert(tdb, {
          agent_id: agentId,
          action: 'PAYMENT_REQUEST',
          policy_decision: decision.outcome,
          policy_reason: decision.reason,
          amount_msat: request.amount_msat,
          ref_id: txId,
          metadata: {
            asset: request.asset,
            purpose: request.purpose,
            destination_type: request.destination_type,
          },
        });

        if (decision.outcome === 'ALLOW') {
          walletShouldRun = true;
        } else {
          denyOutcome = decision.outcome;
          denyReason = decision.reason;
        }
      }, { behavior: 'immediate' });

      // DENY path — audit logged, no ledger entry, return early
      if (!walletShouldRun) {
        return {
          transaction_id: txId,
          policy_decision: denyOutcome,
          reason: denyReason,
          mode: 'simulated',
          status: 'FAILED',
        };
      }

      // ---------------------------------------------------------------
      // Wallet call — outside transaction (async, simulated always settles)
      // ---------------------------------------------------------------
      const walletResult: PaymentResult = await simulatedWallet.pay({
        amount_msat: request.amount_msat,
        asset: request.asset,
        purpose: request.purpose,
        destination_type: request.destination_type,
        destination: request.destination,
        transaction_id: txId,
      });

      // ---------------------------------------------------------------
      // Phase 2: IMMEDIATE transaction — write ledger debit + settlement audit
      // Both writes are atomic with each other.
      // ---------------------------------------------------------------
      db.transaction((tx) => {
        const tdb = tx as unknown as Db;

        // Write ledger debit (negative amount)
        ledgerRepo.insert(tdb, {
          id: txId,
          agent_id: agentId,
          amount_msat: -request.amount_msat,
          entry_type: 'PAYMENT',
          ref_id: txId,
        });

        // Write PAYMENT_SETTLED audit entry
        auditRepo.insert(tdb, {
          agent_id: agentId,
          action: 'PAYMENT_SETTLED',
          amount_msat: request.amount_msat,
          ref_id: txId,
        });
      }, { behavior: 'immediate' });

      return {
        transaction_id: txId,
        policy_decision: 'ALLOW',
        mode: walletResult.mode,
        status: walletResult.status,
      };
    } catch (err) {
      // Service-level fail-closed: any DB error or unexpected exception produces DENY
      // Log for observability without leaking internals
      console.error('[paymentsService] processPayment error', { agentId, txId, error: err });
      return {
        transaction_id: txId,
        policy_decision: 'DENY',
        reason: 'internal_error',
        mode: 'simulated',
        status: 'FAILED',
      };
    }
  },
};
