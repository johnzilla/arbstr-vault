import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { agentAuth } from '../../middleware/agentAuth.js';
import { ledgerEntries } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export const agentBalanceRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply agent auth to all routes in this scope
  app.addHook('onRequest', agentAuth);

  // GET /agents/:id/balance — get current balance derived from ledger SUM
  app.get(
    '/agents/:id/balance',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
        }),
        response: {
          200: z.object({
            agent_id: z.string(),
            balance_msat: z.number(),
            asset: z.literal('BTC_simulated'),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const result = app.db
        .select({ total: sql<number>`COALESCE(SUM(amount_msat), 0)` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.agent_id, id))
        .get();

      return reply.send({
        agent_id: id,
        balance_msat: result?.total ?? 0,
        asset: 'BTC_simulated' as const,
      });
    },
  );
};
