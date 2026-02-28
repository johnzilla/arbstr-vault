import { eq, gt, asc, sql, desc, lte, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { agents, policies, policyVersions } from '../../db/schema.js';
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
    version?: number;
    max_transaction_msat: number;
    daily_limit_msat: number;
    max_fee_msat: number | null;
    approval_timeout_ms?: number;
    alert_floor_msat?: number;
    alert_cooldown_ms?: number;
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
   * Get agent joined with its policy — returns null if agent not found.
   * Prefers policy_versions (newest version), falls back to legacy policies table.
   */
  getWithPolicy(db: DB, id: string): AgentWithPolicy | null {
    const agent = db.select().from(agents).where(eq(agents.id, id)).get();
    if (!agent) return null;

    // Try policy_versions first (newest version)
    const policyVersion = db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.agent_id, id))
      .orderBy(desc(policyVersions.version))
      .limit(1)
      .get();

    if (policyVersion) {
      return {
        ...agent,
        policy: {
          id: policyVersion.id,
          version: policyVersion.version,
          max_transaction_msat: policyVersion.max_transaction_msat,
          daily_limit_msat: policyVersion.daily_limit_msat,
          max_fee_msat: policyVersion.max_fee_msat ?? null,
          approval_timeout_ms: policyVersion.approval_timeout_ms ?? undefined,
          alert_floor_msat: policyVersion.alert_floor_msat ?? undefined,
          alert_cooldown_ms: policyVersion.alert_cooldown_ms ?? undefined,
          created_at: policyVersion.created_at,
          updated_at: policyVersion.created_at,
        },
      };
    }

    // Fall back to legacy policies table
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

/**
 * Repository for append-only policy versioning.
 * Supports point-in-time lookups (PLCY-09) and version history (PLCY-08).
 */
export const policyVersionsRepo = {
  /**
   * Get the latest policy version for an agent (highest version number).
   * Returns null if no versions exist.
   */
  getCurrent(db: DB, agentId: string): (typeof policyVersions.$inferSelect) | null {
    return db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.agent_id, agentId))
      .orderBy(desc(policyVersions.version))
      .limit(1)
      .get() ?? null;
  },

  /**
   * Point-in-time policy version lookup (PLCY-09).
   * Returns the version whose effective_from <= timestamp, ordered by most recent.
   * Returns null if no version was effective at that timestamp.
   */
  getVersionAt(db: DB, agentId: string, timestamp: number): (typeof policyVersions.$inferSelect) | null {
    return db
      .select()
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.agent_id, agentId),
          lte(policyVersions.effective_from, new Date(timestamp)),
        ),
      )
      .orderBy(desc(policyVersions.effective_from))
      .limit(1)
      .get() ?? null;
  },

  /**
   * Insert a new policy version row. Returns the inserted row.
   */
  insertVersion(
    db: DB,
    values: {
      agent_id: string;
      version: number;
      effective_from: Date;
      max_transaction_msat: number;
      daily_limit_msat: number;
      max_fee_msat?: number;
      approval_timeout_ms?: number;
      alert_floor_msat?: number;
      alert_cooldown_ms?: number;
    },
  ): typeof policyVersions.$inferSelect {
    const rows = db
      .insert(policyVersions)
      .values({
        agent_id: values.agent_id,
        version: values.version,
        effective_from: values.effective_from,
        max_transaction_msat: values.max_transaction_msat,
        daily_limit_msat: values.daily_limit_msat,
        max_fee_msat: values.max_fee_msat,
        approval_timeout_ms: values.approval_timeout_ms,
        alert_floor_msat: values.alert_floor_msat,
        alert_cooldown_ms: values.alert_cooldown_ms,
      })
      .returning()
      .all();
    return rows[0];
  },

  /**
   * Count policy versions for an agent. Used to determine next version number.
   */
  countByAgent(db: DB, agentId: string): number {
    const result = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(policyVersions)
      .where(eq(policyVersions.agent_id, agentId))
      .get();
    return result?.count ?? 0;
  },
};
