import Fastify from 'fastify';
import type { DestinationStream } from 'pino';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { adminAgentRoutes } from './routes/admin/agents.routes.js';
import { adminDepositRoutes } from './routes/admin/deposit.routes.js';
import { agentBalanceRoutes } from './routes/agent/balance.routes.js';
import { agentHistoryRoutes } from './routes/agent/history.routes.js';
import { agentPaymentRoutes } from './routes/agent/payments.routes.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema.js';
import { db as defaultDb } from './db/client.js';
import { loggerConfig } from './plugins/pino.plugin.js';

type DB = BetterSQLite3Database<typeof schema>;

export interface BuildAppOptions {
  /** Optional injected database — used in tests for in-memory isolation */
  db?: DB;
  /** Optional pino destination stream — used in tests to capture log output */
  loggerStream?: DestinationStream;
}

/**
 * Build the Fastify application.
 *
 * Accepts either:
 * - No arguments: uses default DB and default logger
 * - A DB directly (legacy): buildApp(db)
 * - An options object: buildApp({ db, loggerStream })
 */
export function buildApp(injectedDb?: DB, options?: BuildAppOptions): ReturnType<typeof Fastify>;
export function buildApp(options?: BuildAppOptions): ReturnType<typeof Fastify>;
export function buildApp(
  injectedDbOrOptions?: DB | BuildAppOptions,
  options?: BuildAppOptions,
): ReturnType<typeof Fastify> {
  let db: DB | undefined;
  let loggerStream: DestinationStream | undefined;

  if (injectedDbOrOptions == null) {
    // buildApp() — no args
    db = undefined;
    loggerStream = options?.loggerStream;
  } else if (
    typeof injectedDbOrOptions === 'object' &&
    ('db' in injectedDbOrOptions || 'loggerStream' in injectedDbOrOptions)
  ) {
    // buildApp({ db?, loggerStream? }) — options object
    const opts = injectedDbOrOptions as BuildAppOptions;
    db = opts.db;
    loggerStream = opts.loggerStream;
  } else {
    // buildApp(db) — legacy: first arg is a DB instance
    db = injectedDbOrOptions as DB;
    loggerStream = options?.loggerStream;
  }

  const app = Fastify({
    logger: loggerStream ? { ...loggerConfig, stream: loggerStream } : loggerConfig,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register db as a decorator so routes and middleware can access it
  app.decorate('db', db ?? defaultDb);

  // Health check
  app.get('/health', async (_request, _reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Admin routes (operator-scoped)
  app.register(adminAgentRoutes);
  app.register(adminDepositRoutes);

  // Agent routes (agent-scoped)
  app.register(agentBalanceRoutes);
  app.register(agentHistoryRoutes);
  app.register(agentPaymentRoutes);

  return app;
}
