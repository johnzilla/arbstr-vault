import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config } from './config.js';
import { adminAgentRoutes } from './routes/admin/agents.routes.js';
import { adminDepositRoutes } from './routes/admin/deposit.routes.js';
import { agentBalanceRoutes } from './routes/agent/balance.routes.js';
import { agentHistoryRoutes } from './routes/agent/history.routes.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema.js';
import { db as defaultDb } from './db/client.js';

type DB = BetterSQLite3Database<typeof schema>;

export function buildApp(injectedDb?: DB) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register db as a decorator so routes and middleware can access it
  app.decorate('db', injectedDb ?? defaultDb);

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

  return app;
}
