import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { buildApp } from './app.js';
import { config } from './config.js';
import { db } from './db/client.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { WalletBackend } from './modules/payments/wallet/wallet.interface.js';
import { approvalsService } from './modules/approvals/approvals.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Narrow DB type for startup modules (lnd.startup.ts uses ledger/audit repos)
type Db = BetterSQLite3Database<Record<string, never>>;

async function main() {
  // Run database migrations before starting the server
  migrate(db, { migrationsFolder: join(__dirname, 'db/migrations') });

  // Select wallet backend based on WALLET_BACKEND config.
  // Dynamic imports avoid loading unused packages when not configured.
  let wallet: WalletBackend | undefined;
  let cashuWallet: WalletBackend | undefined;

  if (config.WALLET_BACKEND === 'lightning') {
    // Dynamically import to avoid importing lightning package when not needed
    const { initializeLightningBackend } = await import('./lib/lnd/lnd.startup.js');
    wallet = await initializeLightningBackend(db as unknown as Db);
  } else if (config.WALLET_BACKEND === 'cashu') {
    // Cashu-only mode: use Cashu ecash for all payments
    const { initializeCashuBackend } = await import('./lib/cashu/cashu.startup.js');
    cashuWallet = await initializeCashuBackend(db as unknown as Db);
  } else if (config.WALLET_BACKEND === 'auto') {
    // Dual-rail mode: initialize BOTH Lightning and Cashu backends.
    // paymentsService will automatically route based on amount threshold.
    const { initializeLightningBackend } = await import('./lib/lnd/lnd.startup.js');
    const { initializeCashuBackend } = await import('./lib/cashu/cashu.startup.js');
    wallet = await initializeLightningBackend(db as unknown as Db);
    cashuWallet = await initializeCashuBackend(db as unknown as Db);
  }
  // If WALLET_BACKEND === 'simulated', both remain undefined.
  // buildApp defaults to simulatedWallet when neither wallet is provided.

  const app = buildApp({ db, wallet, cashuWallet });

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`arbstr-vault started on port ${config.PORT} (wallet: ${config.WALLET_BACKEND})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Approval timeout checker — polls every 30s for expired pending approvals
  // Runs here (not in buildApp) so tests with in-memory DBs are never affected.
  const TIMEOUT_POLL_INTERVAL_MS = 30_000;
  const timeoutInterval = setInterval(() => {
    try {
      approvalsService.expireTimedOut(db as unknown as Db);
    } catch (err) {
      app.log.error({ err }, 'Approval timeout checker error');
    }
  }, TIMEOUT_POLL_INTERVAL_MS);

  // Clean up on shutdown
  app.addHook('onClose', () => {
    clearInterval(timeoutInterval);
  });
}

main();
