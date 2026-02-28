import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { agentAuth } from '../../middleware/agentAuth.js';
import { agentsRepo, policyVersionsRepo } from '../../modules/agents/agents.repo.js';
import { ledgerRepo } from '../../modules/ledger/ledger.repo.js';
import { auditRepo } from '../../modules/audit/audit.repo.js';
import { approvalsRepo } from '../../modules/approvals/approvals.repo.js';
import { webhookService } from '../../modules/webhook/webhook.service.js';
import { evaluatePolicy } from '../../modules/policy/policy.engine.js';
import { generateTransactionId } from '../../types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';

type DB = BetterSQLite3Database<typeof schema>;
type Db = BetterSQLite3Database<Record<string, never>>;

export const agentWithdrawalRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply agent auth to all routes in this scope
  app.addHook('onRequest', agentAuth);

  // POST /agents/:id/withdrawals — submit a withdrawal request
  app.post(
    '/agents/:id/withdrawals',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
        }),
        body: z.object({
          destination: z.string().min(1),
          amount_msat: z.number().int().positive(),
        }),
        response: {
          200: z.object({
            withdrawal_id: z.string(),
            transaction_id: z.string(),
            status: z.literal('PENDING_APPROVAL'),
            amount_msat: z.number(),
          }),
          400: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
          403: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
          404: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { destination, amount_msat } = request.body;

      // 1. Generate a unique transaction ID
      const txId = generateTransactionId();

      const db = app.db as unknown as DB;
      const narrowDb = app.db as unknown as Db;

      // 2. Read agent — return 404 if not found
      const agent = agentsRepo.findById(db, id);
      if (!agent) {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Agent not found' },
        });
      }

      // 3. Read current policy — return 403 if no policy configured
      const policy = policyVersionsRepo.getCurrent(db, id);
      if (!policy) {
        return reply.status(403).send({
          error: { code: 'no_policy_configured', message: 'No policy configured for this agent' },
        });
      }

      // 4. Run policy evaluation (Research Pitfall 6):
      //    Policy checks prevent over-limit withdrawals from entering the queue.
      //    Read balance and daily spend for evaluation.
      const balance = ledgerRepo.getBalance(narrowDb, id);
      const dailySpend = ledgerRepo.getDailySpend(narrowDb, id);

      const decision = evaluatePolicy(policy, {
        balance_msat: balance,
        daily_spent_msat: dailySpend,
        request_amount_msat: amount_msat,
      });

      // If DENY (not ALLOW or REQUIRE_HUMAN_APPROVAL), reject before entering queue
      if (decision.outcome === 'DENY') {
        return reply.status(400).send({
          error: { code: decision.reason, message: `Withdrawal denied: ${decision.reason}` },
        });
      }

      // 5. Withdrawals ALWAYS require approval (locked decision).
      //    Even if policy outcome is ALLOW, create a pending approval.
      //    Calculate expiresAt from the policy's approval_timeout_ms (default: 5 minutes).
      const approvalTimeoutMs = policy.approval_timeout_ms ?? 300_000;
      const expiresAt = new Date(Date.now() + approvalTimeoutMs);

      let approvalId = '';

      // IMMEDIATE transaction: RESERVE + pending_approvals + audit — all atomic
      db.transaction((tx) => {
        const tdb = tx as unknown as Db;

        // a. Write RESERVE: debits balance to hold funds during approval
        ledgerRepo.insert(tdb, {
          id: txId,
          agent_id: id,
          amount_msat: -amount_msat,
          entry_type: 'RESERVE',
          ref_id: txId,
          mode: 'simulated',
        });

        // b. Insert pending_approvals row with type='withdrawal'
        const approval = approvalsRepo.create(tdb, {
          agent_id: id,
          type: 'withdrawal',
          transaction_id: txId,
          amount_msat,
          destination,
          expires_at: expiresAt,
        });
        approvalId = approval.id;

        // c. Write WITHDRAWAL_REQUESTED audit entry
        auditRepo.insert(tdb, {
          agent_id: id,
          action: 'WITHDRAWAL_REQUESTED',
          amount_msat,
          ref_id: txId,
          metadata: {
            approval_id: approvalId,
            destination,
            expires_at: expiresAt.toISOString(),
          },
        });
      }, { behavior: 'immediate' });

      // 6. Fire webhook (non-blocking) — must not block the response
      webhookService.send({
        event: 'withdrawal_requested',
        agent_id: id,
        transaction_id: txId,
        amount_msat,
      }).catch(() => {});

      // 7. Return 200 with withdrawal details
      return reply.send({
        withdrawal_id: approvalId,
        transaction_id: txId,
        status: 'PENDING_APPROVAL' as const,
        amount_msat,
      });
    },
  );
};
