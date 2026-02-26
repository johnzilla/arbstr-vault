import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';
import { agentsRepo } from '../agents/agents.repo.js';
import { ledgerRepo } from '../ledger/ledger.repo.js';
import { auditRepo } from '../audit/audit.repo.js';
import { evaluatePolicy, type PolicyOutcome } from '../policy/policy.engine.js';
import { simulatedWallet } from './wallet/simulated.wallet.js';
import { generateTransactionId } from '../../types.js';

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
   * - All reads (balance, daily spend) happen INSIDE the transaction — no TOCTOU races (SEC-02)
   * - Audit write is INSIDE the transaction — rollback on failure (OBSV-02)
   * - Uses `{ behavior: 'immediate' }` to acquire a write lock upfront
   * - Fail-closed: any error returns DENY, never ALLOW, never throws
   */
  async processPayment(db: DB, agentId: string, request: PaymentRequest): Promise<PaymentResponse> {
    const txId = generateTransactionId();

    try {
      const result = await db.transaction(async (tx) => {
        // Cast tx to narrower Db type for repos that use Record<string, never>
        const tdb = tx as unknown as Db;

        // Step a: Read state inside transaction for consistency
        // agentsRepo expects full-schema DB — cast back via unknown
        const agent = agentsRepo.getWithPolicy(tx as unknown as DB, agentId);
        if (!agent) {
          // Should never happen — auth verified agent exists
          throw new Error(`Agent not found: ${agentId}`);
        }

        const balance = ledgerRepo.getBalance(tdb, agentId);
        const dailySpend = ledgerRepo.getDailySpend(tdb, agentId);

        // Step b: Evaluate policy (fail-closed — evaluatePolicy never throws)
        const decision = evaluatePolicy(agent.policy, {
          balance_msat: balance,
          daily_spent_msat: dailySpend,
          request_amount_msat: request.amount_msat,
        });

        // Step c: Write PAYMENT_REQUEST audit entry ALWAYS — even for DENY
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

        // Step d: DENY path — return with audit logged, no ledger entry
        if (decision.outcome !== 'ALLOW') {
          return {
            transaction_id: txId,
            policy_decision: decision.outcome,
            reason: decision.reason,
            mode: 'simulated',
            status: 'FAILED' as const,
          };
        }

        // Step e: ALLOW — execute wallet payment
        const walletResult = await simulatedWallet.pay({
          amount_msat: request.amount_msat,
          asset: request.asset,
          purpose: request.purpose,
          destination_type: request.destination_type,
          destination: request.destination,
          transaction_id: txId,
        });

        // Step f: Write ledger debit (negative amount)
        ledgerRepo.insert(tdb, {
          id: txId,
          agent_id: agentId,
          amount_msat: -request.amount_msat,
          entry_type: 'PAYMENT',
          ref_id: txId,
        });

        // Step g: Write PAYMENT_SETTLED audit entry
        auditRepo.insert(tdb, {
          agent_id: agentId,
          action: 'PAYMENT_SETTLED',
          amount_msat: request.amount_msat,
          ref_id: txId,
        });

        // Step h: Return success
        return {
          transaction_id: txId,
          policy_decision: 'ALLOW' as const,
          mode: walletResult.mode,
          status: walletResult.status,
        };
      }, { behavior: 'immediate' });

      return result;
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
