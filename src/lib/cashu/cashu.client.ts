import { Wallet } from '@cashu/cashu-ts';
import type {
  Proof,
  MeltQuoteBolt11Response,
  MintQuoteBolt11Response,
  MeltProofsResponse,
  ProofState,
  SendResponse,
} from '@cashu/cashu-ts';

export type { Proof };

/**
 * CashuClient — thin wrapper around cashu-ts Wallet.
 *
 * All operations route through this class so the rest of the codebase
 * doesn't need to import @cashu/cashu-ts directly.
 *
 * IMPORTANT: Call initialize() before any other method.
 * The Wallet constructor makes no network calls; loadMint() is the async initializer.
 */
export class CashuClient {
  private readonly wallet: Wallet;

  constructor(mintUrl: string) {
    this.wallet = new Wallet(mintUrl, { unit: 'sat' });
  }

  /**
   * Load mint info, keysets, and keys from the mint.
   * MUST be called before any other operation (Pitfall 5: constructor makes no network calls).
   */
  async initialize(): Promise<void> {
    await this.wallet.loadMint();
  }

  /**
   * Create a BOLT11 mint quote.
   * Returns a Lightning invoice (quote.request) that, when paid, allows minting proofs.
   */
  async createMintQuote(amountSat: number): Promise<MintQuoteBolt11Response> {
    return this.wallet.createMintQuoteBolt11(amountSat);
  }

  /**
   * Mint proofs after the mint quote's invoice has been paid.
   */
  async mintProofs(amountSat: number, quote: MintQuoteBolt11Response): Promise<Proof[]> {
    return this.wallet.mintProofsBolt11(amountSat, quote);
  }

  /**
   * Create a BOLT11 melt quote for paying a Lightning invoice.
   * Returns quote.amount (sat to pay) and quote.fee_reserve (max fee sat).
   */
  async createMeltQuote(bolt11Invoice: string): Promise<MeltQuoteBolt11Response> {
    return this.wallet.createMeltQuoteBolt11(bolt11Invoice);
  }

  /**
   * Execute the melt — spends proofs to pay the Lightning invoice.
   * result.quote.state === 'PAID' means success.
   * result.change holds change proofs from fee_reserve overpayment.
   */
  async meltProofs(
    meltQuote: MeltQuoteBolt11Response,
    proofs: Proof[],
  ): Promise<MeltProofsResponse<MeltQuoteBolt11Response>> {
    return this.wallet.meltProofsBolt11(meltQuote, proofs);
  }

  /**
   * Swap proofs for new ones (used for keyset rotation).
   * Calls wallet.send() with the total amount and returns the keep proofs.
   */
  async swapProofs(proofs: Proof[]): Promise<Proof[]> {
    const total = proofs.reduce((sum, p) => sum + p.amount, 0);
    const result: SendResponse = await this.wallet.send(total, proofs);
    return result.keep;
  }

  /**
   * Check proof states (NUT-07) — used for crash recovery.
   * Returns UNSPENT, PENDING, or SPENT per proof.
   */
  async checkProofStates(proofs: Array<Pick<Proof, 'secret'>>): Promise<ProofState[]> {
    return this.wallet.checkProofsStates(proofs);
  }

  /**
   * Check melt quote status — used for crash recovery polling.
   */
  async checkMeltQuote(quoteId: string): Promise<MeltQuoteBolt11Response> {
    return this.wallet.checkMeltQuoteBolt11(quoteId);
  }

  /**
   * Get keysets from the wallet's keychain.
   * Used for keyset rotation detection.
   */
  getKeysets(): Array<{ id: string; isActive: boolean; unit: string }> {
    return this.wallet.keyChain.getKeysets().map((ks) => ({
      id: ks.id,
      isActive: ks.isActive,
      unit: ks.unit,
    }));
  }

  /**
   * Select proofs to send for a given amount from a pool.
   * Uses cashu-ts coin selection — NEVER hand-roll denomination math (Pitfall 1).
   *
   * @param amount Target amount in sat (include fee_reserve for melt operations).
   * @param proofs Available proof pool.
   * @returns keep proofs (stay in pool) and send proofs (to be submitted to mint).
   */
  selectProofsToSend(amount: number, proofs: Proof[]): { send: Proof[]; keep: Proof[] } {
    return this.wallet.selectProofsToSend(proofs, amount);
  }
}
