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
          amount_msats: z.number().int().nonnegative(), // 0 allowed: free local-tier providers
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
  //
  // Body shape matches arbstr core's VaultClient::settle: usage details nested
  // under `metadata`, with tokens as Option<u32> (null when the provider did not
  // report usage). The legacy flat shape is still accepted; nested wins.
  app.post(
    '/internal/settle',
    {
      schema: {
        body: z.object({
          reservation_id: z.string(),
          actual_msats: z.number().int().nonnegative(),
          metadata: z.object({
            tokens_in: z.number().int().nonnegative().nullish(),
            tokens_out: z.number().int().nonnegative().nullish(),
            provider: z.string(),
            latency_ms: z.number().int().nonnegative(),
          }).optional(),
          // Legacy flat fields (pre-contract-fix callers)
          tokens_in: z.number().int().nonnegative().nullish(),
          tokens_out: z.number().int().nonnegative().nullish(),
          provider: z.string().optional(),
          latency_ms: z.number().int().nonnegative().optional(),
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
          409: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { reservation_id, actual_msats: requested_msats } = request.body;
      const meta = request.body.metadata ?? request.body;
      const tokens_in = meta.tokens_in ?? null;
      const tokens_out = meta.tokens_out ?? null;
      const provider = meta.provider ?? null;
      const latency_ms = meta.latency_ms ?? null;

      // Step 1: Look up RESERVE entry
      const reserve = ledgerRepo.findById(app.db, reservation_id);
      if (!reserve || reserve.entry_type !== 'RESERVE') {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Reservation not found' },
        });
      }
      const reserved_msats = Math.abs(reserve.amount_msat);

      // Step 2: Idempotency — a PAYMENT for this reservation means it was already
      // settled; replay the original outcome (first write wins).
      const priorPayment = ledgerRepo.findByRefIdAndType(app.db, reservation_id, 'PAYMENT');
      if (priorPayment) {
        const charged = Math.abs(priorPayment.amount_msat);
        return reply.send({
          settled: true as const,
          refunded_msats: reserved_msats - charged,
          actual_msats: charged,
          remaining_balance_msats: ledgerRepo.getBalance(app.db, reserve.agent_id),
        });
      }

      // A RELEASE without a PAYMENT means the hold was already returned. Charging
      // now would debit funds that are no longer held, so refuse instead.
      if (ledgerRepo.findByRefIdAndType(app.db, reservation_id, 'RELEASE')) {
        request.log.warn({ reservation_id }, 'settle refused: reservation already released');
        return reply.status(409).send({
          error: { code: 'already_released', message: 'Reservation was already released' },
        });
      }

      // Never charge more than was held: the reservation is the authorized maximum.
      const actual_msats = Math.min(requested_msats, reserved_msats);
      const capped = requested_msats > reserved_msats;
      if (capped) {
        request.log.warn({ reservation_id, requested_msats, reserved_msats }, 'settle capped at reserved amount');
      }

      // Step 3: Atomic transaction — RELEASE + PAYMENT + audit
      app.db.transaction(() => {
        // a. RELEASE entry restores the reserved amount
        ledgerRepo.insert(app.db, {
          id: generateTransactionId(),
          agent_id: reserve.agent_id,
          amount_msat: reserved_msats,
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
          metadata: {
            tokens_in, tokens_out, provider, latency_ms,
            ...(capped ? { capped: true, requested_msats } : {}),
          },
        });
      });

      // Step 4: Return settled response with remaining balance
      const remainingBalance = ledgerRepo.getBalance(app.db, reserve.agent_id);
      return reply.send({
        settled: true as const,
        refunded_msats: reserved_msats - actual_msats,
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
          reason: z.string().optional(), // sent by arbstr core; informational only
        }),
        response: {
          200: z.object({
            released: z.literal(true),
          }),
          404: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
          409: z.object({
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

      // Step 2: A settled reservation cannot be released — the caller must not
      // believe it refunded the buyer when the charge already stands.
      if (ledgerRepo.findByRefIdAndType(app.db, reservation_id, 'PAYMENT')) {
        return reply.status(409).send({
          error: { code: 'already_settled', message: 'Reservation was already settled' },
        });
      }

      // Idempotency: a RELEASE without a PAYMENT means it was already released
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
