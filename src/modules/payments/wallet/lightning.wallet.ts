import { subscribeToPayViaRequest } from 'lightning';
import type { AuthenticatedLnd } from 'lightning';
import type { WalletBackend, PaymentRequest, PaymentResult } from './wallet.interface.js';

/**
 * LightningStreamError — emitted when the gRPC stream disconnects unexpectedly.
 *
 * This is NOT a payment failure. The payment may still be in-flight on the
 * Lightning network. The payment service must keep the ledger in PENDING state
 * on this error and NOT write a RELEASE entry.
 *
 * The payment_hash (if captured in the 'paying' event before the stream error)
 * is attached for crash recovery use.
 */
export class LightningStreamError extends Error {
  /** Payment hash captured from the 'paying' event, if available. May be undefined
   * if the stream error occurred before the 'paying' event was emitted. */
  public readonly payment_hash: string | undefined;

  constructor(message: string, payment_hash?: string) {
    super(message);
    this.name = 'LightningStreamError';
    this.payment_hash = payment_hash;
  }
}

/**
 * LightningWallet — implements WalletBackend via LND subscribeToPayViaRequest.
 *
 * Implements the three-phase payment state machine:
 *   1. 'paying' event  — payment in-flight; payment_hash captured synchronously in memory
 *   2. 'confirmed' event — payment settled; resolves Promise with SETTLED + payment_hash + fee_msat
 *   3. 'failed' event  — payment definitively failed; resolves Promise with FAILED + payment_hash
 *
 * On 'error' (gRPC stream disconnect): rejects with LightningStreamError.
 * The caller (payments.service.ts) must keep ledger in PENDING state on stream error.
 *
 * Anti-patterns avoided (per RESEARCH.md):
 * - Does NOT use payViaPaymentRequest (blocks, no 'paying' event)
 * - Does NOT treat 'error' as payment failure (would cause false refunds)
 * - Does NOT do async DB write in 'paying' handler (regtest emits 'confirmed' synchronously after 'paying')
 */
export class LightningWallet implements WalletBackend {
  private readonly lnd: AuthenticatedLnd;

  constructor(lnd: AuthenticatedLnd) {
    this.lnd = lnd;
  }

  pay(req: PaymentRequest): Promise<PaymentResult> {
    // Default fee limit: 1000 msat (1 sat) if not specified in request
    const maxFeeMsat = req.max_fee_msat ?? 1000;

    return new Promise<PaymentResult>((resolve, reject) => {
      // Track payment_hash synchronously in memory (Pitfall 2 from RESEARCH.md:
      // regtest can emit 'confirmed' synchronously after 'paying', so we must NOT
      // await any async operation in the 'paying' handler — store hash in closure instead)
      let paymentHashInMemory: string | undefined;

      const sub = subscribeToPayViaRequest({
        lnd: this.lnd,
        request: req.destination, // BOLT11 invoice string
        max_fee_mtokens: String(maxFeeMsat),
      });

      // Phase 1: Payment in-flight — capture payment_hash synchronously
      sub.on('paying', ({ id }: { id: string }) => {
        // Store synchronously in memory — do NOT await any DB write here
        // (regtest can emit 'confirmed' before an async write would complete)
        paymentHashInMemory = id;
      });

      // Phase 2 (success): Payment settled
      sub.on('confirmed', ({ id, fee_mtokens }: { id: string; fee_mtokens: string }) => {
        resolve({
          transaction_id: req.transaction_id,
          status: 'SETTLED',
          mode: 'lightning',
          payment_hash: id,
          fee_msat: Number(fee_mtokens),
          settled_at: new Date(),
        });
      });

      // Phase 2 (failure): Payment definitively failed (not a stream error)
      // is_route_not_found, is_pathfinding_timeout, is_insufficient_balance, etc.
      sub.on('failed', (failure: {
        is_route_not_found?: boolean;
        is_pathfinding_timeout?: boolean;
        is_insufficient_balance?: boolean;
        is_payment_rejected?: boolean;
        is_canceled?: boolean;
      }) => {
        // Determine failure reason for audit trail
        let failureReason = 'unknown';
        if (failure.is_route_not_found) failureReason = 'route_not_found';
        else if (failure.is_pathfinding_timeout) failureReason = 'pathfinding_timeout';
        else if (failure.is_insufficient_balance) failureReason = 'insufficient_balance';
        else if (failure.is_payment_rejected) failureReason = 'payment_rejected';
        else if (failure.is_canceled) failureReason = 'canceled';

        resolve({
          transaction_id: req.transaction_id,
          status: 'FAILED',
          mode: 'lightning',
          payment_hash: paymentHashInMemory,
          // Attach failure reason metadata for caller to use in audit log
          ...(failureReason !== 'unknown' ? { failure_reason: failureReason } : {}),
        });
      });

      // gRPC stream error — NOT a payment failure (Pitfall 1 from RESEARCH.md)
      // The payment may still be in-flight on the Lightning network.
      // Reject with LightningStreamError so the caller can:
      //   1. Keep the ledger in PENDING state (no RELEASE entry)
      //   2. Use the payment_hash for crash recovery on next startup
      sub.on('error', (err: Error) => {
        reject(new LightningStreamError(
          `LND gRPC stream error: ${err.message}`,
          paymentHashInMemory,
        ));
      });
    });
  }
}
