import { eq, gt, asc, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { agents, policies } from '../../db/schema.js';
import * as schema from '../../db/schema.js';

type DB = BetterSQLite3Database<typeof schema>;

export interface AgentWithPolicy {
  id: string;
  name: string;
  token_hash: string;
  metadata: Record<string, string> | null;
  created_at: Date;
  policy: {
    id: string;
    max_transaction_msat: number;
    daily_limit_msat: number;
    max_fee_msat: number | null;
    created_at: Date;
    updated_at: Date;
  } | null;
}

export interface ListResult {
  items: (typeof agents.$inferSelect)[];
  has_more: boolean;
}

export const agentsRepo = {
  /**
   * Insert a new agent record
   */
  create(
    db: DB,
    values: { id: string; name: string; token_hash: string; metadata?: Record<string, string> },
  ): typeof agents.$inferSelect {
    const rows = db
      .insert(agents)
      .values({
        id: values.id,
        name: values.name,
        token_hash: values.token_hash,
        metadata: values.metadata,
      })
      .returning()
      .all();
    return rows[0];
  },

  /**
   * Find agent by primary key — returns null if not found
   */
  findById(db: DB, id: string): (typeof agents.$inferSelect) | null {
    const row = db.select().from(agents).where(eq(agents.id, id)).get();
    return row ?? null;
  },

  /**
   * Find agent by stored token hash — returns null if not found
   */
  findByTokenHash(db: DB, tokenHash: string): (typeof agents.$inferSelect) | null {
    const row = db.select().from(agents).where(eq(agents.token_hash, tokenHash)).get();
    return row ?? null;
  },

  /**
   * Cursor-paginated list of agents ordered by ID (ULID = chronological)
   */
  list(db: DB, opts: { cursor?: string; limit: number }): ListResult {
    const { cursor, limit } = opts;

    const rows = cursor
      ? db
          .select()
          .from(agents)
          .where(gt(agents.id, cursor))
          .orderBy(asc(agents.id))
          .limit(limit + 1)
          .all()
      : db
          .select()
          .from(agents)
          .orderBy(asc(agents.id))
          .limit(limit + 1)
          .all();

    const has_more = rows.length > limit;
    const items = has_more ? rows.slice(0, limit) : rows;

    return { items, has_more };
  },

  /**
   * Get agent joined with its policy — returns null if agent not found
   */
  getWithPolicy(db: DB, id: string): AgentWithPolicy | null {
    const agent = db.select().from(agents).where(eq(agents.id, id)).get();
    if (!agent) return null;

    const policy = db.select().from(policies).where(eq(policies.agent_id, id)).get();

    return {
      ...agent,
      policy: policy
        ? {
            id: policy.id,
            max_transaction_msat: policy.max_transaction_msat,
            daily_limit_msat: policy.daily_limit_msat,
            max_fee_msat: policy.max_fee_msat ?? null,
            created_at: policy.created_at,
            updated_at: policy.updated_at,
          }
        : null,
    };
  },

  /**
   * Calculate total balance from ledger entries for an agent
   */
  getBalance(db: DB, agentId: string): number {
    const result = db
      .select({ total: sql<number>`COALESCE(SUM(amount_msat), 0)` })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.agent_id, agentId))
      .get();
    return result?.total ?? 0;
  },
};
