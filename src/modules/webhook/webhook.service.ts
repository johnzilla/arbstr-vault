import { createHmac } from 'crypto';
import { config } from '../../config.js';

export interface WebhookEvent {
  event: string;
  agent_id?: string;
  transaction_id?: string;
  amount_msat?: number;
  [key: string]: unknown;
}

async function deliverWithRetry(url: string, payload: string, sig: string): Promise<void> {
  const delays = [1000, 5000, 15000];
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ArbstrVault-Signature': sig },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
    } catch { /* network error — retry */ }
    if (attempt < 3) await new Promise(r => setTimeout(r, delays[attempt]));
  }
  throw new Error('webhook_delivery_failed');
}

export function createWebhookService(deps?: { auditInsert?: (entry: any) => void }) {
  return {
    async send(event: WebhookEvent, db?: any): Promise<void> {
      const url = config.OPERATOR_WEBHOOK_URL;
      if (!url) return;
      const payload = JSON.stringify({ ...event, timestamp: Date.now() });
      const sig = config.OPERATOR_WEBHOOK_SECRET
        ? createHmac('sha256', config.OPERATOR_WEBHOOK_SECRET).update(payload).digest('hex')
        : 'unsigned';
      try {
        await deliverWithRetry(url, payload, sig);
      } catch {
        // Log failure to audit if db provided
        if (db && deps?.auditInsert) {
          deps.auditInsert({ agent_id: event.agent_id ?? 'system',
            action: 'WEBHOOK_DELIVERY_FAILED', metadata: { event_type: event.event } });
        }
      }
    },
  };
}

// Default singleton (can be overridden in tests)
export const webhookService = createWebhookService();
