import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { internalAuth } from '../../middleware/internalAuth.js';
import { hashToken } from '../../modules/tokens/tokens.service.js';
import { agentsRepo, policyVersionsRepo } from '../../modules/agents/agents.repo.js';
import { evaluatePolicy } from '../../modules/policy/policy.engine.js';
import { ledgerRepo } from '../../modules/ledger/ledger.repo.js';
import { auditRepo } from '../../modules/audit/audit.repo.js';
import { generateTransactionId } from '../../types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

// ledgerRepo/auditRepo take the schema-less handle (same cast as payments.service.ts)
type Db = BetterSQLite3Database<Record<string, never>>;

export const internalBillingRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const ledgerDb = app.db as unknown as Db;

  // Gate all internal routes behind X-Internal-Token
  app.addHook('onRequest', internalAuth);

  app.post(
    '/internal/reserve',
    {
      schema: {
        body: z.object({
          agent_token: z.string(),              // raw vtk_ token
          amount_msats: z.number().int().nonnegative(), // 0 allowed: free local-tier providers
          correlation_id: z.string(),            // ties to arbstr request
          model: z.string(),                     // LLM model name
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
          403: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
            reason: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { agent_token, amount_msats, correlation_id, model } = request.body;

      // Step 1: Resolve agent from token
      const tokenHash = hashToken(agent_token);
      const agent = agentsRepo.findByTokenHash(app.db, tokenHash);
      if (!agent) {
        return reply.status(401).send({
          error: { code: 'invalid_agent_token', message: 'Invalid agent token' },
        });
      }

      // Step 2: Policy + balance check and RESERVE insert in one immediate
      // transaction, so concurrent reserves cannot both pass the same limit.
      // Same engine and fail-closed rules as /agents/:id/pay: a deny-all or
      // missing policy denies. The daily window counts settled PAYMENTs plus
      // open reservations. REQUIRE_HUMAN_APPROVAL is a deny here — billing is
      // synchronous and core cannot wait for an operator.
      const reservationId = generateTransactionId();
      const decision = app.db.transaction(() => {
        const policy =
          policyVersionsRepo.getVersionAt(app.db, agent.id, Date.now()) ??
          agentsRepo.getWithPolicy(app.db, agent.id)?.policy ??
          null;
        const balance = ledgerRepo.getBalance(ledgerDb, agent.id);
        const dailySpent =
          ledgerRepo.getDailySpend(ledgerDb, agent.id) + ledgerRepo.getOpenReservedTotal(ledgerDb, agent.id);
        const result = evaluatePolicy(policy, {
          balance_msat: balance,
          daily_spent_msat: dailySpent,
          request_amount_msat: amount_msats,
        });

        auditRepo.insert(ledgerDb, {
          agent_id: agent.id,
          action: 'PAYMENT_REQUEST',
          policy_decision: result.outcome,
          policy_reason: result.reason,
          amount_msat: amount_msats,
          ref_id: reservationId,
          metadata: { source: 'internal_billing', correlation_id, model },
        });

        if (result.outcome === 'ALLOW') {
          // Step 3: Insert RESERVE ledger entry
          // Amount is NEGATIVE (reserve reduces available balance)
          // mode is 'simulated' (all billing is ledger-only)
          ledgerRepo.insert(ledgerDb, {
            id: reservationId,
            agent_id: agent.id,
            amount_msat: -amount_msats,
            entry_type: 'RESERVE',
            ref_id: correlation_id,
            mode: 'simulated',
          });
        }
        return { ...result, balance };
      }, { behavior: 'immediate' });

      if (decision.reason === 'insufficient_balance') {
        return reply.status(402).send({
          error: { code: 'insufficient_balance', message: 'Insufficient balance for reservation' },
          current_balance_msats: decision.balance,
          requested_msats: amount_msats,
        });
      }
      if (decision.outcome !== 'ALLOW') {
        request.log.info({ agent_id: agent.id, reason: decision.reason, amount_msats }, 'reserve denied by policy');
        return reply.status(403).send({
          error: { code: 'policy_denied', message: `Reservation denied by agent policy: ${decision.reason}` },
          reason: decision.reason,
        });
      }

      // Step 4: Return reservation_id and remaining balance
      const remainingBalance = ledgerRepo.getBalance(ledgerDb, agent.id);
      return reply.send({
        reservation_id: reservationId,
        remaining_balance_msats: remainingBalance,
      });
    },
  );

  // POST /internal/settle — settle a reservation at actual cost
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
      const reserve = ledgerRepo.findById(ledgerDb, reservation_id);
      if (!reserve || reserve.entry_type !== 'RESERVE') {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Reservation not found' },
        });
      }
      const reserved_msats = Math.abs(reserve.amount_msat);

      // Step 2: Idempotency — a PAYMENT for this reservation means it was already
      // settled; replay the original outcome (first write wins).
      const priorPayment = ledgerRepo.findByRefIdAndType(ledgerDb, reservation_id, 'PAYMENT');
      if (priorPayment) {
        const charged = Math.abs(priorPayment.amount_msat);
        return reply.send({
          settled: true as const,
          refunded_msats: reserved_msats - charged,
          actual_msats: charged,
          remaining_balance_msats: ledgerRepo.getBalance(ledgerDb, reserve.agent_id),
        });
      }

      // A RELEASE without a PAYMENT means the hold was already returned. Charging
      // now would debit funds that are no longer held, so refuse instead.
      if (ledgerRepo.findByRefIdAndType(ledgerDb, reservation_id, 'RELEASE')) {
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
        ledgerRepo.insert(ledgerDb, {
          id: generateTransactionId(),
          agent_id: reserve.agent_id,
          amount_msat: reserved_msats,
          entry_type: 'RELEASE',
          ref_id: reservation_id,
          mode: 'simulated',
        });
        // b. PAYMENT entry debits the actual cost
        ledgerRepo.insert(ledgerDb, {
          id: generateTransactionId(),
          agent_id: reserve.agent_id,
          amount_msat: -actual_msats,
          entry_type: 'PAYMENT',
          ref_id: reservation_id,
          mode: 'simulated',
        });
        // c. Audit entry records settlement metadata
        auditRepo.insert(ledgerDb, {
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
      const remainingBalance = ledgerRepo.getBalance(ledgerDb, reserve.agent_id);
      return reply.send({
        settled: true as const,
        refunded_msats: reserved_msats - actual_msats,
        actual_msats,
        remaining_balance_msats: remainingBalance,
      });
    },
  );

  // POST /internal/release — release an unused reservation
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
      const reserve = ledgerRepo.findById(ledgerDb, reservation_id);
      if (!reserve || reserve.entry_type !== 'RESERVE') {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Reservation not found' },
        });
      }

      // Step 2: A settled reservation cannot be released — the caller must not
      // believe it refunded the buyer when the charge already stands.
      if (ledgerRepo.findByRefIdAndType(ledgerDb, reservation_id, 'PAYMENT')) {
        return reply.status(409).send({
          error: { code: 'already_settled', message: 'Reservation was already settled' },
        });
      }

      // Idempotency: a RELEASE without a PAYMENT means it was already released
      const existing = ledgerRepo.findByRefIdAndType(ledgerDb, reservation_id, 'RELEASE');
      if (existing) {
        return reply.send({ released: true as const });
      }

      // Step 3: Insert RELEASE entry to return reserved balance
      ledgerRepo.insert(ledgerDb, {
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
