import Fastify from 'fastify';
import type { DestinationStream } from 'pino';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { adminAgentRoutes } from './routes/admin/agents.routes.js';
import { adminDepositRoutes } from './routes/admin/deposit.routes.js';
import { adminApprovalsRoutes } from './routes/admin/approvals.routes.js';
import { adminDashboardRoutes } from './routes/admin/dashboard.routes.js';
import { agentBalanceRoutes } from './routes/agent/balance.routes.js';
import { agentHistoryRoutes } from './routes/agent/history.routes.js';
import { agentPaymentRoutes } from './routes/agent/payments.routes.js';
import { agentPaymentStatusRoutes } from './routes/agent/payment-status.routes.js';
import { agentWithdrawalRoutes } from './routes/agent/withdrawals.routes.js';
import { internalBillingRoutes } from './routes/internal/reserve.routes.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema.js';
import { db as defaultDb } from './db/client.js';
import { loggerConfig } from './plugins/pino.plugin.js';
import { createPaymentsService } from './modules/payments/payments.service.js';
import { simulatedWallet } from './modules/payments/wallet/simulated.wallet.js';
import type { WalletBackend } from './modules/payments/wallet/wallet.interface.js';
import { config } from './config.js';

type DB = BetterSQLite3Database<typeof schema>;

// Type for the paymentsService instance stored on the app decorator
type PaymentsService = ReturnType<typeof createPaymentsService>;

export interface BuildAppOptions {
  /** Optional injected database — used in tests for in-memory isolation */
  db?: DB;
  /** Optional pino destination stream — used in tests to capture log output */
  loggerStream?: DestinationStream;
  /** Optional wallet backend — defaults to simulatedWallet if not provided */
  wallet?: WalletBackend;
  /** Optional Cashu wallet backend — used alongside wallet for dual-rail routing */
  cashuWallet?: WalletBackend;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    paymentsService: PaymentsService;
  }
}

/**
 * Build the Fastify application.
 *
 * Accepts either:
 * - No arguments: uses default DB and default logger and simulated wallet
 * - A DB directly (legacy): buildApp(db)
 * - An options object: buildApp({ db, loggerStream, wallet })
 *
 * The wallet backend is stored as a Fastify decorator (app.paymentsService).
 * Routes read from app.paymentsService rather than importing paymentsService directly.
 * This enables wallet injection for both production (Lightning) and tests (simulated).
 *
 * IMPORTANT: Do NOT connect to LND inside buildApp — call initializeLightningBackend
 * before buildApp and pass the resulting wallet in options.wallet.
 */
export function buildApp(injectedDb?: DB, options?: BuildAppOptions): ReturnType<typeof Fastify>;
export function buildApp(options?: BuildAppOptions): ReturnType<typeof Fastify>;
export function buildApp(
  injectedDbOrOptions?: DB | BuildAppOptions,
  options?: BuildAppOptions,
): ReturnType<typeof Fastify> {
  let db: DB | undefined;
  let loggerStream: DestinationStream | undefined;
  let wallet: WalletBackend | undefined;
  let cashuWallet: WalletBackend | undefined;

  if (injectedDbOrOptions == null) {
    // buildApp() — no args
    db = undefined;
    loggerStream = options?.loggerStream;
    wallet = options?.wallet;
    cashuWallet = options?.cashuWallet;
  } else if (
    typeof injectedDbOrOptions === 'object' &&
    (
      'db' in injectedDbOrOptions ||
      'loggerStream' in injectedDbOrOptions ||
      'wallet' in injectedDbOrOptions ||
      'cashuWallet' in injectedDbOrOptions
    )
  ) {
    // buildApp({ db?, loggerStream?, wallet?, cashuWallet? }) — options object
    const opts = injectedDbOrOptions as BuildAppOptions;
    db = opts.db;
    loggerStream = opts.loggerStream;
    wallet = opts.wallet;
    cashuWallet = opts.cashuWallet;
  } else {
    // buildApp(db) — legacy: first arg is a DB instance
    db = injectedDbOrOptions as DB;
    loggerStream = options?.loggerStream;
    wallet = options?.wallet;
    cashuWallet = options?.cashuWallet;
  }

  const app = Fastify({
    logger: loggerStream ? { ...loggerConfig, stream: loggerStream } : loggerConfig,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register db as a decorator so routes and middleware can access it
  app.decorate('db', db ?? defaultDb);

  // Register paymentsService as a decorator bound to the selected wallet backend.
  // Routes use app.paymentsService instead of importing paymentsService directly.
  // When cashuWallet is provided, create a dual-wallet service for automatic routing.
  // Otherwise, fall back to the single-wallet backward-compat mode.
  if (cashuWallet) {
    app.decorate('paymentsService', createPaymentsService({
      simulatedWallet,
      lightningWallet: wallet !== simulatedWallet ? wallet : undefined,
      cashuWallet,
    }));
  } else {
    app.decorate('paymentsService', createPaymentsService(wallet ?? simulatedWallet));
  }

  // Health check
  app.get('/health', async (_request, _reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Admin routes (operator-scoped)
  app.register(adminAgentRoutes);
  app.register(adminDepositRoutes);
  app.register(adminApprovalsRoutes);
  app.register(adminDashboardRoutes);

  // Agent routes (agent-scoped)
  app.register(agentBalanceRoutes);
  app.register(agentHistoryRoutes);
  app.register(agentPaymentRoutes);
  app.register(agentPaymentStatusRoutes);
  app.register(agentWithdrawalRoutes);

  // Internal billing routes (only when VAULT_INTERNAL_TOKEN is configured)
  if (config.VAULT_INTERNAL_TOKEN) {
    app.register(internalBillingRoutes);
  }

  return app;
}
