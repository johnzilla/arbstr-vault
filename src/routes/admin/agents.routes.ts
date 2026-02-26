import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { adminAuth } from '../../middleware/adminAuth.js';
import { agentsService } from '../../modules/agents/agents.service.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';

type DB = BetterSQLite3Database<typeof schema>;

// Declare the db decorator on FastifyInstance (set in buildApp)
declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
  }
}

export const adminAgentRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply admin auth to all routes in this scope
  app.addHook('onRequest', adminAuth);

  // POST /agents — register a new agent
  app.post(
    '/agents',
    {
      schema: {
        body: z.object({
          name: z.string().min(1).max(100),
          metadata: z.record(z.string(), z.string()).optional(),
        }),
        response: {
          201: z.object({
            agent_id: z.string(),
            token: z.string(),
            created_at: z.date(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { name, metadata } = request.body;
      const result = agentsService.register(app.db, { name, metadata });
      return reply.status(201).send({
        agent_id: result.agent_id,
        token: result.raw_token,
        created_at: result.created_at,
      });
    },
  );

  // GET /agents — list agents with cursor pagination
  app.get(
    '/agents',
    {
      schema: {
        querystring: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: {
          200: z.object({
            agents: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                metadata: z.record(z.string(), z.string()).nullable(),
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
      const { cursor, limit } = request.query;
      const result = agentsService.list(app.db, { cursor, limit });
      return reply.send({
        agents: result.agents.map((a) => ({
          id: a.id,
          name: a.name,
          metadata: a.metadata ?? null,
          created_at: a.created_at,
        })),
        next_cursor: result.next_cursor,
        has_more: result.has_more,
      });
    },
  );

  // GET /agents/:id — get agent with policy
  app.get(
    '/agents/:id',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
        }),
        response: {
          200: z.object({
            agent_id: z.string(),
            name: z.string(),
            metadata: z.record(z.string(), z.string()).nullable(),
            policy: z.object({
              max_transaction_msat: z.number(),
              daily_limit_msat: z.number(),
            }),
            created_at: z.date(),
          }),
          404: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      try {
        const agent = agentsService.getById(app.db, request.params.id);
        return reply.send({
          agent_id: agent.id,
          name: agent.name,
          metadata: agent.metadata ?? null,
          policy: {
            max_transaction_msat: agent.policy?.max_transaction_msat ?? 0,
            daily_limit_msat: agent.policy?.daily_limit_msat ?? 0,
          },
          created_at: agent.created_at,
        });
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode === 404) {
          return reply.status(404).send({
            error: { code: 'not_found', message: 'Agent not found' },
          });
        }
        throw err;
      }
    },
  );

  // PUT /agents/:id/policy — update agent policy
  app.put(
    '/agents/:id/policy',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
        }),
        body: z.object({
          max_transaction_msat: z.number().int().nonnegative(),
          daily_limit_msat: z.number().int().nonnegative(),
        }),
        response: {
          200: z.object({
            agent_id: z.string(),
            policy: z.object({
              max_transaction_msat: z.number(),
              daily_limit_msat: z.number(),
              updated_at: z.date(),
            }),
          }),
          404: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      try {
        const updated = agentsService.updatePolicy(app.db, request.params.id, request.body);
        return reply.send({
          agent_id: request.params.id,
          policy: {
            max_transaction_msat: updated!.max_transaction_msat,
            daily_limit_msat: updated!.daily_limit_msat,
            updated_at: updated!.updated_at,
          },
        });
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode === 404) {
          return reply.status(404).send({
            error: { code: 'not_found', message: 'Agent not found' },
          });
        }
        throw err;
      }
    },
  );
};
