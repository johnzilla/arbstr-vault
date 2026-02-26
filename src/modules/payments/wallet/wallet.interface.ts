import type { TransactionId } from '../../../types.js';

export interface PaymentRequest {
  amount_msat: number;
  asset: string;
  purpose: string;
  destination_type: string;
  destination: string;
  transaction_id: TransactionId;
}

export interface PaymentResult {
  transaction_id: TransactionId;
  status: 'SETTLED' | 'PENDING' | 'FAILED';
  mode: string;
  settled_at?: Date;
}

export interface WalletBackend {
  pay(req: PaymentRequest): Promise<PaymentResult>;
}
