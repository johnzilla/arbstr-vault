import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { agentAuth } from '../../middleware/agentAuth.js';
import { auditLog } from '../../db/schema.js';
import { eq, and, gt, gte, lte, asc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

const ACTION_TYPES = [
  'AGENT_REGISTERED',
  'POLICY_UPDATED',
  'PAYMENT_REQUEST',
  'PAYMENT_SETTLED',
  'PAYMENT_FAILED',
  'DEPOSIT',
] as const;

export const agentHistoryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply agent auth to all routes in this scope
  app.addHook('onRequest', agentAuth);

  // GET /agents/:id/history — paginated audit log for agent
  app.get(
    '/agents/:id/history',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
        }),
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          action_type: z.enum(ACTION_TYPES).optional(),
          start_date: z.coerce.number().int().optional(),
          end_date: z.coerce.number().int().optional(),
        }),
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
      const { id } = request.params;
      const { cursor, limit, action_type, start_date, end_date } = request.query;

      // Build WHERE conditions
      const conditions: SQL[] = [eq(auditLog.agent_id, id)];

      if (cursor) {
        conditions.push(gt(auditLog.id, cursor));
      }

      if (action_type) {
        conditions.push(eq(auditLog.action, action_type));
      }

      if (start_date) {
        conditions.push(gte(auditLog.created_at, new Date(start_date)));
      }

      if (end_date) {
        conditions.push(lte(auditLog.created_at, new Date(end_date)));
      }

      const rows = app.db
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(asc(auditLog.id))
        .limit(limit + 1)
        .all();

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
