import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';
import { agentsRepo } from '../agents/agents.repo.js';
import { ledgerRepo } from '../ledger/ledger.repo.js';
import { auditRepo } from '../audit/audit.repo.js';
import { evaluatePolicy, type PolicyOutcome } from '../policy/policy.engine.js';
import { simulatedWallet } from './wallet/simulated.wallet.js';
import type { WalletBackend } from './wallet/wallet.interface.js';
import { LightningStreamError } from './wallet/lightning.wallet.js';
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
  payment_hash?: string;
  fee_msat?: number;
}

/**
 * Factory that creates a payments service bound to a specific wallet backend.
 *
 * This replaces the old singleton pattern so the wallet can be injected at
 * startup (simulated or lightning) without module-level side effects.
 *
 * @param wallet - WalletBackend to use for payment execution
 * @returns paymentsService-compatible object
 */
export function createPaymentsService(wallet: WalletBackend) {
  return {
    /**
     * Process a payment request for an agent.
     *
     * Critical invariants:
     * - All DB reads (balance, daily_spend) happen INSIDE the IMMEDIATE transaction — no TOCTOU (SEC-02)
     * - Audit write is INSIDE the transaction — rollback on failure (OBSV-02)
     * - better-sqlite3 requires synchronous transaction callbacks; wallet call happens
     *   outside the final commit but the ledger debit + audit are atomic with each other
     * - Fail-closed: any error returns DENY, never ALLOW, never throws
     *
     * Lightning payment transaction structure (RESERVE/RELEASE pattern, SEC-04):
     *   Phase 1 (sync IMMEDIATE): read balance + daily_spend, evaluate policy, write PAYMENT_REQUEST audit
     *   Phase 1.5 (sync IMMEDIATE): write RESERVE ledger entry (-amount_msat) before wallet call
     *   Wallet call (async): subscribeToPayViaRequest — captures payment_hash in 'paying' event
     *   Phase 2 — on SETTLED: write PAYMENT_SETTLED audit + FEE debit if fee_msat > 0
     *   Phase 2 — on FAILED: write RELEASE entry (+amount_msat) + PAYMENT_FAILED audit
     *   Phase 2 — on stream error (LightningStreamError): keep PENDING — payment may be in-flight
     *
     * Simulated payment structure (unchanged from Phase 1):
     *   Phase 1 (sync IMMEDIATE): read state, evaluate policy, write PAYMENT_REQUEST audit
     *   Wallet call (async): simulatedWallet.pay() — always settles
     *   Phase 2 (sync IMMEDIATE): write PAYMENT ledger debit + PAYMENT_SETTLED audit atomically
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
        let policyMaxFeeMsat = 1000; // default: 1 sat
        const isLightning = wallet !== simulatedWallet;

        db.transaction((tx) => {
          const tdb = tx as unknown as Db;

          // Read state inside transaction for consistency (prevents TOCTOU)
          const agent = agentsRepo.getWithPolicy(tx as unknown as DB, agentId);
          if (!agent) {
            throw new Error(`Agent not found: ${agentId}`);
          }

          const balance = ledgerRepo.getBalance(tdb, agentId);
          const dailySpend = ledgerRepo.getDailySpend(tdb, agentId);

          // Capture max_fee_msat from policy for Lightning routing fee limit (default: 1 sat)
          if (agent.policy?.max_fee_msat != null) {
            policyMaxFeeMsat = agent.policy.max_fee_msat;
          }

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
            mode: isLightning ? 'lightning' : 'simulated',
            status: 'FAILED',
          };
        }

        // ---------------------------------------------------------------
        // Phase 1.5 (Lightning ONLY): Write RESERVE ledger entry BEFORE
        // calling the wallet. This debits the balance immediately and
        // ensures crash recovery can detect the in-flight payment (SEC-04).
        //
        // Key invariant: if Treasury crashes between Phase 1.5 and the wallet
        // call, the RESERVE entry has no payment_hash — crash recovery treats
        // this as a failed payment and writes RELEASE.
        //
        // If Treasury crashes after the wallet call but before Phase 2,
        // the RESERVE entry will have a payment_hash (written by the wallet's
        // 'paying' handler) — crash recovery re-subscribes via subscribeToPastPayment.
        // ---------------------------------------------------------------
        if (isLightning) {
          db.transaction((tx) => {
            const tdb = tx as unknown as Db;
            ledgerRepo.insert(tdb, {
              id: txId,
              agent_id: agentId,
              amount_msat: -request.amount_msat,
              entry_type: 'RESERVE',
              ref_id: txId,
              mode: 'lightning',
            });
          }, { behavior: 'immediate' });
        }

        // ---------------------------------------------------------------
        // Wallet call — outside transaction (async)
        // ---------------------------------------------------------------
        let walletResult: PaymentResult;
        try {
          walletResult = await wallet.pay({
            amount_msat: request.amount_msat,
            asset: request.asset,
            purpose: request.purpose,
            destination_type: request.destination_type,
            destination: request.destination,
            transaction_id: txId,
            max_fee_msat: policyMaxFeeMsat,
          });
        } catch (walletErr) {
          // Handle LightningStreamError (gRPC disconnect) — keep PENDING
          if (walletErr instanceof LightningStreamError) {
            // Payment may still be in-flight — do NOT write RELEASE
            // Update the RESERVE entry's payment_hash if captured by the wallet
            if (walletErr.payment_hash) {
              db.transaction((tx) => {
                const tdb = tx as unknown as Db;
                ledgerRepo.updatePaymentHash(tdb, txId, walletErr.payment_hash!);
              }, { behavior: 'immediate' });
            }
            return {
              transaction_id: txId,
              policy_decision: 'ALLOW',
              mode: 'lightning',
              status: 'PENDING',
              payment_hash: walletErr.payment_hash,
            };
          }
          // Non-stream errors: re-throw to be caught by outer try/catch
          throw walletErr;
        }

        // ---------------------------------------------------------------
        // Phase 2: Process wallet result
        // ---------------------------------------------------------------

        if (walletResult.status === 'SETTLED') {
          if (isLightning) {
            // Lightning SETTLED:
            // - RESERVE already debited the principal amount
            // - Write PAYMENT_SETTLED audit
            // - If fee > 0, write separate FEE debit ledger entry
            db.transaction((tx) => {
              const tdb = tx as unknown as Db;

              // Update RESERVE entry's payment_hash for audit trail
              if (walletResult.payment_hash) {
                ledgerRepo.updatePaymentHash(tdb, txId, walletResult.payment_hash);
              }

              // Write PAYMENT_SETTLED audit
              auditRepo.insert(tdb, {
                agent_id: agentId,
                action: 'PAYMENT_SETTLED',
                amount_msat: request.amount_msat,
                ref_id: txId,
                metadata: {
                  payment_hash: walletResult.payment_hash ?? null,
                  fee_msat: walletResult.fee_msat ?? 0,
                },
              });

              // Write routing fee debit (separate entry so balance math is clear)
              if (walletResult.fee_msat && walletResult.fee_msat > 0) {
                ledgerRepo.insert(tdb, {
                  agent_id: agentId,
                  amount_msat: -walletResult.fee_msat,
                  entry_type: 'PAYMENT',
                  ref_id: txId,
                  payment_hash: walletResult.payment_hash,
                  mode: 'lightning',
                });
              }
            }, { behavior: 'immediate' });
          } else {
            // Simulated SETTLED: keep existing behavior (ledger debit + audit atomically)
            db.transaction((tx) => {
              const tdb = tx as unknown as Db;

              ledgerRepo.insert(tdb, {
                id: txId,
                agent_id: agentId,
                amount_msat: -request.amount_msat,
                entry_type: 'PAYMENT',
                ref_id: txId,
              });

              auditRepo.insert(tdb, {
                agent_id: agentId,
                action: 'PAYMENT_SETTLED',
                amount_msat: request.amount_msat,
                ref_id: txId,
              });
            }, { behavior: 'immediate' });
          }

          return {
            transaction_id: txId,
            policy_decision: 'ALLOW',
            mode: walletResult.mode,
            status: walletResult.status,
            payment_hash: walletResult.payment_hash,
            fee_msat: walletResult.fee_msat,
          };
        }

        if (walletResult.status === 'FAILED') {
          // Lightning FAILED: write RELEASE + PAYMENT_FAILED audit
          // (Only Lightning can return FAILED — simulated always returns SETTLED)
          db.transaction((tx) => {
            const tdb = tx as unknown as Db;

            // RELEASE credits back the reserved amount
            ledgerRepo.insert(tdb, {
              agent_id: agentId,
              amount_msat: request.amount_msat,
              entry_type: 'RELEASE',
              ref_id: txId,
              payment_hash: walletResult.payment_hash,
              mode: 'lightning',
            });

            // Write PAYMENT_FAILED audit with failure details
            auditRepo.insert(tdb, {
              agent_id: agentId,
              action: 'PAYMENT_FAILED',
              amount_msat: request.amount_msat,
              ref_id: txId,
              metadata: {
                payment_hash: walletResult.payment_hash ?? null,
                // failure_reason is stored in the result metadata for audit
              },
            });
          }, { behavior: 'immediate' });

          return {
            transaction_id: txId,
            policy_decision: 'ALLOW',
            mode: walletResult.mode,
            status: 'FAILED',
            payment_hash: walletResult.payment_hash,
          };
        }

        // PENDING status (unusual for direct wallet call — should only come from stream error path above)
        return {
          transaction_id: txId,
          policy_decision: 'ALLOW',
          mode: walletResult.mode,
          status: 'PENDING',
          payment_hash: walletResult.payment_hash,
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
}

// Backward-compatible default singleton using simulated wallet
// All existing tests and routes that import { paymentsService } directly continue to work
export const paymentsService = createPaymentsService(simulatedWallet);
