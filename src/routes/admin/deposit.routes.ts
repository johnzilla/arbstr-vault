import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { adminAuth } from '../../middleware/adminAuth.js';
import { agentsRepo } from '../../modules/agents/agents.repo.js';
import { ledgerEntries, auditLog } from '../../db/schema.js';
import { ulid } from 'ulidx';
import { eq, sql } from 'drizzle-orm';

export const adminDepositRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply admin auth — only operators can deposit
  app.addHook('onRequest', adminAuth);

  // POST /agents/:id/deposit — fund an agent's sub-account
  app.post(
    '/agents/:id/deposit',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
        }),
        body: z.object({
          amount_msat: z.number().int().positive(),
        }),
        response: {
          200: z.object({
            agent_id: z.string(),
            amount_msat: z.number(),
            balance_msat: z.number(),
            transaction_id: z.string(),
          }),
          404: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { amount_msat } = request.body;

      // Verify agent exists
      const agent = agentsRepo.findById(app.db, id);
      if (!agent) {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Agent not found' },
        });
      }

      const transactionId = `tx_${ulid()}`;
      const auditId = ulid();

      // Insert ledger entry and audit log in the same transaction
      app.db.transaction(() => {
        app.db
          .insert(ledgerEntries)
          .values({
            id: transactionId,
            agent_id: id,
            amount_msat: amount_msat,
            entry_type: 'DEPOSIT',
          })
          .run();

        app.db
          .insert(auditLog)
          .values({
            id: auditId,
            agent_id: id,
            action: 'DEPOSIT',
            amount_msat: amount_msat,
            ref_id: transactionId,
          })
          .run();
      });

      // Calculate new balance
      const balanceResult = app.db
        .select({ total: sql<number>`COALESCE(SUM(amount_msat), 0)` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.agent_id, id))
        .get();

      const balance_msat = balanceResult?.total ?? 0;

      return reply.send({
        agent_id: id,
        amount_msat,
        balance_msat,
        transaction_id: transactionId,
      });
    },
  );
};
