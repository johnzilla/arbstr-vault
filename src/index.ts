import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { buildApp } from './app.js';
import { config } from './config.js';
import { db } from './db/client.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Run database migrations before starting the server
  migrate(db, { migrationsFolder: join(__dirname, 'db/migrations') });

  const app = buildApp();

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Vaultwarden started on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
