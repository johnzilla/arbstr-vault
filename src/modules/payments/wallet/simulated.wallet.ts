import type { WalletBackend, PaymentRequest, PaymentResult } from './wallet.interface.js';

/**
 * SimulatedWallet — implements WalletBackend with deterministic success.
 * Always returns SETTLED with mode 'simulated'.
 * No randomized failures in Phase 1 (per CONTEXT.md).
 * When Lightning is live, the LND wallet will return mode 'lightning'.
 */
export const simulatedWallet: WalletBackend = {
  pay(req: PaymentRequest): Promise<PaymentResult> {
    return Promise.resolve({
      transaction_id: req.transaction_id,
      status: 'SETTLED',
      mode: 'simulated',
      settled_at: new Date(),
    });
  },
};
