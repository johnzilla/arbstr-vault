import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { buildApp } from './app.js';
import { config } from './config.js';
import { db } from './db/client.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { WalletBackend } from './modules/payments/wallet/wallet.interface.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Narrow DB type for startup modules (lnd.startup.ts uses ledger/audit repos)
type Db = BetterSQLite3Database<Record<string, never>>;

async function main() {
  // Run database migrations before starting the server
  migrate(db, { migrationsFolder: join(__dirname, 'db/migrations') });

  // Select wallet backend based on WALLET_BACKEND config
  let wallet: WalletBackend | undefined;

  if (config.WALLET_BACKEND === 'lightning') {
    // Dynamically import to avoid importing lightning package when not needed
    const { initializeLightningBackend } = await import('./lib/lnd/lnd.startup.js');
    wallet = await initializeLightningBackend(db as unknown as Db);
  }
  // If WALLET_BACKEND === 'simulated', wallet remains undefined
  // buildApp defaults to simulatedWallet when wallet is not provided

  const app = buildApp({ db, wallet });

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Vaultwarden started on port ${config.PORT} (wallet: ${config.WALLET_BACKEND})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
