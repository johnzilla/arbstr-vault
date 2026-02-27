import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { agentAuth } from '../../middleware/agentAuth.js';
import { ledgerEntries, auditLog } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';

type DB = BetterSQLite3Database<typeof schema>;

/**
 * Determine payment status for a given transaction by querying ledger entries and audit log.
 *
 * Status derivation logic:
 * - If audit_log has PAYMENT_SETTLED action for ref_id -> SETTLED
 * - If audit_log has PAYMENT_FAILED action for ref_id -> FAILED
 * - If only PAYMENT_REQUEST in audit_log -> PENDING
 * - Fallback: derive from ledger entry types (RELEASE -> FAILED, PAYMENT -> SETTLED, RESERVE only -> PENDING)
 */
function determinePaymentStatus(
  entries: Array<{ entry_type: string }>,
  auditActions: string[],
): 'SETTLED' | 'PENDING' | 'FAILED' {
  // Prefer audit log for authoritative status
  if (auditActions.includes('PAYMENT_SETTLED')) return 'SETTLED';
  if (auditActions.includes('PAYMENT_FAILED')) return 'FAILED';

  // Fallback: derive from ledger entry types
  const entryTypes = new Set(entries.map((e) => e.entry_type));
  if (entryTypes.has('RELEASE')) return 'FAILED';
  if (entryTypes.has('PAYMENT')) return 'SETTLED'; // simulated PAYMENT = settled
  if (entryTypes.has('RESERVE')) return 'PENDING';

  return 'PENDING';
}

export const agentPaymentStatusRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Apply agent auth to all routes in this scope
  app.addHook('onRequest', agentAuth);

  // GET /agents/:id/payments/:tx_id — poll payment status
  // PAY-06: Agent can see PENDING/SETTLED/FAILED with payment_hash and fee_msat
  app.get(
    '/agents/:id/payments/:tx_id',
    {
      schema: {
        params: z.object({
          id: z.string().startsWith('ag_'),
          tx_id: z.string().startsWith('tx_'),
        }),
        response: {
          200: z.object({
            transaction_id: z.string(),
            payment_hash: z.string().optional(),
            status: z.enum(['PENDING', 'SETTLED', 'FAILED']),
            mode: z.string(),
            amount_msat: z.number(),
            fee_msat: z.number().optional(),
            created_at: z.string(),
            settled_at: z.string().optional(),
          }),
          404: z.object({
            error: z.object({
              code: z.string(),
              message: z.string(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id, tx_id } = request.params;
      const db = app.db as unknown as DB;

      // Query all ledger entries for this transaction (ref_id = tx_id, agent_id = id)
      // Also include the initiating entry if id = tx_id (for RESERVE entries where id=txId)
      const entries = db
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.agent_id, id),
            eq(ledgerEntries.ref_id, tx_id),
          ),
        )
        .all();

      // Also check for the primary entry where id = tx_id (simulated PAYMENT entries use id=txId)
      const primaryEntry = db
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.agent_id, id),
            eq(ledgerEntries.id, tx_id),
          ),
        )
        .get();

      // Merge entries — primaryEntry if found and not already in list
      const allEntries = [...entries];
      if (primaryEntry && !allEntries.find((e) => e.id === primaryEntry.id)) {
        allEntries.push(primaryEntry);
      }

      if (allEntries.length === 0) {
        return reply.status(404).send({
          error: { code: 'not_found', message: `Payment ${tx_id} not found` },
        });
      }

      // Query audit log for settlement status
      // Narrow DB type for audit queries
      type NarrowDb = BetterSQLite3Database<Record<string, never>>;
      const auditEntries = (db as unknown as NarrowDb)
        .select({ action: auditLog.action, created_at: auditLog.created_at })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.agent_id, id),
            eq(auditLog.ref_id, tx_id),
          ),
        )
        .all();

      const auditActions = auditEntries.map((e) => e.action as string);

      // Determine status using audit log (authoritative) + ledger entry types (fallback)
      const status = determinePaymentStatus(allEntries, auditActions);

      // Get the primary initiating entry for amount/hash/mode/timestamps
      // RESERVE or PAYMENT entries (whichever is the original, identified by id=txId)
      const initiatingEntry = allEntries.find((e) => e.id === tx_id) ?? allEntries[0];

      // Extract payment_hash from the initiating RESERVE/PAYMENT entry
      const paymentHash = initiatingEntry.payment_hash ?? undefined;

      // Fee debit is a separate PAYMENT entry (for lightning) — find it
      const feeEntry = allEntries.find(
        (e) => e.entry_type === 'PAYMENT' && e.id !== tx_id,
      );
      const feeMsat = feeEntry ? Math.abs(feeEntry.amount_msat) : undefined;

      // settled_at — from PAYMENT_SETTLED audit entry timestamp
      const settledAudit = auditEntries.find((e) => (e.action as string) === 'PAYMENT_SETTLED');
      const settledAt = settledAudit?.created_at
        ? settledAudit.created_at.toISOString()
        : undefined;

      // Amount from initiating entry (stored as negative for debits)
      const amountMsat = Math.abs(initiatingEntry.amount_msat);

      return reply.send({
        transaction_id: tx_id,
        payment_hash: paymentHash,
        status,
        mode: initiatingEntry.mode ?? 'simulated',
        amount_msat: amountMsat,
        fee_msat: feeMsat,
        created_at: initiatingEntry.created_at.toISOString(),
        settled_at: settledAt,
      });
    },
  );
};
