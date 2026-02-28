import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';
import { agentsRepo, policyVersionsRepo } from '../agents/agents.repo.js';
import { ledgerRepo } from '../ledger/ledger.repo.js';
import { auditRepo } from '../audit/audit.repo.js';
import { approvalsRepo } from '../approvals/approvals.repo.js';
import { webhookService } from '../webhook/webhook.service.js';
import { evaluatePolicy, type PolicyOutcome } from '../policy/policy.engine.js';
import { simulatedWallet } from './wallet/simulated.wallet.js';
import type { WalletBackend } from './wallet/wallet.interface.js';
import { LightningStreamError } from './wallet/lightning.wallet.js';
import { generateTransactionId } from '../../types.js';
import type { PaymentResult } from './wallet/wallet.interface.js';
import { config } from '../../config.js';
import { alertsService } from '../alerts/alerts.service.js';

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
  /** Optional agent hint to prefer a specific payment rail (overrides threshold routing) */
  preferred_rail?: 'lightning' | 'cashu';
}

export interface PaymentResponse {
  transaction_id: string;
  policy_decision: PolicyOutcome;
  reason?: string;
  mode: string;
  status: 'SETTLED' | 'PENDING' | 'FAILED' | 'PENDING_APPROVAL';
  payment_hash?: string;
  fee_msat?: number;
  cashu_token_id?: string;
  rail_used?: 'lightning' | 'cashu';
  initial_rail?: 'lightning' | 'cashu';
  final_rail?: 'lightning' | 'cashu';
  fallback_occurred?: boolean;
}

export interface PaymentsServiceOptions {
  lightningWallet?: WalletBackend;
  cashuWallet?: WalletBackend;
  simulatedWallet: WalletBackend;
}

/**
 * Selects the payment rail based on amount, agent hint, and available wallets.
 *
 * Routing rules (in priority order):
 * 1. If only simulated wallet available — always simulated
 * 2. If only one rail available — use that rail
 * 3. Agent preferred_rail hint overrides threshold routing
 * 4. Amount-threshold routing: under threshold -> Cashu, at/above -> Lightning
 *
 * NOT exported — internal to the payments service.
 */
function selectRail(
  amountMsat: number,
  preferredRail: 'lightning' | 'cashu' | undefined,
  thresholdMsat: number,
  hasLightning: boolean,
  hasCashu: boolean,
): 'lightning' | 'cashu' | 'simulated' {
  // If neither real rail available, fall back to simulated
  if (!hasLightning && !hasCashu) return 'simulated';
  // If only one rail available, use it
  if (!hasCashu) return 'lightning';
  if (!hasLightning) return 'cashu';

  // Agent hint overrides automatic routing
  if (preferredRail) return preferredRail;

  // Amount-threshold routing:
  // Under threshold -> Cashu (small payments via ecash), at or above -> Lightning
  return amountMsat < thresholdMsat ? 'cashu' : 'lightning';
}

/**
 * Returns true if a fallback to the other rail is possible.
 */
function canFallback(
  initialRail: 'lightning' | 'cashu' | 'simulated',
  options: PaymentsServiceOptions,
): boolean {
  if (initialRail === 'simulated') return false;
  if (initialRail === 'lightning') return !!options.cashuWallet;
  if (initialRail === 'cashu') return !!options.lightningWallet;
  return false;
}

/**
 * Factory that creates a payments service bound to a specific wallet backend.
 *
 * Supports two call signatures:
 * 1. Single WalletBackend (backward-compatible): createPaymentsService(wallet)
 * 2. Options object with dual wallets: createPaymentsService({ lightningWallet, cashuWallet, simulatedWallet })
 *
 * When both lightningWallet and cashuWallet are provided, payments are automatically
 * routed based on the amount threshold (CASHU_THRESHOLD_MSAT config). The agent can
 * also specify preferred_rail to override automatic routing. If the primary rail fails,
 * the service automatically falls back to the other rail.
 *
 * @param walletOrOptions - WalletBackend (backward-compat) or PaymentsServiceOptions
 * @returns paymentsService-compatible object
 */
export function createPaymentsService(walletOrOptions: WalletBackend | PaymentsServiceOptions) {
  // Normalize to options format.
  //
  // Backward compat for single-wallet callers (used by existing tests and legacy code):
  // - If the passed wallet IS the simulatedWallet singleton, use it as-is in the simulated slot.
  // - If the passed wallet is NOT simulatedWallet (i.e. a custom/lightning wallet), treat it as
  //   lightningWallet — this preserves the old `isLightning = wallet !== simulatedWallet` semantic.
  const options: PaymentsServiceOptions = 'pay' in walletOrOptions
    ? (walletOrOptions === simulatedWallet
        ? { simulatedWallet: walletOrOptions as WalletBackend }
        : { simulatedWallet, lightningWallet: walletOrOptions as WalletBackend })
    : walletOrOptions as PaymentsServiceOptions;

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
     * Cashu payment transaction structure:
     *   Phase 1 (sync IMMEDIATE): read state, evaluate policy, write PAYMENT_REQUEST audit
     *   Wallet call (async): CashuWalletBackend.pay() — selects+locks+deletes proofs in sync tx, then melts
     *   Phase 2 — on SETTLED: write PAYMENT ledger debit + PAYMENT_SETTLED audit
     *   Phase 2 — on FAILED: write PAYMENT_FAILED audit (CashuWalletBackend already restores proofs)
     *
     * Simulated payment structure (unchanged from Phase 1):
     *   Phase 1 (sync IMMEDIATE): read state, evaluate policy, write PAYMENT_REQUEST audit
     *   Wallet call (async): simulatedWallet.pay() — always settles
     *   Phase 2 (sync IMMEDIATE): write PAYMENT ledger debit + PAYMENT_SETTLED audit atomically
     *
     * Dual-rail routing:
     *   - selectRail() determines primary rail based on amount and optional preferred_rail hint
     *   - If primary rail returns FAILED (and a fallback rail exists), try the other rail
     *   - Routing trace (initial_rail, final_rail, fallback_occurred) written to audit metadata
     */
    async processPayment(db: DB, agentId: string, request: PaymentRequest): Promise<PaymentResponse> {
      const txId = generateTransactionId();
      // Capture timestamp BEFORE Phase 1 transaction for point-in-time policy lookup (PLCY-09)
      const requestTimestamp = Date.now();

      try {
        // ---------------------------------------------------------------
        // Phase 1: IMMEDIATE transaction — read state, evaluate policy,
        // write PAYMENT_REQUEST audit. Synchronous (required by better-sqlite3).
        // ---------------------------------------------------------------
        let walletShouldRun = false;
        let denyOutcome: PolicyOutcome = 'DENY';
        let denyReason = '';
        let policyMaxFeeMsat = 1000; // default: 1 sat
        let approvalTimeoutMs = 300_000; // default: 5 minutes

        const hasLightning = !!options.lightningWallet;
        const hasCashu = !!options.cashuWallet;
        const isDualRail = hasLightning && hasCashu;

        // Determine routing before the DB transaction (no I/O — pure logic)
        const initialRail = selectRail(
          request.amount_msat,
          request.preferred_rail,
          config.CASHU_THRESHOLD_MSAT,
          hasLightning,
          hasCashu,
        );

        db.transaction((tx) => {
          const tdb = tx as unknown as Db;

          // Read agent (without policy join — policy comes from point-in-time lookup below)
          const agent = agentsRepo.findById(tx as unknown as DB, agentId);
          if (!agent) {
            throw new Error(`Agent not found: ${agentId}`);
          }

          // Point-in-time policy version lookup (PLCY-09)
          // Uses requestTimestamp captured before the transaction for correct versioning.
          // Falls back to legacy policies table if no policy_versions rows exist (backward compat).
          const policyVersion = policyVersionsRepo.getVersionAt(
            tx as unknown as DB,
            agentId,
            requestTimestamp,
          );

          // Resolve the effective policy config for evaluation.
          // policyVersion takes precedence; legacy agentsRepo.getWithPolicy fallback for existing tests
          // that only insert into the policies table (not policy_versions).
          let effectivePolicy: { max_transaction_msat: number; daily_limit_msat: number; max_fee_msat?: number | null; approval_timeout_ms?: number | null } | null = policyVersion;
          if (!effectivePolicy) {
            const agentWithPolicy = agentsRepo.getWithPolicy(tx as unknown as DB, agentId);
            effectivePolicy = agentWithPolicy?.policy ?? null;
          }

          const balance = ledgerRepo.getBalance(tdb, agentId);
          const dailySpend = ledgerRepo.getDailySpend(tdb, agentId);

          // Capture max_fee_msat from effective policy for Lightning routing fee limit (default: 1 sat)
          if (effectivePolicy?.max_fee_msat != null) {
            policyMaxFeeMsat = effectivePolicy.max_fee_msat;
          }

          // Capture approval_timeout_ms for REQUIRE_HUMAN_APPROVAL path (Plan 02 will use it)
          approvalTimeoutMs = policyVersion?.approval_timeout_ms ?? 300_000;

          // Evaluate policy (fail-closed — evaluatePolicy never throws)
          // effectivePolicy has max_transaction_msat and daily_limit_msat — structurally compatible with PolicyConfig
          const decision = evaluatePolicy(effectivePolicy, {
            balance_msat: balance,
            daily_spent_msat: dailySpend,
            request_amount_msat: request.amount_msat,
          });

          // Write PAYMENT_REQUEST audit entry ALWAYS — even for DENY
          // Include routing trace fields in audit metadata
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
              initial_rail: initialRail !== 'simulated' ? initialRail : undefined,
              preferred_rail: request.preferred_rail,
            },
          });

          if (decision.outcome === 'ALLOW') {
            walletShouldRun = true;
          } else {
            denyOutcome = decision.outcome;
            denyReason = decision.reason;
          }
        }, { behavior: 'immediate' });

        // REQUIRE_HUMAN_APPROVAL path — intercept before generic DENY handling
        // Write RESERVE + pending_approvals atomically, then return PENDING_APPROVAL
        // NOTE: cast needed because TS control flow narrows denyOutcome to 'DENY' (callback assignment)
        if (!walletShouldRun && (denyOutcome as PolicyOutcome) === 'REQUIRE_HUMAN_APPROVAL') {
          const expiresAt = new Date(Date.now() + approvalTimeoutMs);
          let approvalId = '';

          db.transaction((tx) => {
            const tdb = tx as unknown as Db;

            // Write RESERVE to hold the funds during approval
            ledgerRepo.insert(tdb, {
              id: txId,
              agent_id: agentId,
              amount_msat: -request.amount_msat,
              entry_type: 'RESERVE',
              ref_id: txId,
              mode: initialRail !== 'simulated' ? initialRail as 'lightning' | 'cashu' : 'simulated',
            });

            // Create pending_approvals row
            const approval = approvalsRepo.create(tdb, {
              agent_id: agentId,
              type: 'payment',
              transaction_id: txId,
              amount_msat: request.amount_msat,
              destination: request.destination,
              expires_at: expiresAt,
            });
            approvalId = approval.id;

            // Write APPROVAL_REQUESTED audit entry
            auditRepo.insert(tdb, {
              agent_id: agentId,
              action: 'APPROVAL_REQUESTED',
              policy_decision: 'REQUIRE_HUMAN_APPROVAL',
              amount_msat: request.amount_msat,
              ref_id: txId,
              metadata: {
                approval_id: approvalId,
                expires_at: expiresAt.toISOString(),
              },
            });
          }, { behavior: 'immediate' });

          // Fire webhook — MUST NOT block
          webhookService.send({
            event: 'approval_required',
            agent_id: agentId,
            transaction_id: txId,
            amount_msat: request.amount_msat,
          }).catch(() => {});

          return {
            transaction_id: txId,
            policy_decision: 'REQUIRE_HUMAN_APPROVAL',
            mode: initialRail,
            status: 'PENDING_APPROVAL',
          };
        }

        // DENY path — audit logged, no ledger entry, return early
        if (!walletShouldRun) {
          return {
            transaction_id: txId,
            policy_decision: denyOutcome,
            reason: denyReason,
            mode: initialRail,
            status: 'FAILED',
          };
        }

        // ---------------------------------------------------------------
        // Helper: get wallet for a given rail
        // ---------------------------------------------------------------
        const getWallet = (rail: 'lightning' | 'cashu' | 'simulated'): WalletBackend => {
          if (rail === 'cashu') return options.cashuWallet!;
          if (rail === 'lightning') return options.lightningWallet!;
          return options.simulatedWallet;
        };

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
        if (initialRail === 'lightning') {
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
        // Attempt primary rail, then fallback if FAILED.
        // ---------------------------------------------------------------
        const walletReq = {
          amount_msat: request.amount_msat,
          asset: request.asset,
          purpose: request.purpose,
          destination_type: request.destination_type,
          destination: request.destination,
          transaction_id: txId,
          max_fee_msat: policyMaxFeeMsat,
        };

        let selectedRail = initialRail;
        let finalRail = initialRail;
        let fallbackOccurred = false;
        let walletResult: PaymentResult;

        try {
          walletResult = await getWallet(initialRail).pay({ ...walletReq });

          // If primary rail returned FAILED and fallback is available, try other rail
          if (walletResult.status === 'FAILED' && canFallback(initialRail, options)) {
            const fallbackRail = initialRail === 'lightning' ? 'cashu' : 'lightning';

            // For Lightning->Cashu fallback:
            //   Lightning returned FAILED (not a stream error) — the RESERVE was already written in Phase 1.5.
            //   We need to write the RELEASE now (before attempting Cashu).
            if (initialRail === 'lightning') {
              db.transaction((tx) => {
                const tdb = tx as unknown as Db;
                ledgerRepo.insert(tdb, {
                  agent_id: agentId,
                  amount_msat: request.amount_msat,
                  entry_type: 'RELEASE',
                  ref_id: txId,
                  payment_hash: walletResult.payment_hash,
                  mode: 'lightning',
                });
                auditRepo.insert(tdb, {
                  agent_id: agentId,
                  action: 'PAYMENT_FAILED',
                  amount_msat: request.amount_msat,
                  ref_id: txId,
                  metadata: {
                    payment_hash: walletResult.payment_hash ?? null,
                    fallback_to: fallbackRail,
                  },
                });
              }, { behavior: 'immediate' });
            }
            // For Cashu->Lightning fallback:
            //   CashuWalletBackend already restored proofs on failure.
            //   The Lightning fallback needs a new RESERVE entry.
            if (fallbackRail === 'lightning') {
              db.transaction((tx) => {
                const tdb = tx as unknown as Db;
                ledgerRepo.insert(tdb, {
                  id: txId + '_fallback',
                  agent_id: agentId,
                  amount_msat: -request.amount_msat,
                  entry_type: 'RESERVE',
                  ref_id: txId,
                  mode: 'lightning',
                });
              }, { behavior: 'immediate' });
            }

            const fallbackResult = await getWallet(fallbackRail).pay({ ...walletReq });
            finalRail = fallbackRail;
            fallbackOccurred = true;
            selectedRail = fallbackRail;
            walletResult = fallbackResult;
          }
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
              initial_rail: initialRail !== 'simulated' ? initialRail as 'lightning' | 'cashu' : undefined,
              final_rail: finalRail !== 'simulated' ? finalRail as 'lightning' | 'cashu' : undefined,
            };
          }
          // Non-stream errors: re-throw to be caught by outer try/catch
          throw walletErr;
        }

        // ---------------------------------------------------------------
        // Phase 2: Process wallet result
        // ---------------------------------------------------------------

        if (walletResult.status === 'SETTLED') {
          if (selectedRail === 'lightning') {
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

              // Write PAYMENT_SETTLED audit with routing trace
              auditRepo.insert(tdb, {
                agent_id: agentId,
                action: 'PAYMENT_SETTLED',
                amount_msat: request.amount_msat,
                ref_id: txId,
                metadata: {
                  payment_hash: walletResult.payment_hash ?? null,
                  fee_msat: walletResult.fee_msat ?? 0,
                  initial_rail: initialRail !== 'simulated' ? initialRail : undefined,
                  final_rail: finalRail !== 'simulated' ? finalRail : undefined,
                  fallback_occurred: fallbackOccurred || undefined,
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

            // Post-settlement balance alert check (OBSV-06)
            // Fire-and-forget — must not affect payment response
            alertsService.checkAndNotify(db as unknown as Db, agentId).catch(() => {});
          } else if (selectedRail === 'cashu') {
            // Cashu SETTLED: debit + audit atomically
            //
            // When Cashu is the primary rail: use id=txId (the canonical ledger entry for this tx).
            // When Cashu is a fallback after Lightning: txId is already taken by the RESERVE entry;
            //   use ref_id only (let ledger auto-generate a new id) for the PAYMENT debit.
            const isCashuFallback = fallbackOccurred && initialRail === 'lightning';
            db.transaction((tx) => {
              const tdb = tx as unknown as Db;

              ledgerRepo.insert(tdb, {
                ...(isCashuFallback ? {} : { id: txId }),
                agent_id: agentId,
                amount_msat: -request.amount_msat,
                entry_type: 'PAYMENT',
                ref_id: txId,
                mode: 'cashu',
              });

              auditRepo.insert(tdb, {
                agent_id: agentId,
                action: 'PAYMENT_SETTLED',
                amount_msat: request.amount_msat,
                ref_id: txId,
                metadata: {
                  cashu_token_id: walletResult.cashu_token_id,
                  fee_msat: walletResult.fee_msat ?? 0,
                  initial_rail: initialRail !== 'simulated' ? initialRail : undefined,
                  final_rail: finalRail !== 'simulated' ? finalRail : undefined,
                  fallback_occurred: fallbackOccurred || undefined,
                },
              });

              // Write routing fee debit if cashu fee was charged
              if (walletResult.fee_msat && walletResult.fee_msat > 0) {
                ledgerRepo.insert(tdb, {
                  agent_id: agentId,
                  amount_msat: -walletResult.fee_msat,
                  entry_type: 'PAYMENT',
                  ref_id: txId,
                  mode: 'cashu',
                });
              }
            }, { behavior: 'immediate' });

            // Post-settlement balance alert check (OBSV-06)
            // Fire-and-forget — must not affect payment response
            alertsService.checkAndNotify(db as unknown as Db, agentId).catch(() => {});
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

            // Post-settlement balance alert check (OBSV-06)
            // Fire-and-forget — must not affect payment response
            alertsService.checkAndNotify(db as unknown as Db, agentId).catch(() => {});
          }

          return {
            transaction_id: txId,
            policy_decision: 'ALLOW',
            mode: walletResult.mode,
            status: walletResult.status,
            payment_hash: walletResult.payment_hash,
            fee_msat: walletResult.fee_msat,
            cashu_token_id: walletResult.cashu_token_id,
            rail_used: finalRail !== 'simulated' ? finalRail as 'lightning' | 'cashu' : undefined,
            initial_rail: initialRail !== 'simulated' ? initialRail as 'lightning' | 'cashu' : undefined,
            final_rail: finalRail !== 'simulated' ? finalRail as 'lightning' | 'cashu' : undefined,
            fallback_occurred: fallbackOccurred || undefined,
          };
        }

        if (walletResult.status === 'FAILED') {
          if (selectedRail === 'lightning') {
            // Lightning FAILED: write RELEASE + PAYMENT_FAILED audit
            // (Only reached here if: (a) lightning-only setup, or (b) lightning was fallback)
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
                  initial_rail: initialRail !== 'simulated' ? initialRail : undefined,
                  final_rail: finalRail !== 'simulated' ? finalRail : undefined,
                  fallback_occurred: fallbackOccurred || undefined,
                },
              });
            }, { behavior: 'immediate' });
          } else if (selectedRail === 'cashu') {
            // Cashu FAILED: CashuWalletBackend already restored proofs on failure
            // Just write the audit entry — no ledger debit was made
            db.transaction((tx) => {
              const tdb = tx as unknown as Db;
              auditRepo.insert(tdb, {
                agent_id: agentId,
                action: 'PAYMENT_FAILED',
                amount_msat: request.amount_msat,
                ref_id: txId,
                metadata: {
                  initial_rail: initialRail !== 'simulated' ? initialRail : undefined,
                  final_rail: finalRail !== 'simulated' ? finalRail : undefined,
                  fallback_occurred: fallbackOccurred || undefined,
                },
              });
            }, { behavior: 'immediate' });
          } else {
            // Simulated FAILED (shouldn't normally happen, but handle for completeness)
            db.transaction((tx) => {
              const tdb = tx as unknown as Db;
              auditRepo.insert(tdb, {
                agent_id: agentId,
                action: 'PAYMENT_FAILED',
                amount_msat: request.amount_msat,
                ref_id: txId,
              });
            }, { behavior: 'immediate' });
          }

          return {
            transaction_id: txId,
            policy_decision: 'ALLOW',
            mode: walletResult.mode,
            status: 'FAILED',
            payment_hash: walletResult.payment_hash,
            rail_used: finalRail !== 'simulated' ? finalRail as 'lightning' | 'cashu' : undefined,
            initial_rail: initialRail !== 'simulated' ? initialRail as 'lightning' | 'cashu' : undefined,
            final_rail: finalRail !== 'simulated' ? finalRail as 'lightning' | 'cashu' : undefined,
            fallback_occurred: fallbackOccurred || undefined,
          };
        }

        // PENDING status (unusual for direct wallet call — should only come from stream error path above)
        return {
          transaction_id: txId,
          policy_decision: 'ALLOW',
          mode: walletResult.mode,
          status: 'PENDING',
          payment_hash: walletResult.payment_hash,
          rail_used: finalRail !== 'simulated' ? finalRail as 'lightning' | 'cashu' : undefined,
          initial_rail: initialRail !== 'simulated' ? initialRail as 'lightning' | 'cashu' : undefined,
          final_rail: finalRail !== 'simulated' ? finalRail as 'lightning' | 'cashu' : undefined,
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
export const paymentsService = createPaymentsService({ simulatedWallet });
