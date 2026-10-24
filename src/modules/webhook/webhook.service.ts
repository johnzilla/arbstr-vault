import { createHmac } from 'crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { config } from '../../config.js';
import { auditRepo, type AuditEntry } from '../audit/audit.repo.js';

type Db = BetterSQLite3Database<Record<string, never>>;

export interface WebhookEvent {
  event: string;
  agent_id?: string;
  transaction_id?: string;
  amount_msat?: number;
  [key: string]: unknown;
}

export interface WebhookServiceDeps {
  auditInsert?: (db: Db, entry: AuditEntry) => void;
  /** Delay before each retry; one retry per entry. */
  retryDelaysMs?: number[];
  /** Override OPERATOR_WEBHOOK_URL / OPERATOR_WEBHOOK_SECRET (tests). */
  url?: string;
  secret?: string;
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 15000];

/** Returns the number of attempts made and the last failure, or null on success. */
async function deliverWithRetry(
  url: string,
  payload: string,
  sig: string,
  delays: number[],
): Promise<{ attempts: number; error: string } | null> {
  let error = '';
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ArbstrVault-Signature': sig },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return null;
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.name === 'TimeoutError' ? 'timeout' : err.message : String(err);
    }
    if (attempt < delays.length) await new Promise(r => setTimeout(r, delays[attempt]));
  }
  return { attempts: delays.length + 1, error };
}

export function createWebhookService(deps: WebhookServiceDeps = {}) {
  const auditInsert = deps.auditInsert ?? auditRepo.insert;
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  return {
    /**
     * Deliver an event to the operator webhook, retrying on failure.
     * A delivery that fails every attempt is audited as WEBHOOK_DELIVERY_FAILED.
     */
    async send(event: WebhookEvent, db: Db): Promise<void> {
      const url = deps.url ?? config.OPERATOR_WEBHOOK_URL;
      if (!url) return;
      const secret = deps.secret ?? config.OPERATOR_WEBHOOK_SECRET;
      const payload = JSON.stringify({ ...event, timestamp: Date.now() });
      const sig = secret
        ? createHmac('sha256', secret).update(payload).digest('hex')
        : 'unsigned';

      const failure = await deliverWithRetry(url, payload, sig, delays);
      if (!failure) return;

      try {
        auditInsert(db, {
          agent_id: event.agent_id ?? 'system',
          action: 'WEBHOOK_DELIVERY_FAILED',
          amount_msat: event.amount_msat,
          ref_id: event.transaction_id,
          metadata: { event_type: event.event, attempts: failure.attempts, last_error: failure.error },
        });
      } catch (err) {
        // The DB may be gone if the server shut down during retries
        console.error('[webhookService] failed to audit webhook delivery failure', { event: event.event, err });
      }
    },
  };
}

// Default singleton (can be overridden in tests)
export const webhookService = createWebhookService();
