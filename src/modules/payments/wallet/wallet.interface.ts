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
  /** Proof secret reference, present for Cashu payments */
  cashu_token_id?: string;
  /** Which rail was ultimately used */
  rail_used?: 'lightning' | 'cashu';
  /** Originally selected rail (before any fallback) */
  initial_rail?: 'lightning' | 'cashu';
  /** Rail after fallback (if any) */
  final_rail?: 'lightning' | 'cashu';
  /** True if primary rail failed and fallback was used */
  fallback_occurred?: boolean;
}

export interface WalletBackend {
  pay(req: PaymentRequest): Promise<PaymentResult>;
}
