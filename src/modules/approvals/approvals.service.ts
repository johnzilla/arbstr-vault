import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { approvalsRepo } from './approvals.repo.js';
import { ledgerRepo } from '../ledger/ledger.repo.js';
import { auditRepo } from '../audit/audit.repo.js';
import { webhookService } from '../webhook/webhook.service.js';

type Db = BetterSQLite3Database<Record<string, never>>;

export interface CreateApprovalParams {
  agentId: string;
  type: 'payment' | 'withdrawal';
  txId: string;
  amountMsat: number;
  destination?: string | null;
  expiresAt: Date;
}

export const approvalsService = {
  /**
   * Create an approval request.
   *
   * Atomically (in a single IMMEDIATE transaction):
   * 1. Write RESERVE ledger entry (-amountMsat)
   * 2. Insert pending_approvals row
   * 3. Write APPROVAL_REQUESTED audit entry
   *
   * After commit, fires a non-blocking webhook (approval_required event).
   * Returns the created approval row.
   *
   * CRITICAL: RESERVE and pending_approvals MUST be in the SAME transaction.
   * A crash between them would leave balance reserved with no approval record.
   */
  createApproval(db: Db, params: CreateApprovalParams) {
    const { agentId, type, txId, amountMsat, destination, expiresAt } = params;

    let approvalRow: ReturnType<typeof approvalsRepo.create>;

    db.transaction((tdb) => {
      const narrowDb = tdb as unknown as Db;

      // 1. Write RESERVE ledger entry
      ledgerRepo.insert(narrowDb, {
        id: txId,
        agent_id: agentId,
        amount_msat: -amountMsat,
        entry_type: 'RESERVE',
        ref_id: txId,
        mode: 'simulated',
      });

      // 2. Insert pending_approvals row
      approvalRow = approvalsRepo.create(narrowDb, {
        agent_id: agentId,
        type,
        transaction_id: txId,
        amount_msat: amountMsat,
        destination: destination ?? null,
        expires_at: expiresAt,
      });

      // 3. Write APPROVAL_REQUESTED audit entry
      auditRepo.insert(narrowDb, {
        agent_id: agentId,
        action: 'APPROVAL_REQUESTED',
        policy_decision: 'REQUIRE_HUMAN_APPROVAL',
        amount_msat: amountMsat,
        ref_id: txId,
        metadata: {
          approval_id: approvalRow!.id,
          expires_at: expiresAt.toISOString(),
        },
      });
    }, { behavior: 'immediate' });

    // Fire webhook after transaction commits — non-blocking
    webhookService.send({
      event: 'approval_required',
      agent_id: agentId,
      transaction_id: txId,
      amount_msat: amountMsat,
    }).catch(() => {});

    return approvalRow!;
  },

  /**
   * Resolve an approval (approve or deny) using CAS to prevent races.
   *
   * Returns the resolved approval row with payment_status, or null if already resolved (409 case).
   *
   * For 'denied':
   *   - Atomically write RELEASE (+amountMsat) + APPROVAL_DENIED audit
   *   - Fire approval_denied webhook (non-blocking)
   *   - Return { ...claimed, payment_status: 'FAILED' }
   *
   * For 'approved':
   *   - Atomically write APPROVAL_GRANTED audit
   *   - Return { ...claimed, payment_status: 'APPROVED' }
   *   - Note: Actual wallet payment execution is handled by the approve route handler
   */
  resolveApproval(db: Db, approvalId: string, resolution: 'approved' | 'denied') {
    // CAS claim — returns undefined if already resolved
    const claimed = approvalsRepo.claimForResolution(db, approvalId, resolution);
    if (!claimed) return null;

    if (resolution === 'denied') {
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
          metadata: { approval_id: approvalId },
        });
      }, { behavior: 'immediate' });

      // Fire webhook non-blocking
      webhookService.send({
        event: 'approval_denied',
        agent_id: claimed.agent_id,
        transaction_id: claimed.transaction_id,
        amount_msat: claimed.amount_msat,
      }).catch(() => {});

      return { ...claimed, payment_status: 'FAILED' as const };
    }

    if (resolution === 'approved') {
      db.transaction((tdb) => {
        const narrowDb = tdb as unknown as Db;

        // Write APPROVAL_GRANTED audit entry
        auditRepo.insert(narrowDb, {
          agent_id: claimed.agent_id,
          action: 'APPROVAL_GRANTED',
          amount_msat: claimed.amount_msat,
          ref_id: claimed.transaction_id,
          metadata: { approval_id: approvalId },
        });
      }, { behavior: 'immediate' });

      return { ...claimed, payment_status: 'APPROVED' as const };
    }

    return null;
  },

  /**
   * Expire timed-out pending approvals.
   * Called by setInterval in index.ts — polls for expired entries and auto-denies them.
   *
   * For each expired approval:
   * 1. CAS claim as 'timed_out' (prevents race with manual resolution)
   * 2. If claimed: write RELEASE + APPROVAL_TIMEOUT audit
   * 3. Fire approval_timeout webhook (non-blocking)
   */
  expireTimedOut(db: Db) {
    const expired = approvalsRepo.findExpired(db);

    for (const approval of expired) {
      const claimed = approvalsRepo.claimForResolution(db, approval.id, 'timed_out');
      if (!claimed) continue; // Already resolved by concurrent request

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

        // Write APPROVAL_TIMEOUT audit entry
        auditRepo.insert(narrowDb, {
          agent_id: claimed.agent_id,
          action: 'APPROVAL_TIMEOUT',
          amount_msat: claimed.amount_msat,
          ref_id: claimed.transaction_id,
          metadata: { approval_id: approval.id },
        });
      }, { behavior: 'immediate' });

      // Fire webhook non-blocking
      webhookService.send({
        event: 'approval_timeout',
        agent_id: claimed.agent_id,
        transaction_id: claimed.transaction_id,
        amount_msat: claimed.amount_msat,
      }).catch(() => {});
    }
  },
};
