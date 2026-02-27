import {
  authenticatedLndGrpc,
  getChainBalance,
  getWalletInfo,
} from 'lightning';
import type { AuthenticatedLnd } from 'lightning';

export type { AuthenticatedLnd };

/**
 * LndClient is a type alias for AuthenticatedLnd — use this for clean imports in downstream code.
 */
export type LndClient = AuthenticatedLnd;

/**
 * Create an LND gRPC connection from base64-encoded cert and macaroon.
 *
 * @param opts.cert     - Base64-encoded TLS certificate (tls.cert)
 * @param opts.macaroon - Base64-encoded scoped macaroon
 * @param opts.socket   - LND gRPC socket address, e.g. "lnd-alice:10009"
 */
export function createLndConnection(opts: {
  cert: string;
  macaroon: string;
  socket: string;
}): AuthenticatedLnd {
  const { lnd } = authenticatedLndGrpc(opts);
  return lnd;
}

/**
 * Verify the loaded macaroon does NOT have onchain:read permission (SEC-05).
 *
 * A correctly scoped payment macaroon (info:read invoices:read invoices:write
 * offchain:read offchain:write) does NOT have onchain:read. Calling
 * getChainBalance requires onchain:read. If the call succeeds, the macaroon
 * is overprivileged (likely admin.macaroon) — refuse to start.
 *
 * If the call fails with a permission error, the macaroon is correctly scoped
 * and startup proceeds silently.
 *
 * Implements SEC-05: LND macaroon is scoped to invoice+offchain operations only.
 */
export async function verifyMacaroonScope(lnd: AuthenticatedLnd): Promise<void> {
  try {
    await getChainBalance({ lnd });
    // If getChainBalance succeeds, the macaroon has onchain:read — too broad
    throw new Error(
      'FATAL: Macaroon has onchain:read permission — refusing to start. Use payment-scoped macaroon.',
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('FATAL:')) {
      // Re-throw our own fatal error — do not swallow it
      throw err;
    }
    // Expected: permission denied from LND — macaroon is correctly scoped
    // Any other LND error here is also fine (node may not be fully synced yet)
    // We proceed silently
  }
}

/**
 * Connect to LND with retry (5 attempts, exponential backoff).
 *
 * Steps per attempt:
 *   1. Create gRPC connection
 *   2. Verify macaroon scope (SEC-05) — fatal failure exits immediately
 *   3. getWalletInfo health check (requires info:read)
 *
 * Retry delays: [1s, 2s, 4s, 8s, 16s]
 *
 * On FATAL macaroon error: exits process immediately — no retry.
 * After 5 failures: throws Error('LND connection failed after 5 retries — refusing to start')
 *
 * @param opts.cert     - Base64-encoded TLS certificate
 * @param opts.macaroon - Base64-encoded scoped macaroon
 * @param opts.socket   - LND gRPC socket address
 * @param opts.logger   - Optional logger with .warn() and .error() methods
 */
export async function connectWithRetry(opts: {
  cert: string;
  macaroon: string;
  socket: string;
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<AuthenticatedLnd> {
  const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
  const MAX_RETRIES = 5;
  const log = opts.logger ?? {
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const lnd = createLndConnection({
        cert: opts.cert,
        macaroon: opts.macaroon,
        socket: opts.socket,
      });

      // SEC-05: verify macaroon is not overprivileged — fatal, no retry
      await verifyMacaroonScope(lnd);

      // Health check: getWalletInfo requires info:read in the macaroon scope
      const info = await getWalletInfo({ lnd });

      if (!info.is_synced_to_chain) {
        // Regtest nodes may not be synced — log warning but continue
        log.warn(
          `[LND] Warning: node is not synced to chain (attempt ${attempt}/${MAX_RETRIES}). Continuing anyway.`,
        );
      }

      return lnd;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // FATAL macaroon error: exit immediately without retrying
      if (message.startsWith('FATAL:')) {
        log.error(`[LND] ${message}`);
        process.exit(1);
      }

      lastError = err instanceof Error ? err : new Error(message);
      log.error(
        `[LND] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${message}`,
      );

      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError ?? new Error('LND connection failed after 5 retries — refusing to start');
}
