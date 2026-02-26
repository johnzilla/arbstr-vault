import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { agentAuth } from '../../middleware/agentAuth.js';
import { paymentsService } from '../../modules/payments/payments.service.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';

type DB = BetterSQLite3Database<typeof schema>;

export const agentPaymentRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply agent auth to all routes in this scope
  app.addHook('onRequest', agentAuth);

  // POST /agents/:id/pay — submit a payment request
  app.post(
    '/agents/:id/pay',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
        }),
        body: z.object({
          amount_msat: z.number().int().positive(),
          asset: z.enum(['BTC_simulated']),
          purpose: z.string().min(1).max(200),
          destination_type: z.enum(['lightning_invoice', 'cashu_token', 'internal']),
          destination: z.string().min(1).max(2000),
        }),
        response: {
          200: z.object({
            transaction_id: z.string(),
            policy_decision: z.enum(['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL']),
            reason: z.string().optional(),
            mode: z.literal('simulated'),
            status: z.enum(['SETTLED', 'PENDING', 'FAILED']),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const db = app.db as unknown as DB;

      // Process payment — always returns 200 regardless of policy decision.
      // HTTP status reflects request processing success; policy_decision reflects outcome.
      const result = await paymentsService.processPayment(db, id, body);

      return reply.send({
        transaction_id: result.transaction_id,
        policy_decision: result.policy_decision,
        reason: result.reason,
        mode: 'simulated' as const,
        status: result.status,
      });
    },
  );
};
