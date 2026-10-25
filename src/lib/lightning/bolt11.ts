// BOLT11 invoice checks for agent-supplied payment destinations.
//
// Payments and withdrawals debit the agent's requested amount_msat, while LND
// (and the Cashu melt) pay whatever amount the invoice itself carries. So an
// invoice is only accepted when it parses, carries an amount, has not expired,
// and its amount equals amount_msat exactly. Checked before policy evaluation,
// so a rejected invoice writes no RESERVE or audit entry.
//
// Network (mainnet/testnet/regtest) is not checked: vault's config does not
// know which network LND runs on, and LND rejects invoices for another chain.

// `invoices` is the BOLT11 parser from the `lightning` package's own family;
// types in ./invoices.d.ts.
import { parsePaymentRequest } from 'invoices';
import { z } from 'zod/v4';

export type InvoiceErrorCode =
  | 'invalid_invoice'
  | 'invoice_amount_required'
  | 'invoice_expired'
  | 'invoice_amount_mismatch';

export type InvoiceCheck =
  | { ok: true; payment_hash: string; amount_msat: number }
  | { ok: false; code: InvoiceErrorCode; message: string; invoice_amount_msat?: number };

export function checkInvoice(request: string, amountMsat: number): InvoiceCheck {
  let parsed: ReturnType<typeof parsePaymentRequest>;
  try {
    parsed = parsePaymentRequest({ request: request.trim() });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'invalid_invoice', message: `Destination is not a valid BOLT11 invoice (${reason})` };
  }

  // mtokens is a string and can exceed Number's safe range
  const invoiceMsat = BigInt(parsed.mtokens);
  if (invoiceMsat === 0n) {
    return {
      ok: false,
      code: 'invoice_amount_required',
      message: 'Invoice has no amount; use an invoice for exactly amount_msat',
    };
  }
  if (parsed.is_expired) {
    return { ok: false, code: 'invoice_expired', message: `Invoice expired at ${parsed.expires_at}` };
  }
  if (invoiceMsat !== BigInt(amountMsat)) {
    return {
      ok: false,
      code: 'invoice_amount_mismatch',
      message: `Invoice amount ${invoiceMsat} msat does not equal amount_msat ${amountMsat}`,
      invoice_amount_msat: invoiceMsat <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(invoiceMsat) : undefined,
    };
  }
  return { ok: true, payment_hash: parsed.id, amount_msat: amountMsat };
}

/**
 * 400 response schema for routes that check invoices: either an invoice error,
 * or Fastify's own body-validation error (which a narrower schema would turn into a 500).
 */
export const invoiceError400 = z.union([
  z.object({
    error: z.object({ code: z.string(), message: z.string() }),
    invoice_amount_msat: z.number().optional(),
  }),
  z.object({ statusCode: z.number(), code: z.string(), error: z.string(), message: z.string() }),
]);
