// Types for the parts of the untyped `invoices` package (ln-service family) used here.
declare module 'invoices' {
  /** Parse a BOLT11 payment request. Throws on malformed input. mtokens are millisatoshis. */
  export function parsePaymentRequest(args: { request: string }): {
    id: string;
    mtokens: string;
    tokens: number;
    is_expired: boolean;
    expires_at: string;
    network: string;
  };
}
