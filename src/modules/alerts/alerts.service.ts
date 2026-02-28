import { webhookService } from '../webhook/webhook.service.js';
import { policyVersionsRepo } from '../agents/agents.repo.js';
import { ledgerRepo } from '../ledger/ledger.repo.js';
import { auditRepo } from '../audit/audit.repo.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type Db = BetterSQLite3Database<Record<string, never>>;

// In-memory cooldown tracker: agentId -> last alert timestamp (milliseconds since epoch)
const lastAlertTime = new Map<string, number>();

export const alertsService = {
  /**
   * Check if an agent's balance has dropped below their configured alert_floor_msat.
   * If below floor and cooldown has elapsed, fire a balance_alert webhook.
   *
   * MUST only be called after a payment SETTLES (not after RESERVE).
   * Research Pitfall 4: firing alert after RESERVE produces spurious alerts for payments that fail.
   *
   * This is fire-and-forget — callers use .catch(() => {}) and must not await.
   */
  async checkAndNotify(db: Db, agentId: string): Promise<void> {
    // policyVersionsRepo.getCurrent expects a full-schema DB, but at runtime SQLite
    // doesn't enforce the schema type — casting is safe here.
    const policy = policyVersionsRepo.getCurrent(db as any, agentId);
    if (!policy?.alert_floor_msat || policy.alert_floor_msat <= 0) return;

    const balance = ledgerRepo.getBalance(db, agentId);
    if (balance >= policy.alert_floor_msat) return;

    // Check cooldown — default 1 hour (3_600_000 ms)
    const cooldownMs = policy.alert_cooldown_ms ?? 3_600_000;
    const lastAlert = lastAlertTime.get(agentId) ?? 0;
    if (Date.now() - lastAlert < cooldownMs) return;

    // Record alert time BEFORE firing — prevents rapid duplicate alerts
    // even if the webhook or audit write is slow
    lastAlertTime.set(agentId, Date.now());

    // Write BALANCE_ALERT audit entry
    auditRepo.insert(db, {
      agent_id: agentId,
      action: 'BALANCE_ALERT',
      metadata: {
        balance_msat: balance,
        alert_floor_msat: policy.alert_floor_msat,
      },
    });

    // Fire webhook — non-blocking
    webhookService.send({
      event: 'balance_alert',
      agent_id: agentId,
      balance_msat: balance,
      alert_floor_msat: policy.alert_floor_msat,
    }).catch(() => {});
  },

  /** Reset cooldown tracker — for testing only */
  _resetCooldowns(): void {
    lastAlertTime.clear();
  },
};
