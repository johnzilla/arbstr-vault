import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { adminAuth } from '../../middleware/adminAuth.js';
import { approvalsRepo } from '../../modules/approvals/approvals.repo.js';
import { ledgerRepo } from '../../modules/ledger/ledger.repo.js';
import { auditRepo } from '../../modules/audit/audit.repo.js';
import { webhookService } from '../../modules/webhook/webhook.service.js';
import { pendingApprovals } from '../../db/schema.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type Db = BetterSQLite3Database<Record<string, never>>;

export const adminApprovalsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply admin auth to all routes in this scope
  app.addHook('onRequest', adminAuth);

  // POST /operator/approvals/:id/approve — Operator approves a pending payment
  app.post(
    '/operator/approvals/:id/approve',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('apr_'),
        }),
        response: {
          200: z.object({
            approval_id: z.string(),
            status: z.enum(['approved']),
            transaction_id: z.string(),
            agent_id: z.string(),
            amount_msat: z.number(),
            payment_status: z.enum(['APPROVED']),
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
      const { id } = request.params;
      const db = app.db as unknown as Db;

      // 1. Read the approval row
      const approval = approvalsRepo.findById(db, id);
      if (!approval) {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Approval not found' },
        });
      }

      // 2. CAS claim — returns undefined if already resolved
      const claimed = approvalsRepo.claimForResolution(db, id, 'approved');
      if (!claimed) {
        return reply.status(409).send({
          error: { code: 'conflict', message: 'Approval already resolved' },
        });
      }

      // 3. Write APPROVAL_GRANTED audit entry
      db.transaction((tdb) => {
        const narrowDb = tdb as unknown as Db;
        auditRepo.insert(narrowDb, {
          agent_id: claimed.agent_id,
          action: 'APPROVAL_GRANTED',
          amount_msat: claimed.amount_msat,
          ref_id: claimed.transaction_id,
          metadata: { approval_id: id },
        });
      }, { behavior: 'immediate' });

      // 4. Fire webhook non-blocking
      webhookService.send({
        event: 'approval_granted',
        agent_id: claimed.agent_id,
        transaction_id: claimed.transaction_id,
        amount_msat: claimed.amount_msat,
      }).catch(() => {});

      return reply.send({
        approval_id: claimed.id,
        status: 'approved' as const,
        transaction_id: claimed.transaction_id,
        agent_id: claimed.agent_id,
        amount_msat: claimed.amount_msat,
        payment_status: 'APPROVED' as const,
      });
    },
  );

  // POST /operator/approvals/:id/deny — Operator denies a pending payment
  app.post(
    '/operator/approvals/:id/deny',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('apr_'),
        }),
        response: {
          200: z.object({
            approval_id: z.string(),
            status: z.enum(['denied']),
            transaction_id: z.string(),
            agent_id: z.string(),
            amount_msat: z.number(),
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
      const { id } = request.params;
      const db = app.db as unknown as Db;

      // 1. Read the approval row
      const approval = approvalsRepo.findById(db, id);
      if (!approval) {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Approval not found' },
        });
      }

      // 2. CAS claim — returns undefined if already resolved
      const claimed = approvalsRepo.claimForResolution(db, id, 'denied');
      if (!claimed) {
        return reply.status(409).send({
          error: { code: 'conflict', message: 'Approval already resolved' },
        });
      }

      // 3. Write RELEASE + APPROVAL_DENIED audit atomically
      db.transaction((tdb) => {
        const narrowDb = tdb as unknown as Db;

        // Write RELEASE to restore the reserved balance
        ledgerRepo.insert(narrowDb, {
          agent_id: claimed.agent_id,
          amount_msat: claimed.amount_msat,
          entry_type: 'RELEASE',
          ref_id: claimed.transaction_id,
          mode: 'simulated',
        });

        // Write APPROVAL_DENIED audit entry
        auditRepo.insert(narrowDb, {
          agent_id: claimed.agent_id,
          action: 'APPROVAL_DENIED',
          amount_msat: claimed.amount_msat,
          ref_id: claimed.transaction_id,
          metadata: { approval_id: id },
        });
      }, { behavior: 'immediate' });

      // 4. Fire webhook non-blocking
      webhookService.send({
        event: 'approval_denied',
        agent_id: claimed.agent_id,
        transaction_id: claimed.transaction_id,
        amount_msat: claimed.amount_msat,
      }).catch(() => {});

      return reply.send({
        approval_id: claimed.id,
        status: 'denied' as const,
        transaction_id: claimed.transaction_id,
        agent_id: claimed.agent_id,
        amount_msat: claimed.amount_msat,
      });
    },
  );

  // GET /operator/approvals — List pending approvals for the operator dashboard
  app.get(
    '/operator/approvals',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['pending', 'all']).optional().default('pending'),
        }),
        response: {
          200: z.object({
            approvals: z.array(
              z.object({
                id: z.string(),
                agent_id: z.string(),
                type: z.enum(['payment', 'withdrawal']),
                transaction_id: z.string(),
                amount_msat: z.number(),
                destination: z.string().nullable(),
                status: z.enum(['pending', 'approved', 'denied', 'timed_out']),
                expires_at: z.string(),
                resolved_at: z.string().nullable(),
                created_at: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const { status } = request.query;
      const db = app.db as unknown as Db;

      const approvals = status === 'all'
        ? db.select().from(pendingApprovals).all()
        : approvalsRepo.listPending(db);

      return reply.send({
        approvals: approvals.map((a) => ({
          id: a.id,
          agent_id: a.agent_id,
          type: a.type,
          transaction_id: a.transaction_id,
          amount_msat: a.amount_msat,
          destination: a.destination ?? null,
          status: a.status,
          expires_at: a.expires_at.toISOString(),
          resolved_at: a.resolved_at ? a.resolved_at.toISOString() : null,
          created_at: a.created_at.toISOString(),
        })),
      });
    },
  );
};
