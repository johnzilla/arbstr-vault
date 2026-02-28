import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { adminAuth } from '../../middleware/adminAuth.js';
import { agentsRepo, policyVersionsRepo } from '../../modules/agents/agents.repo.js';
import { ledgerRepo } from '../../modules/ledger/ledger.repo.js';
import { auditRepo } from '../../modules/audit/audit.repo.js';
import { approvalsRepo } from '../../modules/approvals/approvals.repo.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';

type DB = BetterSQLite3Database<typeof schema>;
type Db = BetterSQLite3Database<Record<string, never>>;

const AgentSnapshotSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
  balance_msat: z.number(),
  daily_spend_msat: z.number(),
  daily_utilization_pct: z.number(),
  pending_approvals_count: z.number(),
  policy: z.object({
    version: z.number(),
    max_transaction_msat: z.number(),
    daily_limit_msat: z.number(),
    max_fee_msat: z.number().nullable(),
    approval_timeout_ms: z.number().nullable(),
    alert_floor_msat: z.number().nullable(),
    alert_cooldown_ms: z.number().nullable(),
  }).nullable(),
  last_payment_at: z.string().nullable(),
  balance_below_floor: z.boolean(),
  created_at: z.string(),
});

export const adminDashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply admin auth to all routes in this scope
  app.addHook('onRequest', adminAuth);

  // GET /operator/dashboard — per-agent financial state snapshot
  app.get(
    '/operator/dashboard',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['active', 'all']).default('active'),
          sort_by: z.enum(['balance', 'daily_spend', 'name']).default('name'),
          sort_order: z.enum(['asc', 'desc']).default('asc'),
        }),
        response: {
          200: z.object({
            agents: z.array(AgentSnapshotSchema),
            total_agents: z.number(),
            total_pending_approvals: z.number(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { sort_by, sort_order } = request.query;

      const db = app.db as unknown as DB;
      const narrowDb = app.db as unknown as Db;

      // 1. Load all agents (personal-use scale — no pagination needed)
      const { items: allAgents } = agentsRepo.list(db, { limit: 1000 });

      // 2. Aggregate per-agent data (N+1 queries are fine at personal-use scale per Research doc)
      const agentSnapshots = allAgents.map((agent) => {
        const balance = ledgerRepo.getBalance(narrowDb, agent.id);
        const dailySpend = ledgerRepo.getDailySpend(narrowDb, agent.id);
        const policy = policyVersionsRepo.getCurrent(db, agent.id);
        const pendingCount = approvalsRepo.countPending(narrowDb, agent.id);
        const lastPaymentAt = auditRepo.getLastPaymentTimestamp(narrowDb, agent.id);

        const dailyUtilizationPct = policy?.daily_limit_msat
          ? Math.round((dailySpend / policy.daily_limit_msat) * 100)
          : 0;

        const balanceBelowFloor = policy?.alert_floor_msat
          ? balance < policy.alert_floor_msat
          : false;

        return {
          agent_id: agent.id,
          name: agent.name,
          balance_msat: balance,
          daily_spend_msat: dailySpend,
          daily_utilization_pct: dailyUtilizationPct,
          pending_approvals_count: pendingCount,
          policy: policy
            ? {
                version: policy.version,
                max_transaction_msat: policy.max_transaction_msat,
                daily_limit_msat: policy.daily_limit_msat,
                max_fee_msat: policy.max_fee_msat ?? null,
                approval_timeout_ms: policy.approval_timeout_ms ?? null,
                alert_floor_msat: policy.alert_floor_msat ?? null,
                alert_cooldown_ms: policy.alert_cooldown_ms ?? null,
              }
            : null,
          last_payment_at: lastPaymentAt,
          balance_below_floor: balanceBelowFloor,
          created_at: agent.created_at.toISOString(),
        };
      });

      // 3. Sort by the requested field and order
      agentSnapshots.sort((a, b) => {
        let aVal: number | string;
        let bVal: number | string;

        if (sort_by === 'balance') {
          aVal = a.balance_msat;
          bVal = b.balance_msat;
        } else if (sort_by === 'daily_spend') {
          aVal = a.daily_spend_msat;
          bVal = b.daily_spend_msat;
        } else {
          // name
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
        }

        if (aVal < bVal) return sort_order === 'asc' ? -1 : 1;
        if (aVal > bVal) return sort_order === 'asc' ? 1 : -1;
        return 0;
      });

      // 4. Compute totals
      const totalPendingApprovals = agentSnapshots.reduce(
        (sum, snap) => sum + snap.pending_approvals_count,
        0,
      );

      return reply.send({
        agents: agentSnapshots,
        total_agents: agentSnapshots.length,
        total_pending_approvals: totalPendingApprovals,
      });
    },
  );
};
