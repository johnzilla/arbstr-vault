/**
 * Build real, signed regtest BOLT11 invoices for tests.
 *
 * Payment routes parse the destination invoice and require its amount to equal
 * amount_msat, so placeholder strings like 'lnbc...' no longer pass. Signed with
 * a fixed test key via `invoices` + `tiny-secp256k1`.
 */
import { createHash, randomBytes } from 'crypto';
import { createSignedRequest, createUnsignedRequest } from 'invoices';
import * as ecc from 'tiny-secp256k1';

const TEST_NODE_KEY = Buffer.alloc(32, 1);
const TEST_NODE_PUBKEY = Buffer.from(ecc.pointFromScalar(TEST_NODE_KEY, true)!).toString('hex');

export interface TestInvoiceOptions {
  /** Invoice amount in msat; omit for an amountless invoice */
  amountMsat?: number;
  /** Seconds until expiry (default 1 hour); negative for an already-expired invoice */
  expiresInSec?: number;
}

export function makeInvoice({ amountMsat, expiresInSec = 3600 }: TestInvoiceOptions = {}): string {
  const now = Date.now();
  // Expiry must come after creation, so an expired invoice is created further in the past
  const createdAt = new Date(expiresInSec > 0 ? now : now + (expiresInSec - 3600) * 1000);
  const expiresAt = new Date(now + expiresInSec * 1000);

  const unsigned = createUnsignedRequest({
    created_at: createdAt.toISOString(),
    description: 'arbstr-vault test invoice',
    destination: TEST_NODE_PUBKEY,
    expires_at: expiresAt.toISOString(),
    features: [],
    id: createHash('sha256').update(randomBytes(32)).digest('hex'),
    mtokens: amountMsat === undefined ? undefined : String(amountMsat),
    network: 'regtest',
  });
  const signature = Buffer.from(ecc.sign(Buffer.from(unsigned.hash, 'hex'), TEST_NODE_KEY)).toString('hex');
  return createSignedRequest({
    destination: TEST_NODE_PUBKEY,
    hrp: unsigned.hrp,
    signature,
    tags: unsigned.tags,
  }).request;
}
