import type { TransactionId } from '../../../types.js';

export interface PaymentRequest {
  amount_msat: number;
  asset: string;
  purpose: string;
  destination_type: string;
  destination: string;
  transaction_id: TransactionId;
  /** Per-agent fee cap for Lightning routing fees (msat). Passed to LND as max_fee_mtokens. */
  max_fee_msat?: number;
}

export interface PaymentResult {
  transaction_id: TransactionId;
  status: 'SETTLED' | 'PENDING' | 'FAILED';
  mode: string;
  settled_at?: Date;
  payment_hash?: string;
  fee_msat?: number;
}

export interface WalletBackend {
  pay(req: PaymentRequest): Promise<PaymentResult>;
}
