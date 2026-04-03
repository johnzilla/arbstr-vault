import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { internalAuth } from '../../middleware/internalAuth.js';
import { hashToken } from '../../modules/tokens/tokens.service.js';
import { agentsRepo } from '../../modules/agents/agents.repo.js';
import { ledgerRepo } from '../../modules/ledger/ledger.repo.js';
import { auditRepo } from '../../modules/audit/audit.repo.js';
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

  // POST /internal/settle — settle a reservation at actual cost (per BILL-05..BILL-08)
  app.post(
    '/internal/settle',
    {
      schema: {
        body: z.object({
          reservation_id: z.string(),
          actual_msats: z.number().int().positive(),
          tokens_in: z.number().int().nonnegative(),
          tokens_out: z.number().int().nonnegative(),
          provider: z.string(),
          latency_ms: z.number().int().nonnegative(),
        }),
        response: {
          200: z.object({
            settled: z.literal(true),
            refunded_msats: z.number(),
            actual_msats: z.number(),
            remaining_balance_msats: z.number(),
          }),
          404: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { reservation_id, actual_msats, tokens_in, tokens_out, provider, latency_ms } = request.body;

      // Step 1: Look up RESERVE entry
      const reserve = ledgerRepo.findById(app.db, reservation_id);
      if (!reserve || reserve.entry_type !== 'RESERVE') {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Reservation not found' },
        });
      }

      // Step 2: Idempotency check — if RELEASE already exists, settle already happened
      const existing = ledgerRepo.findByRefIdAndType(app.db, reservation_id, 'RELEASE');
      if (existing) {
        const remainingBalance = ledgerRepo.getBalance(app.db, reserve.agent_id);
        return reply.send({
          settled: true as const,
          refunded_msats: Math.abs(reserve.amount_msat) - actual_msats,
          actual_msats,
          remaining_balance_msats: remainingBalance,
        });
      }

      // Step 3: Atomic transaction — RELEASE + PAYMENT + audit
      app.db.transaction(() => {
        // a. RELEASE entry restores the reserved amount
        ledgerRepo.insert(app.db, {
          id: generateTransactionId(),
          agent_id: reserve.agent_id,
          amount_msat: Math.abs(reserve.amount_msat),
          entry_type: 'RELEASE',
          ref_id: reservation_id,
          mode: 'simulated',
        });
        // b. PAYMENT entry debits the actual cost
        ledgerRepo.insert(app.db, {
          id: generateTransactionId(),
          agent_id: reserve.agent_id,
          amount_msat: -actual_msats,
          entry_type: 'PAYMENT',
          ref_id: reservation_id,
          mode: 'simulated',
        });
        // c. Audit entry records settlement metadata
        auditRepo.insert(app.db, {
          agent_id: reserve.agent_id,
          action: 'PAYMENT_SETTLED',
          amount_msat: actual_msats,
          ref_id: reservation_id,
          metadata: { tokens_in, tokens_out, provider, latency_ms },
        });
      });

      // Step 4: Return settled response with remaining balance
      const remainingBalance = ledgerRepo.getBalance(app.db, reserve.agent_id);
      return reply.send({
        settled: true as const,
        refunded_msats: Math.abs(reserve.amount_msat) - actual_msats,
        actual_msats,
        remaining_balance_msats: remainingBalance,
      });
    },
  );

  // POST /internal/release — release an unused reservation (per BILL-09, BILL-10)
  app.post(
    '/internal/release',
    {
      schema: {
        body: z.object({
          reservation_id: z.string(),
        }),
        response: {
          200: z.object({
            released: z.literal(true),
          }),
          404: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { reservation_id } = request.body;

      // Step 1: Look up RESERVE entry
      const reserve = ledgerRepo.findById(app.db, reservation_id);
      if (!reserve || reserve.entry_type !== 'RESERVE') {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Reservation not found' },
        });
      }

      // Step 2: Idempotency check — if RELEASE already exists, already released
      const existing = ledgerRepo.findByRefIdAndType(app.db, reservation_id, 'RELEASE');
      if (existing) {
        return reply.send({ released: true as const });
      }

      // Step 3: Insert RELEASE entry to return reserved balance
      ledgerRepo.insert(app.db, {
        id: generateTransactionId(),
        agent_id: reserve.agent_id,
        amount_msat: Math.abs(reserve.amount_msat),
        entry_type: 'RELEASE',
        ref_id: reservation_id,
        mode: 'simulated',
      });

      return reply.send({ released: true as const });
    },
  );
};
