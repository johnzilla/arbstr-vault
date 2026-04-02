import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { internalAuth } from '../../middleware/internalAuth.js';
import { hashToken } from '../../modules/tokens/tokens.service.js';
import { agentsRepo } from '../../modules/agents/agents.repo.js';
import { ledgerRepo } from '../../modules/ledger/ledger.repo.js';
import { generateTransactionId } from '../../types.js';

export const internalBillingRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Gate all internal routes behind X-Internal-Token (per D-01)
  app.addHook('onRequest', internalAuth);

  app.post(
    '/internal/reserve',
    {
      schema: {
        body: z.object({
          agent_token: z.string(),              // per D-05: raw vtk_ token
          amount_msats: z.number().int().positive(), // per D-06: positive integer
          correlation_id: z.string(),            // per D-05: ties to arbstr request
          model: z.string(),                     // per D-05: LLM model name
        }),
        response: {
          200: z.object({
            reservation_id: z.string(),
            remaining_balance_msats: z.number(),
          }),
          401: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
          402: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
            current_balance_msats: z.number(),
            requested_msats: z.number(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { agent_token, amount_msats, correlation_id } = request.body;

      // Step 1: Resolve agent from token (per BILL-02, D-05)
      const tokenHash = hashToken(agent_token);
      const agent = agentsRepo.findByTokenHash(app.db, tokenHash);
      if (!agent) {
        return reply.status(401).send({
          error: { code: 'unauthorized', message: 'Invalid agent token' },
        });
      }

      // Step 2: Check balance (per BILL-03)
      const balance = ledgerRepo.getBalance(app.db, agent.id);
      if (balance < amount_msats) {
        return reply.status(402).send({
          error: { code: 'insufficient_balance', message: 'Insufficient balance for reservation' },
          current_balance_msats: balance,
          requested_msats: amount_msats,
        });
      }

      // Step 3: Insert RESERVE ledger entry (per BILL-04)
      // Amount is NEGATIVE (reserve reduces available balance)
      // mode is 'simulated' (per D-10, all billing is ledger-only)
      const reservationId = generateTransactionId();
      ledgerRepo.insert(app.db, {
        id: reservationId,
        agent_id: agent.id,
        amount_msat: -amount_msats,
        entry_type: 'RESERVE',
        ref_id: correlation_id,
        mode: 'simulated',
      });

      // Step 4: Return reservation_id and remaining balance (per D-08)
      const remainingBalance = ledgerRepo.getBalance(app.db, agent.id);
      return reply.send({
        reservation_id: reservationId,
        remaining_balance_msats: remainingBalance,
      });
    },
  );
};
