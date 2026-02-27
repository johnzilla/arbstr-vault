import { subscribeToPastPayment } from 'lightning';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { connectWithRetry } from './lnd.client.js';
import { LightningWallet } from '../../modules/payments/wallet/lightning.wallet.js';
import { ledgerRepo } from '../../modules/ledger/ledger.repo.js';
import { auditRepo } from '../../modules/audit/audit.repo.js';
import { config } from '../../config.js';
import type { WalletBackend } from '../../modules/payments/wallet/wallet.interface.js';

// Narrow DB type — matches ledger.repo.ts and audit.repo.ts
type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * Initialize the Lightning wallet backend with crash recovery.
 *
 * Steps:
 *   1. Connect to LND with exponential backoff retry (connectWithRetry)
 *   2. Create LightningWallet bound to the LND connection
 *   3. Crash recovery: query all PENDING Lightning payments from the ledger
 *      - If payment has no payment_hash: crashed before LND send → write RELEASE
 *      - If payment has payment_hash: crashed during in-flight HTLC → re-subscribe
 *        via subscribeToPastPayment to finalize the ledger when LND resolves
 *
 * @param db - Database connection (narrow type for ledger/audit repos)
 * @returns LightningWallet instance implementing WalletBackend
 */
export async function initializeLightningBackend(db: Db): Promise<WalletBackend> {
  // Step 1: Connect to LND with retry
  const lnd = await connectWithRetry({
    cert: config.LND_CERT_BASE64!,
    macaroon: config.LND_MACAROON_BASE64!,
    socket: `${config.LND_HOST}:${config.LND_PORT}`,
  });

  // Step 2: Create LightningWallet
  const wallet = new LightningWallet(lnd);

  // Step 3: Crash recovery — process all PENDING lightning payments
  const pendingPayments = ledgerRepo.getPendingLightningPayments(db);

  for (const payment of pendingPayments) {
    if (!payment.payment_hash) {
      // Crashed BEFORE LND send (RESERVE written, no payment_hash means LND never received it)
      // The HTLC was never initiated — safe to write RELEASE immediately
      console.warn(
        `[LND startup] Crash recovery: RESERVE entry ${payment.id} has no payment_hash — ` +
        `LND never sent this payment. Writing RELEASE to credit back ${payment.amount_msat} msat ` +
        `for agent ${payment.agent_id}.`,
      );

      db.transaction((tx) => {
        const tdb = tx as unknown as Db;

        // Credit back the reserved amount (RELEASE is positive)
        ledgerRepo.insert(tdb, {
          agent_id: payment.agent_id,
          amount_msat: Math.abs(payment.amount_msat), // RESERVE is negative, RELEASE is positive
          entry_type: 'RELEASE',
          ref_id: payment.ref_id ?? undefined,
          mode: 'lightning',
        });

        // Write PAYMENT_FAILED audit for observability
        auditRepo.insert(tdb, {
          agent_id: payment.agent_id,
          action: 'PAYMENT_FAILED',
          amount_msat: Math.abs(payment.amount_msat),
          ref_id: payment.ref_id ?? undefined,
          metadata: {
            reason: 'crash_before_send',
            reserve_entry_id: payment.id,
          },
        });
      }, { behavior: 'immediate' });

      continue;
    }

    // Crashed DURING an in-flight HTLC — payment_hash is stored, payment may still be resolving
    // Re-subscribe via subscribeToPastPayment — fires 'confirmed'/'failed' even for already-resolved payments
    // Fire-and-forget: errors logged, will retry on next restart
    const paymentRef = { ...payment }; // capture for closure

    const sub = subscribeToPastPayment({ lnd, id: paymentRef.payment_hash! });

    console.info(
      `[LND startup] Crash recovery: re-subscribing to in-flight payment ` +
      `${paymentRef.payment_hash} (txId: ${paymentRef.ref_id ?? paymentRef.id})`,
    );

    sub.on('confirmed', ({ fee_mtokens }: { fee_mtokens: string }) => {
      const feeMsat = Number(fee_mtokens);
      console.info(
        `[LND startup] Crash recovery: payment ${paymentRef.payment_hash} confirmed ` +
        `(fee: ${feeMsat} msat) — writing PAYMENT_SETTLED audit`,
      );

      try {
        db.transaction((tx) => {
          const tdb = tx as unknown as Db;

          // Write PAYMENT_SETTLED audit
          auditRepo.insert(tdb, {
            agent_id: paymentRef.agent_id,
            action: 'PAYMENT_SETTLED',
            amount_msat: Math.abs(paymentRef.amount_msat),
            ref_id: paymentRef.ref_id ?? undefined,
            metadata: {
              payment_hash: paymentRef.payment_hash,
              fee_msat: feeMsat,
              recovery: true,
            },
          });

          // Write routing fee debit if applicable
          if (feeMsat > 0) {
            ledgerRepo.insert(tdb, {
              agent_id: paymentRef.agent_id,
              amount_msat: -feeMsat,
              entry_type: 'PAYMENT',
              ref_id: paymentRef.ref_id ?? undefined,
              payment_hash: paymentRef.payment_hash ?? undefined,
              mode: 'lightning',
            });
          }
        }, { behavior: 'immediate' });
      } catch (err) {
        console.error(
          `[LND startup] Crash recovery: failed to write PAYMENT_SETTLED for ${paymentRef.payment_hash}`,
          err,
        );
      }
    });

    sub.on('failed', () => {
      console.info(
        `[LND startup] Crash recovery: payment ${paymentRef.payment_hash} failed — ` +
        `writing RELEASE + PAYMENT_FAILED audit`,
      );

      try {
        db.transaction((tx) => {
          const tdb = tx as unknown as Db;

          // RELEASE credits back the reserved amount
          ledgerRepo.insert(tdb, {
            agent_id: paymentRef.agent_id,
            amount_msat: Math.abs(paymentRef.amount_msat),
            entry_type: 'RELEASE',
            ref_id: paymentRef.ref_id ?? undefined,
            payment_hash: paymentRef.payment_hash ?? undefined,
            mode: 'lightning',
          });

          // Write PAYMENT_FAILED audit
          auditRepo.insert(tdb, {
            agent_id: paymentRef.agent_id,
            action: 'PAYMENT_FAILED',
            amount_msat: Math.abs(paymentRef.amount_msat),
            ref_id: paymentRef.ref_id ?? undefined,
            metadata: {
              payment_hash: paymentRef.payment_hash,
              reason: 'failed_during_crash_recovery',
              recovery: true,
            },
          });
        }, { behavior: 'immediate' });
      } catch (err) {
        console.error(
          `[LND startup] Crash recovery: failed to write RELEASE for ${paymentRef.payment_hash}`,
          err,
        );
      }
    });

    sub.on('error', (err: Error) => {
      // Stream error during crash recovery — log it and leave PENDING
      // Will retry on next restart via the same mechanism
      console.error(
        `[LND startup] Crash recovery: stream error for ${paymentRef.payment_hash} — ` +
        `leaving PENDING, will retry on next restart`,
        err,
      );
    });
  }

  return wallet;
}
