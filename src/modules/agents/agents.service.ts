import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { agentsRepo, policyVersionsRepo } from './agents.repo.js';
import { generateToken, hashToken } from '../tokens/tokens.service.js';
import { generateAgentId, generatePolicyId } from '../../types.js';
import { policies, auditLog, ledgerEntries } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type * as schema from '../../db/schema.js';
import { ulid } from 'ulidx';

type DB = BetterSQLite3Database<typeof schema>;

export interface RegisterResult {
  agent_id: string;
  raw_token: string;
  created_at: Date;
}

export interface ListResult {
  agents: (typeof schema.agents.$inferSelect)[];
  has_more: boolean;
  next_cursor: string | null;
}

export const agentsService = {
  /**
   * Register a new agent with default deny-all policy and audit log entry.
   * Returns the agent ID and raw token (raw token is only returned once).
   */
  register(db: DB, params: { name: string; metadata?: Record<string, string> }): RegisterResult {
    const agentId = generateAgentId();
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    // Insert agent
    const agent = agentsRepo.create(db, {
      id: agentId,
      name: params.name,
      token_hash: tokenHash,
      metadata: params.metadata,
    });

    // Insert default deny-all policy (legacy table — kept for backward compat)
    db.insert(policies)
      .values({
        id: generatePolicyId(),
        agent_id: agentId,
        max_transaction_msat: 0,
        daily_limit_msat: 0,
      })
      .run();

    // Insert version 1 policy into policy_versions (deny-all defaults)
    policyVersionsRepo.insertVersion(db, {
      agent_id: agentId,
      version: 1,
      effective_from: new Date(),
      max_transaction_msat: 0,
      daily_limit_msat: 0,
    });

    // Insert AGENT_REGISTERED audit log entry
    db.insert(auditLog)
      .values({
        id: ulid(),
        agent_id: agentId,
        action: 'AGENT_REGISTERED',
        metadata: { name: params.name },
      })
      .run();

    return {
      agent_id: agentId,
      raw_token: rawToken,
      created_at: agent.created_at,
    };
  },

  /**
   * Get agent with policy — throws 404-like error if not found
   */
  getById(db: DB, id: string) {
    const result = agentsRepo.getWithPolicy(db, id);
    if (!result) {
      const err = new Error('Agent not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return result;
  },

  /**
   * List agents with cursor pagination
   */
  list(db: DB, opts: { cursor?: string; limit: number }): ListResult {
    const result = agentsRepo.list(db, opts);
    const lastItem = result.items[result.items.length - 1];
    return {
      agents: result.items,
      has_more: result.has_more,
      next_cursor: result.has_more && lastItem ? lastItem.id : null,
    };
  },

  /**
   * Update policy for an agent — appends a new version to policy_versions (never mutates).
   * Returns the new version row.
   */
  updatePolicy(
    db: DB,
    agentId: string,
    policy: {
      max_transaction_msat: number;
      daily_limit_msat: number;
      max_fee_msat?: number;
      approval_timeout_ms?: number;
      alert_floor_msat?: number;
      alert_cooldown_ms?: number;
    },
  ) {
    // Verify agent exists
    const agent = agentsRepo.findById(db, agentId);
    if (!agent) {
      const err = new Error('Agent not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }

    // Get next version number
    const current = policyVersionsRepo.getCurrent(db, agentId);
    const nextVersion = (current?.version ?? 0) + 1;

    let newVersion: ReturnType<typeof policyVersionsRepo.insertVersion>;

    db.transaction((tx) => {
      const tdb = tx as unknown as DB;

      // Insert new policy_versions row (append-only — never update or delete)
      newVersion = policyVersionsRepo.insertVersion(tdb, {
        agent_id: agentId,
        version: nextVersion,
        effective_from: new Date(),
        max_transaction_msat: policy.max_transaction_msat,
        daily_limit_msat: policy.daily_limit_msat,
        max_fee_msat: policy.max_fee_msat,
        approval_timeout_ms: policy.approval_timeout_ms,
        alert_floor_msat: policy.alert_floor_msat,
        alert_cooldown_ms: policy.alert_cooldown_ms,
      });

      // Insert POLICY_UPDATED audit log entry
      db.insert(auditLog)
        .values({
          id: ulid(),
          agent_id: agentId,
          action: 'POLICY_UPDATED',
          metadata: {
            version: nextVersion,
            max_transaction_msat: String(policy.max_transaction_msat),
            daily_limit_msat: String(policy.daily_limit_msat),
            ...(policy.max_fee_msat !== undefined && { max_fee_msat: String(policy.max_fee_msat) }),
            ...(policy.approval_timeout_ms !== undefined && { approval_timeout_ms: String(policy.approval_timeout_ms) }),
            ...(policy.alert_floor_msat !== undefined && { alert_floor_msat: String(policy.alert_floor_msat) }),
            ...(policy.alert_cooldown_ms !== undefined && { alert_cooldown_ms: String(policy.alert_cooldown_ms) }),
          },
        })
        .run();
    }, { behavior: 'immediate' });

    return newVersion!;
  },
};
