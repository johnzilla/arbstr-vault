import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { adminAuth } from '../../middleware/adminAuth.js';
import { auditLog } from '../../db/schema.js';
import { auditRepo } from '../../modules/audit/audit.repo.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type Db = BetterSQLite3Database<Record<string, never>>;

const ACTIONS = auditLog.action.enumValues;

export const adminAuditRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply admin auth to all routes in this scope
  app.addHook('onRequest', adminAuth);

  // GET /operator/audit — audit log across all agents, newest first
  app.get(
    '/operator/audit',
    {
      schema: {
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          // An agent id, or "system" for entries not tied to an agent
          agent_id: z.string().min(1).optional(),
          // One action or a comma-separated list, e.g. WEBHOOK_DELIVERY_FAILED,APPROVAL_TIMEOUT
          action: z.string()
            .transform((s) => s.split(',').map((a) => a.trim()).filter(Boolean))
            .pipe(z.array(z.enum(ACTIONS)).min(1))
            .optional(),
          ref_id: z.string().min(1).optional(),
          start_date: z.coerce.number().int().optional(),
          end_date: z.coerce.number().int().optional(),
        }).refine(
          (q) => q.start_date === undefined || q.end_date === undefined || q.start_date <= q.end_date,
          { message: 'start_date must not be after end_date', path: ['start_date'] },
        ),
        response: {
          200: z.object({
            entries: z.array(
              z.object({
                id: z.string(),
                agent_id: z.string(),
                action: z.string(),
                policy_decision: z.string().nullable(),
                policy_reason: z.string().nullable(),
                amount_msat: z.number().nullable(),
                ref_id: z.string().nullable(),
                metadata: z.record(z.string(), z.unknown()).nullable(),
                created_at: z.date(),
              }),
            ),
            next_cursor: z.string().nullable(),
            has_more: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { cursor, limit, agent_id, action, ref_id, start_date, end_date } = request.query;

      const rows = auditRepo.listForOperator(app.db as unknown as Db, {
        cursor,
        limit: limit + 1,
        agent_id,
        actions: action,
        ref_id,
        start_date,
        end_date,
      });

      const has_more = rows.length > limit;
      const entries = has_more ? rows.slice(0, limit) : rows;
      const lastEntry = entries[entries.length - 1];

      return reply.send({
        entries: entries.map((e) => ({
          id: e.id,
          agent_id: e.agent_id,
          action: e.action,
          policy_decision: e.policy_decision ?? null,
          policy_reason: e.policy_reason ?? null,
          amount_msat: e.amount_msat ?? null,
          ref_id: e.ref_id ?? null,
          metadata: e.metadata ?? null,
          created_at: e.created_at,
        })),
        next_cursor: has_more && lastEntry ? lastEntry.id : null,
        has_more,
      });
    },
  );
};
